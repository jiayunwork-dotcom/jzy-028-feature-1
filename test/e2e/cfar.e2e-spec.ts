import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { CfarExceptionFilter } from '../../src/cfar/cfar.exception-filter';

describe('CA-CFAR HTTP (e2e)', () => {
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

  describe('POST /detect', () => {
    test('内联几何：返回等长阈值/检出/无效数组及本趟 α、N', async () => {
      const amps = [0.2, 0.5, 0.4, 0.3, 50, 0.4, 0.5, 0.3, 0.2, 0.6];
      const res = await request(app.getHttpServer())
        .post('/detect')
        .send({
          amplitudes: amps,
          guardCells: 1,
          referenceCellsPerSide: 2,
          pfa: 0.001,
        })
        .expect(200);
      expect(res.body.thresholds).toHaveLength(10);
      expect(res.body.detections).toHaveLength(10);
      expect(res.body.invalid).toHaveLength(10);
      expect(res.body.n).toBe(4);
      expect(res.body.alpha).toBeGreaterThan(0);
      expect(res.body.detections[4]).toBe(true);
      // 边缘无效
      expect(res.body.invalid[0]).toBe(true);
      expect(res.body.thresholds[0]).toBeNull();
    });

    test('具名窗规：standard 可用', async () => {
      const amps = new Array(25).fill(0.5);
      amps[12] = 200;
      const res = await request(app.getHttpServer())
        .post('/detect')
        .send({ amplitudes: amps, profileName: 'standard' })
        .expect(200);
      expect(res.body.n).toBe(16);
      expect(res.body.detections[12]).toBe(true);
    });

    test('运行期登记窗规后即可点名使用', async () => {
      await request(app.getHttpServer())
        .post('/profiles')
        .send({ name: 'e2e-wide', guardCells: 2, referenceCellsPerSide: 16, pfa: 1e-4 })
        .expect(201);
      const res = await request(app.getHttpServer())
        .post('/detect')
        .send({ amplitudes: new Array(60).fill(1), profileName: 'e2e-wide' })
        .expect(200);
      expect(res.body.n).toBe(32);
    });

    test('未知窗规被拒：404', async () => {
      const res = await request(app.getHttpServer())
        .post('/detect')
        .send({ amplitudes: [1, 2, 3, 4, 5], profileName: 'ghost' })
        .expect(404);
      expect(res.body.message).toMatch(/ghost/);
    });

    test('负幅度被拒：400', async () => {
      const res = await request(app.getHttpServer())
        .post('/detect')
        .send({
          amplitudes: [1, -2, 3],
          guardCells: 0,
          referenceCellsPerSide: 1,
          pfa: 0.01,
        })
        .expect(400);
      expect(res.body.message).toMatch(/non-negative/);
    });

    test('Pfa 越界被拒：400', async () => {
      await request(app.getHttpServer())
        .post('/detect')
        .send({
          amplitudes: [1, 2, 3, 4, 5],
          guardCells: 0,
          referenceCellsPerSide: 1,
          pfa: 0,
        })
        .expect(400);
      await request(app.getHttpServer())
        .post('/detect')
        .send({
          amplitudes: [1, 2, 3, 4, 5],
          guardCells: 0,
          referenceCellsPerSide: 1,
          pfa: 1,
        })
        .expect(400);
    });

    test('每侧参考数为 0（窗长 0）被拒：400', async () => {
      await request(app.getHttpServer())
        .post('/detect')
        .send({ amplitudes: [1, 2, 3, 4, 5], guardCells: 0, referenceCellsPerSide: 0, pfa: 0.01 })
        .expect(400);
    });

    test('保护单元负数被拒：400', async () => {
      await request(app.getHttpServer())
        .post('/detect')
        .send({ amplitudes: [1, 2, 3, 4, 5], guardCells: -1, referenceCellsPerSide: 2, pfa: 0.01 })
        .expect(400);
    });

    test('缺项（既无窗规名也无内联几何）被拒：400', async () => {
      await request(app.getHttpServer())
        .post('/detect')
        .send({ amplitudes: [1, 2, 3] })
        .expect(400);
    });

    test('同时给窗规名和内联几何被拒：400', async () => {
      await request(app.getHttpServer())
        .post('/detect')
        .send({
          amplitudes: [1, 2, 3, 4, 5],
          profileName: 'standard',
          guardCells: 1,
          referenceCellsPerSide: 2,
          pfa: 0.01,
        })
        .expect(400);
    });

    test('边缘参考不足标无效而不是补零（短线上大部分单元无效）', async () => {
      const res = await request(app.getHttpServer())
        .post('/detect')
        .send({
          amplitudes: [0.1, 0.2, 0.3, 0.2, 0.1],
          guardCells: 0,
          referenceCellsPerSide: 2,
          pfa: 0.5,
        })
        .expect(200);
      // 长度 5、perSide=2：只有 cut=2 窗完整；0,1,3,4 全无效，不补零
      expect(res.body.invalid).toEqual([true, true, false, true, true]);
      expect([res.body.thresholds[0], res.body.thresholds[1], res.body.thresholds[3], res.body.thresholds[4]]).toEqual([
        null,
        null,
        null,
        null,
      ]);
      // 无效单元一律不检出（即便它们幅度再大，也不许拿零填参考后误报）
      expect(res.body.detections[0]).toBe(false);
      expect(res.body.detections[1]).toBe(false);
      expect(res.body.detections[3]).toBe(false);
      expect(res.body.detections[4]).toBe(false);
      // 中间有效单元的阈值等于 4 个参考的均值 * α（pfa=0.5,N=4）
      const expectedAlpha = 4 * (Math.pow(0.5, -1 / 4) - 1);
      expect(res.body.thresholds[2]).toBeCloseTo(((0.1 + 0.2 + 0.2 + 0.1) / 4) * expectedAlpha, 9);
    });
  });

  describe('POST /profiles & GET /profiles', () => {
    test('非法几何登记被拒：400；非法名字被拒：400', async () => {
      await request(app.getHttpServer())
        .post('/profiles')
        .send({ name: 'bad-pfa', guardCells: 1, referenceCellsPerSide: 2, pfa: 2 })
        .expect(400);
      await request(app.getHttpServer())
        .post('/profiles')
        .send({ name: '', guardCells: 1, referenceCellsPerSide: 2, pfa: 0.01 })
        .expect(400);
    });

    test('重名窗规：409', async () => {
      await request(app.getHttpServer())
        .post('/profiles')
        .send({ name: 'dup', guardCells: 1, referenceCellsPerSide: 2, pfa: 0.01 })
        .expect(201);
      await request(app.getHttpServer())
        .post('/profiles')
        .send({ name: 'dup', guardCells: 1, referenceCellsPerSide: 2, pfa: 0.01 })
        .expect(409);
    });

    test('GET /profiles 列出窗规', async () => {
      const res = await request(app.getHttpServer()).get('/profiles').expect(200);
      const names = res.body.profiles.map((p: { name: string }) => p.name);
      expect(names).toContain('standard');
      expect(names).toContain('stringent');
    });
  });
});
