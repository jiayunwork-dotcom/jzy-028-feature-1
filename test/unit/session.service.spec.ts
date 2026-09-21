import { ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { runCaCfar } from '../../src/cfar/domain/detector';
import { ProfileService } from '../../src/cfar/profile.service';
import { SessionService } from '../../src/cfar/session.service';

describe('SessionService —— 会话生命周期', () => {
  let profiles: ProfileService;

  beforeEach(() => {
    profiles = new ProfileService();
  });

  function serviceWithClock(now: { t: number }): SessionService {
    return SessionService.forTesting(profiles, {
      idleTtlMs: 1000,
      maxSessions: 100,
      clock: () => now.t,
    });
  }

  test('具名窗规和内联几何都能开会话；view 带出解析后的几何与 α/N', () => {
    const svc = SessionService.forTesting(profiles, { idleTtlMs: 1000 });
    const a = svc.create({ profileName: 'standard' });
    expect(a.session.geometry.referenceCellsPerSide).toBe(8);
    expect(a.session.n).toBe(16);
    expect(a.session.alpha).toBeGreaterThan(0);

    const b = svc.create({ guardCells: 1, referenceCellsPerSide: 2, pfa: 0.001 });
    expect(b.session.geometry.guardCells).toBe(1);
    expect(b.session.totalCells).toBe(0);

    svc.close(a.sessionId);
    svc.close(b.sessionId);
  });

  test('非法几何开会话被拒绝；未登记窗名 404；什么都不给 400', () => {
    const svc = SessionService.forTesting(profiles, { idleTtlMs: 1000 });
    expect(() => svc.create({ guardCells: -1, referenceCellsPerSide: 2, pfa: 0.1 })).toThrow();
    expect(() => svc.create({ guardCells: 1, referenceCellsPerSide: 0, pfa: 0.1 })).toThrow();
    expect(() => svc.create({ guardCells: 1, referenceCellsPerSide: 2, pfa: 2 })).toThrow();
    expect(() => svc.create({ profileName: 'no-such-profile' })).toThrow(NotFoundException);
    expect(() => svc.create({})).toThrow();
    expect(() =>
      svc.create({ profileName: 'standard', guardCells: 1, referenceCellsPerSide: 2, pfa: 0.1 }),
    ).toThrow();
  });

  test('不存在的会话：追加/查询/关闭一律 404', () => {
    const svc = SessionService.forTesting(profiles, { idleTtlMs: 1000 });
    expect(() => svc.append('deadbeef', [1, 2])).toThrow(NotFoundException);
    expect(() => svc.result('deadbeef', 0)).toThrow(NotFoundException);
    expect(() => svc.view('deadbeef')).toThrow(NotFoundException);
    expect(() => svc.close('deadbeef')).toThrow(NotFoundException);
  });

  test('已关闭会话：追加/查询/再关闭都明确拒绝（410 Gone），不是静默忽略', () => {
    const svc = SessionService.forTesting(profiles, { idleTtlMs: 1000 });
    const { sessionId } = svc.create({ guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 });
    svc.append(sessionId, [1, 2, 3]);
    svc.close(sessionId);
    expect(() => svc.append(sessionId, [4])).toThrow(GoneException);
    expect(() => svc.result(sessionId, 1)).toThrow(GoneException);
    expect(() => svc.view(sessionId)).toThrow(GoneException);
    expect(() => svc.close(sessionId)).toThrow(GoneException);
  });

  test('关闭响应把右边缘暂定单元终态无效并交付，之后内存不再持有', () => {
    const svc = SessionService.forTesting(profiles, { idleTtlMs: 1000 });
    const { sessionId } = svc.create({ guardCells: 0, referenceCellsPerSide: 2, pfa: 0.5 });
    // 5 个点：只有 index=0..2 可能落定（2 在 n=5 时右窗齐），3、4 暂定
    svc.append(sessionId, [1, 1, 1, 1, 1]);
    const closed = svc.close(sessionId);
    const flushed = closed.events.map((e) => e.index);
    expect(flushed).toEqual([3, 4]);
    for (const e of closed.events) {
      expect(e.final).toBe(true);
      expect(e.state).toBe('invalid');
      expect(e.retroactive).toBe(true);
      expect(e.threshold).toBeNull();
    }
  });

  test('闲置会话自动过期：超时后追加被 410 拒绝，且内存被回收', () => {
    const now = { t: 0 };
    const svc = serviceWithClock(now);
    const a = svc.create({ guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 });
    const b = svc.create({ guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 });
    svc.append(a.sessionId, [1, 2]);
    now.t = 600;
    svc.append(b.sessionId, [3, 4]); // b 续期
    now.t = 1100; // a 距最后活动 1100ms 过期；b 距最后活动 500ms 存活
    expect(svc.sweepExpired()).toBe(1);
    expect(() => svc.append(a.sessionId, [9])).toThrow(GoneException);
    const ok = svc.append(b.sessionId, [5]);
    expect(ok.events.length).toBeGreaterThan(0);
    svc.close(b.sessionId);
  });

  test('过期墓碑不会永久占位：再过一个 TTL 后同名 ID 回到 404', () => {
    const now = { t: 0 };
    const svc = serviceWithClock(now);
    const { sessionId } = svc.create({ guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 });
    now.t = 2000;
    expect(() => svc.append(sessionId, [1])).toThrow(GoneException);
    now.t = 4001;
    expect(() => svc.append(sessionId, [1])).toThrow(NotFoundException);
  });

  test('会话数上限：忘记关闭时拒绝新会话（409），关闭一个后恢复', () => {
    const svc = SessionService.forTesting(profiles, { idleTtlMs: 0, maxSessions: 2 });
    const a = svc.create({ guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 });
    const b = svc.create({ guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 });
    expect(() => svc.create({ guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 })).toThrow(
      ConflictException,
    );
    svc.close(a.sessionId);
    const c = svc.create({ guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 });
    expect(c.sessionId).not.toBe(a.sessionId);
    svc.close(b.sessionId);
    svc.close(c.sessionId);
  });

  test('result 查询：返回最新判决；越界下标被拒；未追加下标为 future', () => {
    const svc = SessionService.forTesting(profiles, { idleTtlMs: 1000 });
    const { sessionId } = svc.create({ guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 });
    svc.append(sessionId, [5, 1, 1]);
    // index=1 两侧参考齐（0、2）-> settled
    const r = svc.result(sessionId, 1);
    expect(r.kind).toBe('result');
    expect(r.state).toBe('settled');
    expect(r.final).toBe(true);
    expect(svc.result(sessionId, 3).kind).toBe('future');
    expect(() => svc.result(sessionId, -1)).toThrow();
    expect(() => svc.result(sessionId, 'x' as unknown)).toThrow();
    svc.close(sessionId);
  });
});

describe('SessionService —— 多会话并发追加互不干扰', () => {
  test('各自窗几何、追加进度、保留历史独立；与各自一趟式结果一致', () => {
    const profiles = new ProfileService();
    const svc = SessionService.forTesting(profiles, { idleTtlMs: 1000 });

    const a = svc.create({ guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 });
    const b = svc.create({ profileName: 'standard' });

    const streamA = [2, 4, 100, 1, 100, 6, 8, 1, 1, 1, 2, 3];
    const streamB = new Array(40).fill(0.7);
    streamB[20] = 90;

    // 交错追加：A 每次 1 点，B 每次 3 点，节奏完全不同
    const latestA = new Map<number, { threshold: number | null; detection: boolean; state: string }>();
    const latestB = new Map<number, { threshold: number | null; detection: boolean; state: string }>();
    let ia = 0;
    let ib = 0;
    while (ia < streamA.length || ib < streamB.length) {
      if (ia < streamA.length) {
        const { events } = svc.append(a.sessionId, [streamA[ia++]]);
        for (const e of events) {
          latestA.set(e.index, { threshold: e.threshold, detection: e.detection, state: e.state });
        }
      }
      if (ib < streamB.length) {
        const chunk = streamB.slice(ib, ib + 3);
        ib += chunk.length;
        const { events } = svc.append(b.sessionId, chunk);
        for (const e of events) {
          latestB.set(e.index, { threshold: e.threshold, detection: e.detection, state: e.state });
        }
      }
      // A 的进度不应影响 B 的保留窗口，反之亦然
      expect(svc.view(a.sessionId).totalCells).toBe(ia);
      expect(svc.view(b.sessionId).totalCells).toBe(ib);
    }
    for (const e of svc.close(a.sessionId).events) {
      latestA.set(e.index, { threshold: e.threshold, detection: e.detection, state: e.state });
    }
    for (const e of svc.close(b.sessionId).events) {
      latestB.set(e.index, { threshold: e.threshold, detection: e.detection, state: e.state });
    }

    const compare = (
      latest: Map<number, { threshold: number | null; detection: boolean; state: string }>,
      data: number[],
      geometry: { guardCells: number; referenceCellsPerSide: number; pfa: number },
    ) => {
      // 与单趟服务对比（直接复用领域函数，避免 HTTP 依赖）
      const one = runCaCfar(data, geometry);
      expect(latest.size).toBe(data.length);
      for (let i = 0; i < data.length; i++) {
        const got = latest.get(i)!;
        expect(got.state === 'invalid').toBe(one.invalid[i]);
        expect(got.detection).toBe(one.detections[i]);
        if (one.thresholds[i] === null) {
          expect(got.threshold).toBeNull();
        } else {
          expect(got.threshold).toBeCloseTo(one.thresholds[i], 10);
        }
      }
    };
    compare(latestA, streamA, { guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 });
    compare(latestB, streamB, { guardCells: 2, referenceCellsPerSide: 8, pfa: 1e-3 });
  });
});
