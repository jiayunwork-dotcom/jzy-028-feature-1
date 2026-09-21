import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { CfarExceptionFilter } from '../../src/cfar/cfar.exception-filter';
import { CfarSessionService } from '../../src/cfar/session.service';

const GEO = { guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('持续检测会话 HTTP (e2e)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new CfarExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function openSession(body: object = GEO): Promise<string> {
    const res = await request(app.getHttpServer()).post('/sessions').send(body).expect(201);
    return res.body.sessionId as string;
  }

  describe('POST /sessions —— 开会话', () => {
    test('内联几何：201，返回 sessionId 与本会话 α/N', async () => {
      const res = await request(app.getHttpServer()).post('/sessions').send(GEO).expect(201);
      expect(typeof res.body.sessionId).toBe('string');
      expect(res.body.n).toBe(4);
      expect(res.body.alpha).toBeGreaterThan(0);
      expect(res.body.received).toBe(0);
      expect(res.body.retainedAmplitudes).toBe(0);
    });

    test('具名窗规：201；未登记窗规：404', async () => {
      const res = await request(app.getHttpServer())
        .post('/sessions')
        .send({ profileName: 'standard' })
        .expect(201);
      expect(res.body.geometry).toEqual({ guardCells: 2, referenceCellsPerSide: 8, pfa: 1e-3 });
      await request(app.getHttpServer())
        .post('/sessions')
        .send({ profileName: 'ghost' })
        .expect(404);
    });

    test('非法几何 / 缺几何 / 两边都给：400', async () => {
      await request(app.getHttpServer())
        .post('/sessions')
        .send({ guardCells: 0, referenceCellsPerSide: 0, pfa: 0.5 })
        .expect(400);
      await request(app.getHttpServer())
        .post('/sessions')
        .send({ guardCells: 1, referenceCellsPerSide: 2, pfa: 1 })
        .expect(400);
      await request(app.getHttpServer()).post('/sessions').send({}).expect(400);
      await request(app.getHttpServer())
        .post('/sessions')
        .send({ profileName: 'standard', ...GEO })
        .expect(400);
    });
  });

  describe('分批追加 ≡ 一次性整条送入 /detect', () => {
    test('随机批次切分同一条线：全部单元阈值/检出/无效与单趟完全一致', async () => {
      const rand = mulberry32(20260921);
      const length = 120;
      const amps: number[] = [];
      for (let i = 0; i < length; i++) {
        amps.push(-Math.log(1 - rand()));
      }
      amps[40] = 30; // 强目标
      amps[80] = 6; // 临界目标

      // 单趟基准
      const oneShot = (
        await request(app.getHttpServer()).post('/detect').send({ amplitudes: amps, ...GEO }).expect(200)
      ).body;

      // 会话 + 随机批次（1..9 点/批）
      const sessionId = await openSession();
      const thresholds: (number | null)[] = new Array(length).fill(null);
      const detections: boolean[] = new Array(length).fill(false);
      const invalid: boolean[] = new Array(length).fill(true);
      let cursor = 0;
      while (cursor < length) {
        const size = 1 + Math.floor(rand() * 9);
        const batch = amps.slice(cursor, cursor + size);
        const res = await request(app.getHttpServer())
          .post(`/sessions/${sessionId}/append`)
          .send({ amplitudes: batch })
          .expect(200);
        // 响应只含本批影响的单元，绝不整条重扫
        expect(res.body.finalized.length).toBeLessThanOrEqual(batch.length);
        expect(res.body.received).toBe(Math.min(cursor + size, length));
        for (const cell of res.body.finalized) {
          thresholds[cell.index] = cell.threshold;
          detections[cell.index] = cell.detection;
          invalid[cell.index] = cell.invalid;
        }
        cursor += size;
      }
      expect(thresholds).toEqual(oneShot.thresholds);
      expect(detections).toEqual(oneShot.detections);
      expect(invalid).toEqual(oneShot.invalid);
    });

    test('整条一次追加进会话 ≡ /detect', async () => {
      const amps = [0.2, 0.5, 0.4, 0.3, 50, 0.4, 0.5, 0.3, 0.2, 0.6, 0.4, 0.3];
      const oneShot = (
        await request(app.getHttpServer()).post('/detect').send({ amplitudes: amps, ...GEO }).expect(200)
      ).body;
      const sessionId = await openSession();
      const res = await request(app.getHttpServer())
        .post(`/sessions/${sessionId}/append`)
        .send({ amplitudes: amps })
        .expect(200);
      const thresholds = res.body.finalized.map((c: { threshold: number | null }) => c.threshold);
      // 落定的前缀部分与单趟一致；尾部 span 个仍待定（无效），也与单趟一致
      expect(thresholds).toEqual(oneShot.thresholds.slice(0, res.body.finalized.length));
      expect(res.body.pending).toHaveLength(3); // span = guard+ref = 3
      for (const cell of res.body.pending) {
        expect(cell.invalid).toBe(true);
        expect(cell.threshold).toBeNull();
        expect(cell.final).toBe(false);
      }
    });
  });

  describe('边界状态反悔：追溯重判且只重判一个单元', () => {
    test('逐点追加：每批落定恰好一个单元；待定单元窗口补齐后被重判并冻结', async () => {
      const sessionId = await openSession();
      const amps = [0.4, 0.5, 0.3, 0.6, 0.4, 0.5, 50, 0.4, 0.6, 0.3, 0.5, 0.4];
      const oneShot = (
        await request(app.getHttpServer()).post('/detect').send({ amplitudes: amps, ...GEO }).expect(200)
      ).body;

      const finalizedPerAppend: { index: number }[][] = [];
      for (const a of amps) {
        const res = await request(app.getHttpServer())
          .post(`/sessions/${sessionId}/append`)
          .send({ amplitudes: [a] })
          .expect(200);
        finalizedPerAppend.push(res.body.finalized);
      }
      // 前 3 批无人可落定；之后每批恰好落定一个（右窗刚补齐的那个）
      for (let i = 0; i < amps.length; i++) {
        if (i < 3) {
          expect(finalizedPerAppend[i]).toHaveLength(0);
        } else {
          expect(finalizedPerAppend[i]).toHaveLength(1);
          expect(finalizedPerAppend[i][0].index).toBe(i - 3);
        }
      }

      // cut=6（强目标）的完整生命周期：先无效待定 → 追溯重判 → 冻结
      // （上面 12 批已全部追加完，用查询接口回看；另起一个会话逐步验证中间态）
      const session2 = await openSession();
      for (let i = 0; i <= 6; i++) {
        await request(app.getHttpServer())
          .post(`/sessions/${session2}/append`)
          .send({ amplitudes: [amps[i]] })
          .expect(200);
      }
      const pending6 = (
        await request(app.getHttpServer()).get(`/sessions/${session2}/cells/6`).expect(200)
      ).body;
      expect(pending6).toMatchObject({ invalid: true, threshold: null, detection: false, final: false, revision: 1 });

      // 补 3 个点，cut=6 的右窗到齐
      for (let i = 7; i <= 9; i++) {
        await request(app.getHttpServer())
          .post(`/sessions/${session2}/append`)
          .send({ amplitudes: [amps[i]] })
          .expect(200);
      }
      const settled6 = (
        await request(app.getHttpServer()).get(`/sessions/${session2}/cells/6`).expect(200)
      ).body;
      expect(settled6).toMatchObject({ final: true, invalid: false, detection: true, revision: 2 });
      expect(settled6.threshold).toBe(oneShot.thresholds[6]);

      // 落定之后继续追加（含大幅值），cut=6 的判决一个字节都不许变
      await request(app.getHttpServer())
        .post(`/sessions/${session2}/append`)
        .send({ amplitudes: [1000, 0.1, 999, 0.2, 0.3, 0.4, 0.5, 0.6] })
        .expect(200);
      const after = (
        await request(app.getHttpServer()).get(`/sessions/${session2}/cells/6`).expect(200)
      ).body;
      expect(after).toEqual(settled6);
    });
  });

  describe('保留历史量有界', () => {
    test('追加 300 批后保留的原始幅度仍只与窗几何相关', async () => {
      const sessionId = await openSession({ guardCells: 2, referenceCellsPerSide: 8, pfa: 1e-3 });
      let lastRetained = 0;
      for (let batch = 0; batch < 300; batch++) {
        const res = await request(app.getHttpServer())
          .post(`/sessions/${sessionId}/append`)
          .send({ amplitudes: [0.5, 0.6, 0.4] })
          .expect(200);
        lastRetained = res.body.retainedAmplitudes;
        expect(lastRetained).toBeLessThanOrEqual(2 * (2 + 8));
      }
      const status = (
        await request(app.getHttpServer()).get(`/sessions/${sessionId}`).expect(200)
      ).body;
      expect(status.received).toBe(900);
      expect(status.retainedAmplitudes).toBe(20); // 2×(guard+ref)，与 900 个已接收点无关
      expect(lastRetained).toBe(20);
    });
  });

  describe('多会话并发互不干扰', () => {
    test('两个会话交错追加，各自结果与各自单趟一致', async () => {
      const geoA = { guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 };
      const geoB = { guardCells: 2, referenceCellsPerSide: 4, pfa: 1e-2 };
      const lineA = [1, 0.5, 2, 0.5, 1, 30, 1, 0.5, 2, 0.5, 1, 0.5, 2, 1];
      const lineB = new Array(30).fill(0.5);
      lineB[15] = 20;

      const a = await openSession(geoA);
      const b = await openSession(geoB);
      // 交错追加
      await request(app.getHttpServer()).post(`/sessions/${a}/append`).send({ amplitudes: lineA.slice(0, 5) }).expect(200);
      await request(app.getHttpServer()).post(`/sessions/${b}/append`).send({ amplitudes: lineB.slice(0, 20) }).expect(200);
      await request(app.getHttpServer()).post(`/sessions/${a}/append`).send({ amplitudes: lineA.slice(5) }).expect(200);
      await request(app.getHttpServer()).post(`/sessions/${b}/append`).send({ amplitudes: lineB.slice(20) }).expect(200);

      const oneShotA = (
        await request(app.getHttpServer()).post('/detect').send({ amplitudes: lineA, ...geoA }).expect(200)
      ).body;
      const oneShotB = (
        await request(app.getHttpServer()).post('/detect').send({ amplitudes: lineB, ...geoB }).expect(200)
      ).body;

      for (let i = 0; i < lineA.length; i++) {
        const cell = (await request(app.getHttpServer()).get(`/sessions/${a}/cells/${i}`).expect(200)).body;
        expect(cell.threshold).toBe(oneShotA.thresholds[i]);
        expect(cell.detection).toBe(oneShotA.detections[i]);
        expect(cell.invalid).toBe(oneShotA.invalid[i]);
      }
      for (let i = 0; i < lineB.length; i++) {
        const cell = (await request(app.getHttpServer()).get(`/sessions/${b}/cells/${i}`).expect(200)).body;
        expect(cell.threshold).toBe(oneShotB.thresholds[i]);
        expect(cell.detection).toBe(oneShotB.detections[i]);
        expect(cell.invalid).toBe(oneShotB.invalid[i]);
      }
      // 各自的保留历史只随自己的几何
      expect((await request(app.getHttpServer()).get(`/sessions/${a}`).expect(200)).body.retainedAmplitudes).toBe(6);
      expect((await request(app.getHttpServer()).get(`/sessions/${b}`).expect(200)).body.retainedAmplitudes).toBe(12);
    });
  });

  describe('关闭与过期', () => {
    test('关闭后追加/查询/再关闭一律 410；不存在的会话一律 404', async () => {
      const sessionId = await openSession();
      await request(app.getHttpServer())
        .post(`/sessions/${sessionId}/append`)
        .send({ amplitudes: [0.1, 0.2, 0.3, 0.4, 0.5] })
        .expect(200);
      await request(app.getHttpServer()).delete(`/sessions/${sessionId}`).expect(200);

      await request(app.getHttpServer())
        .post(`/sessions/${sessionId}/append`)
        .send({ amplitudes: [0.6] })
        .expect(410);
      await request(app.getHttpServer()).get(`/sessions/${sessionId}`).expect(410);
      await request(app.getHttpServer()).get(`/sessions/${sessionId}/cells/0`).expect(410);
      await request(app.getHttpServer()).delete(`/sessions/${sessionId}`).expect(410);

      await request(app.getHttpServer())
        .post('/sessions/does-not-exist/append')
        .send({ amplitudes: [1] })
        .expect(404);
      await request(app.getHttpServer()).get('/sessions/does-not-exist').expect(404);
      await request(app.getHttpServer()).delete('/sessions/does-not-exist').expect(404);
    });

    test('闲置过期的会话被回收，追加按 410 拒绝', async () => {
      const svc = moduleRef.get(CfarSessionService);
      const realNow = svc.now;
      const realTtl = svc.ttlMs;
      try {
        let clock = Date.now();
        svc.now = () => clock;
        svc.ttlMs = 1_000;

        const sessionId = await openSession();
        await request(app.getHttpServer())
          .post(`/sessions/${sessionId}/append`)
          .send({ amplitudes: [0.1, 0.2] })
          .expect(200);

        clock += 60_000; // 一分钟没追加 → 闲置过期
        svc.sweepExpired();

        const res = await request(app.getHttpServer())
          .post(`/sessions/${sessionId}/append`)
          .send({ amplitudes: [0.3] })
          .expect(410);
        expect(res.body.message).toMatch(/expired/);
      } finally {
        svc.now = realNow;
        svc.ttlMs = realTtl;
      }
    });

    test('追加非法幅度：400；查询未到达单元：404；非法下标：400', async () => {
      const sessionId = await openSession();
      await request(app.getHttpServer())
        .post(`/sessions/${sessionId}/append`)
        .send({ amplitudes: [0.1, -2] })
        .expect(400);
      await request(app.getHttpServer())
        .post(`/sessions/${sessionId}/append`)
        .send({})
        .expect(400);
      await request(app.getHttpServer())
        .post(`/sessions/${sessionId}/append`)
        .send({ amplitudes: [0.1, 0.2] })
        .expect(200);
      await request(app.getHttpServer()).get(`/sessions/${sessionId}/cells/5`).expect(404);
      await request(app.getHttpServer()).get(`/sessions/${sessionId}/cells/-1`).expect(400);
      await request(app.getHttpServer()).get(`/sessions/${sessionId}/cells/abc`).expect(400);
    });
  });
});
