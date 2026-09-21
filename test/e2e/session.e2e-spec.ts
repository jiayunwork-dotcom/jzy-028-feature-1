import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { CfarExceptionFilter } from '../../src/cfar/cfar.exception-filter';
import { runCaCfar } from '../../src/cfar/domain/detector';

interface Event {
  index: number;
  state: 'settled' | 'invalid';
  threshold: number | null;
  detection: boolean;
  final: boolean;
  retroactive: boolean;
}

/** 通过 HTTP 把数据按指定大小分批追加，收集每个单元的最终事件。 */
async function streamOverHttp(
  app: INestApplication,
  sessionId: string,
  amps: number[],
  batchSize: number,
): Promise<Map<number, Event>> {
  const latest = new Map<number, Event>();
  for (let i = 0; i < amps.length; i += batchSize) {
    const res = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/append`)
      .send({ amplitudes: amps.slice(i, i + batchSize) })
      .expect(200);
    for (const e of res.body.events as Event[]) {
      latest.set(e.index, e);
    }
  }
  const closed = await request(app.getHttpServer()).delete(`/sessions/${sessionId}`).expect(200);
  for (const e of closed.body.events as Event[]) {
    latest.set(e.index, e);
  }
  return latest;
}

describe('持续检测会话 HTTP (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new CfarExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  test('分批追加与一次性 /detect 在同一组单元上结果完全一致（每批 1 点 / 每批 7 点）', async () => {
    const amps = [2, 4, 3, 100, 5, 6, 8, 2, 1, 3, 7, 9, 4, 2, 1, 5, 8, 6, 3, 2, 4, 90, 1, 2];
    const geo = { guardCells: 1, referenceCellsPerSide: 2, pfa: 0.001 };
    const oneShot = runCaCfar(amps, geo);

    for (const batchSize of [1, 3, 7, amps.length]) {
      const created = await request(app.getHttpServer())
        .post('/sessions')
        .send(geo)
        .expect(201);
      const sessionId = created.body.sessionId as string;
      expect(created.body.session.n).toBe(4);
      const latest = await streamOverHttp(app, sessionId, amps, batchSize);
      expect(latest.size).toBe(amps.length);
      for (let i = 0; i < amps.length; i++) {
        const e = latest.get(i)!;
        expect(e.final).toBe(true);
        expect(e.state === 'invalid').toBe(oneShot.invalid[i]);
        expect(e.detection).toBe(oneShot.detections[i]);
        if (oneShot.thresholds[i] === null) {
          expect(e.threshold).toBeNull();
        } else {
          expect(e.threshold).toBeCloseTo(oneShot.thresholds[i]!, 9);
        }
      }
    }
  });

  test('具名窗规开会话：标准几何生效', async () => {
    const created = await request(app.getHttpServer())
      .post('/sessions')
      .send({ profileName: 'standard' })
      .expect(201);
    expect(created.body.session.geometry.referenceCellsPerSide).toBe(8);
    const sessionId = created.body.sessionId as string;
    const amps = new Array(25).fill(0.5);
    amps[12] = 200;
    const latest = await streamOverHttp(app, sessionId, amps, 2);
    expect(latest.get(12)!.detection).toBe(true);
  });

  test('暂定无效 -> 追溯重判：事件先 final=false 后 retroactive=true，且只重判一个单元', async () => {
    // g=0,r=2 -> h=2
    const created = await request(app.getHttpServer())
      .post('/sessions')
      .send({ guardCells: 0, referenceCellsPerSide: 2, pfa: 0.5 })
      .expect(201);
    const id = created.body.sessionId as string;

    await request(app.getHttpServer()).post(`/sessions/${id}/append`).send({ amplitudes: [1, 1] }).expect(200);
    const third = await request(app.getHttpServer())
      .post(`/sessions/${id}/append`)
      .send({ amplitudes: [2] })
      .expect(200);
    expect(third.body.events).toEqual([
      { index: 2, state: 'invalid', threshold: null, detection: false, final: false, retroactive: false },
    ]);
    const fourth = await request(app.getHttpServer())
      .post(`/sessions/${id}/append`)
      .send({ amplitudes: [3] })
      .expect(200);
    // 右窗还没补齐：index=3 暂定，index=2 不被重算
    expect(fourth.body.events.map((e: Event) => e.index)).toEqual([3]);

    const fifth = await request(app.getHttpServer())
      .post(`/sessions/${id}/append`)
      .send({ amplitudes: [4] })
      .expect(200);
    // 只有 index=2 被追溯性正式判决，index=4 暂定；0,1,3 都不重算
    const retroactive = (fifth.body.events as Event[]).filter((e) => e.retroactive);
    expect(retroactive).toHaveLength(1);
    expect(retroactive[0].index).toBe(2);
    expect(retroactive[0].final).toBe(true);
    expect(retroactive[0].state).toBe('settled');
    const expectedAlpha = 4 * (Math.pow(0.5, -1 / 4) - 1);
    expect(retroactive[0].threshold).toBeCloseTo(((1 + 1 + 3 + 4) / 4) * expectedAlpha, 9);

    await request(app.getHttpServer()).delete(`/sessions/${id}`).expect(200);
  });

  test('GET 单元结果：返回最新判决；已裁剪单元 forgotten；未追加下标 future', async () => {
    const created = await request(app.getHttpServer())
      .post('/sessions')
      .send({ guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 })
      .expect(201);
    const id = created.body.sessionId as string;
    for (let i = 0; i < 30; i++) {
      await request(app.getHttpServer()).post(`/sessions/${id}/append`).send({ amplitudes: [1] });
    }
    const res = await request(app.getHttpServer()).get(`/sessions/${id}/results/29`).expect(200);
    expect(res.body.kind).toBe('result');
    expect(res.body.final).toBe(false); // 右窗未齐，暂定
    expect(res.body.threshold).toBeNull();
    const forgotten = await request(app.getHttpServer()).get(`/sessions/${id}/results/0`).expect(200);
    expect(forgotten.body.kind).toBe('forgotten');
    const future = await request(app.getHttpServer()).get(`/sessions/${id}/results/100`).expect(200);
    expect(future.body.kind).toBe('future');
    await request(app.getHttpServer()).get(`/sessions/${id}/results/abc`).expect(400);
    await request(app.getHttpServer()).delete(`/sessions/${id}`).expect(200);
  });

  test('GET 会话视图：历史保留量被钉在 2(g+r)，不随批次数增长', async () => {
    const created = await request(app.getHttpServer())
      .post('/sessions')
      .send({ guardCells: 2, referenceCellsPerSide: 5, pfa: 0.01 })
      .expect(201);
    const id = created.body.sessionId as string;
    let view: { retainedCells: number; retainedLimit: number; pendingCells: number; totalCells: number };
    for (let i = 0; i < 100; i++) {
      await request(app.getHttpServer()).post(`/sessions/${id}/append`).send({ amplitudes: [i] });
    }
    view = (await request(app.getHttpServer()).get(`/sessions/${id}`).expect(200)).body;
    expect(view.retainedLimit).toBe(14);
    expect(view.retainedCells).toBe(14);
    expect(view.pendingCells).toBe(7);
    expect(view.totalCells).toBe(100);
    for (let i = 0; i < 100; i++) {
      await request(app.getHttpServer()).post(`/sessions/${id}/append`).send({ amplitudes: [i] });
    }
    view = (await request(app.getHttpServer()).get(`/sessions/${id}`).expect(200)).body;
    expect(view.retainedCells).toBe(14); // 总线长翻倍，保留量不变
    expect(view.totalCells).toBe(200);
    await request(app.getHttpServer()).delete(`/sessions/${id}`).expect(200);
  });

  test('关闭后追加/查询/再关闭：410；不存在会话：404；非法几何：400', async () => {
    const created = await request(app.getHttpServer())
      .post('/sessions')
      .send({ guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 })
      .expect(201);
    const id = created.body.sessionId as string;
    await request(app.getHttpServer())
      .post(`/sessions/${id}/append`)
      .send({ amplitudes: [1, 2] })
      .expect(200);
    await request(app.getHttpServer()).delete(`/sessions/${id}`).expect(200);
    await request(app.getHttpServer())
      .post(`/sessions/${id}/append`)
      .send({ amplitudes: [3] })
      .expect(410);
    await request(app.getHttpServer()).get(`/sessions/${id}`).expect(410);
    await request(app.getHttpServer()).delete(`/sessions/${id}`).expect(410);

    await request(app.getHttpServer())
      .post('/sessions/nope/append')
      .send({ amplitudes: [1] })
      .expect(404);

    await request(app.getHttpServer())
      .post('/sessions')
      .send({ guardCells: 0, referenceCellsPerSide: 0, pfa: 0.1 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/sessions')
      .send({ profileName: 'ghost' })
      .expect(404);
  });

  test('非法幅度追加被拒：负幅度、非有限值、非数组均 400，且会话仍可继续正常追加', async () => {
    const created = await request(app.getHttpServer())
      .post('/sessions')
      .send({ guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 })
      .expect(201);
    const id = created.body.sessionId as string;
    await request(app.getHttpServer())
      .post(`/sessions/${id}/append`)
      .send({ amplitudes: [1, -0.5] })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/sessions/${id}/append`)
      .send({ amplitudes: [1, NaN] })
      .expect(400);
    // 失败的批次没有污染会话：继续追加仍然按连续序列判定
    const ok = await request(app.getHttpServer())
      .post(`/sessions/${id}/append`)
      .send({ amplitudes: [2, 3, 2] })
      .expect(200);
    const oneShot = runCaCfar([2, 3, 2], { guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 });
    const settled = (ok.body.events as Event[]).find((e) => e.index === 1);
    expect(settled?.state).toBe('settled');
    expect(settled?.threshold).toBeCloseTo(oneShot.thresholds[1]!, 9);
    await request(app.getHttpServer()).delete(`/sessions/${id}`).expect(200);
  });

  test('两个会话交错追加互不干扰', async () => {
    const a = await request(app.getHttpServer())
      .post('/sessions')
      .send({ guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 })
      .expect(201);
    const b = await request(app.getHttpServer())
      .post('/sessions')
      .send({ guardCells: 0, referenceCellsPerSide: 3, pfa: 0.2 })
      .expect(201);
    const idA = a.body.sessionId as string;
    const idB = b.body.sessionId as string;

    const a1 = await request(app.getHttpServer())
      .post(`/sessions/${idA}/append`)
      .send({ amplitudes: [1, 2, 3, 4, 5, 6, 7] })
      .expect(200);
    const b1 = await request(app.getHttpServer())
      .post(`/sessions/${idB}/append`)
      .send({ amplitudes: [9, 9, 9, 9, 9, 9, 9, 9] })
      .expect(200);
    const a2 = await request(app.getHttpServer())
      .post(`/sessions/${idA}/append`)
      .send({ amplitudes: [8, 9] })
      .expect(200);

    expect(a1.body.session.totalCells).toBe(7);
    expect(b1.body.session.totalCells).toBe(8);
    expect(a2.body.session.totalCells).toBe(9);
    // A 第二批的追溯事件只可能来自 A 自己上一批的暂定单元
    for (const e of a2.body.events as Event[]) {
      if (e.retroactive) {
        expect(e.index).toBeGreaterThanOrEqual(0);
        expect(e.index).toBeLessThan(7);
      }
    }
    await request(app.getHttpServer()).delete(`/sessions/${idA}`).expect(200);
    // 关掉 A 不影响 B：B 仍可追加
    await request(app.getHttpServer())
      .post(`/sessions/${idB}/append`)
      .send({ amplitudes: [1] })
      .expect(200);
    await request(app.getHttpServer()).delete(`/sessions/${idB}`).expect(200);
  });
});
