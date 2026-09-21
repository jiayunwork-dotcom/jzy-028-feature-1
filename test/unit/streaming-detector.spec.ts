import { CellEvent, StreamingCfarSession } from '../../src/cfar/domain/streaming-detector';
import { runCaCfar } from '../../src/cfar/domain/detector';
import { CfarError } from '../../src/cfar/domain/errors';
import { WindowGeometry } from '../../src/cfar/domain/geometry';

const G: WindowGeometry = { guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 };

/** 收集一次会话全生命周期每个单元的"最终一次事件"。 */
function feedSession(
  amps: number[],
  batchSizes: number[],
  geometry: WindowGeometry = G,
): { byIndex: Map<number, CellEvent>; tentativeSeen: Map<number, number>; finalOrder: CellEvent[] } {
  const session = new StreamingCfarSession(geometry);
  const byIndex = new Map<number, CellEvent>();
  const tentativeSeen = new Map<number, number>();
  let cursor = 0;
  const cut = (events: CellEvent[]) => {
    for (const e of events) {
      byIndex.set(e.index, e);
      if (!e.final) {
        tentativeSeen.set(e.index, (tentativeSeen.get(e.index) ?? 0) + 1);
      }
    }
  };
  for (const size of batchSizes) {
    cut(session.append(amps.slice(cursor, cursor + size)));
    cursor += size;
  }
  if (cursor !== amps.length) {
    throw new Error('test harness: batch sizes do not partition the input');
  }
  cut(session.close());
  const finalOrder = [...byIndex.values()].sort((a, b) => a.index - b.index);
  return { byIndex, tentativeSeen, finalOrder };
}

/** 确定性伪随机（与 detector.spec 同款），用于产生幅度和随机切批。 */
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

/** 把流体会话的最终事件与一趟式 runCaCfar 结果逐单元对齐。 */
function assertEquivalentToOneShot(amps: number[], geometry: WindowGeometry, finalOrder: CellEvent[]): void {
  const oneShot = runCaCfar(amps, geometry);
  expect(finalOrder).toHaveLength(amps.length);
  for (let i = 0; i < amps.length; i++) {
    const e = finalOrder[i];
    expect(e.index).toBe(i);
    expect(e.final).toBe(true);
    expect(e.state === 'invalid').toBe(oneShot.invalid[i]);
    expect(e.detection).toBe(oneShot.detections[i]);
    if (oneShot.thresholds[i] === null) {
      expect(e.threshold).toBeNull();
    } else {
      expect(e.threshold).toBeCloseTo(oneShot.thresholds[i]!, 10);
    }
  }
}

describe('StreamingCfarSession —— 分批追加与一趟式完全一致', () => {
  const rand = mulberry32(42);
  const amps = Array.from({ length: 120 }, () => -Math.log(1 - rand()) * 2);
  amps[17] = 90;
  amps[60] = 120;
  amps[100] = 60;

  test('一次性整条喂入：结果逐单元等于 /detect', () => {
    const { finalOrder } = feedSession(amps, [amps.length]);
    assertEquivalentToOneShot(amps, G, finalOrder);
  });

  test('每批一个点：结果逐单元等于 /detect', () => {
    const { finalOrder } = feedSession(amps, amps.map(() => 1));
    assertEquivalentToOneShot(amps, G, finalOrder);
  });

  test('任意随机切批：结果与切分方式无关，全部等于 /detect', () => {
    for (let trial = 0; trial < 8; trial++) {
      const sizes: number[] = [];
      let remaining = amps.length;
      while (remaining > 0) {
        const size = 1 + Math.floor(rand() * 7);
        sizes.push(Math.min(size, remaining));
        remaining -= size;
      }
      const { finalOrder } = feedSession(amps, sizes);
      assertEquivalentToOneShot(amps, G, finalOrder);
    }
  });

  test('不同几何（含 guard=0）任意切批也一致', () => {
    const geometries: WindowGeometry[] = [
      { guardCells: 0, referenceCellsPerSide: 1, pfa: 0.5 },
      { guardCells: 0, referenceCellsPerSide: 3, pfa: 1e-4 },
      { guardCells: 2, referenceCellsPerSide: 8, pfa: 1e-3 },
      { guardCells: 5, referenceCellsPerSide: 4, pfa: 0.2 },
    ];
    for (const geometry of geometries) {
      const sizes: number[] = [];
      let remaining = amps.length;
      while (remaining > 0) {
        const size = 1 + Math.floor(rand() * 5);
        sizes.push(Math.min(size, remaining));
        remaining -= size;
      }
      const { finalOrder } = feedSession(amps, sizes, geometry);
      assertEquivalentToOneShot(amps, geometry, finalOrder);
    }
  });

  test('空线、比窗还短的线：同样一致', () => {
    for (const data of [[], [0.1], [0.1, 0.2], [1, 2, 3, 4]]) {
      const { finalOrder } = feedSession(
        data,
        data.map(() => 1),
        G,
      );
      assertEquivalentToOneShot(data, G, finalOrder);
    }
  });
});

describe('StreamingCfarSession —— 暂定无效 → 追溯重判，且只重判这一个单元', () => {
  test('每批一个点：新到单元先暂定无效，下一批只追溯它一个', () => {
    // g=0,r=2 -> h=2。追加到第 3 个点（index=2）时：左窗齐、右窗未齐。
    const session = new StreamingCfarSession({ guardCells: 0, referenceCellsPerSide: 2, pfa: 0.5 });
    session.append([1, 1]);
    const third = session.append([2]);
    expect(third).toEqual([
      { index: 2, state: 'invalid', threshold: null, detection: false, final: false, retroactive: false },
    ]);
    // 第 4 个点到达：index=3 仍暂定；index=2 右侧还差 1 个参考，仍不落定。
    const fourth = session.append([3]);
    expect(fourth.map((e) => e.index)).toEqual([3]);
    expect(fourth[0].final).toBe(false);
    // 第 5 个点到达：只把 index=2 追溯重判；本批的 index=4 暂定。
    const fifth = session.append([4]);
    const retroactive = fifth.filter((e) => e.retroactive);
    expect(retroactive).toHaveLength(1);
    expect(retroactive[0].index).toBe(2);
    expect(retroactive[0].state).toBe('settled');
    expect(retroactive[0].final).toBe(true);
    expect(retroactive[0].threshold).toBeCloseTo(((1 + 1 + 3 + 4) / 4) * (4 * (Math.pow(0.5, -1 / 4) - 1)), 10);
    expect(fifth.map((e) => e.index).sort((a, b) => a - b)).toEqual([2, 4]);
    // 本批没有重算 index=0,1（它们左窗不齐，早已是终态无效，不会再出现在事件里）
    expect(fifth.some((e) => e.index < 2)).toBe(false);
    session.close();
  });

  test('一次大批量到达时：先把上一批所有暂定单元按顺序追溯，再处理新单元', () => {
    const session = new StreamingCfarSession({ guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 }); // h=3
    session.append([1, 1, 1, 1]); // 0,1,2 左窗不齐 -> 终态无效；3 左齐右不齐 -> 暂定
    // 一次性补 10 个点：index=3 的右窗在 n=7（i+3=6<7）补齐 -> 追溯；
    // 新到的 4..13 中 4..9 直接落定，10..13 右窗不齐 -> 暂定。
    const events = session.append(new Array(10).fill(1));
    const retroactive = events.filter((e) => e.retroactive);
    expect(retroactive.map((e) => e.index)).toEqual([3]);
    // 追溯事件不包含已落定/早已终态无效的 0,1,2
    expect(retroactive.some((e) => e.index <= 2)).toBe(false);
    // 事件按下标升序：追溯事件 3 排在新事件 4..13 之前
    const indices = events.map((e) => e.index);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    session.close();
  });

  test('暂定无效期间绝不给阈值、绝不补零；追溯阈值严格等于一趟式', () => {
    const geometry: WindowGeometry = { guardCells: 1, referenceCellsPerSide: 2, pfa: 0.01 };
    const amps = [2, 4, 3, 1, 6, 8, 9, 7, 5, 3, 2, 1];
    const session = new StreamingCfarSession(geometry);
    let cursor = 0;
    const pending = new Set<number>();
    while (cursor < amps.length) {
      const events = session.append(amps.slice(cursor, cursor + 1));
      cursor += 1;
      for (const e of events) {
        if (!e.final) {
          pending.add(e.index);
          expect(e.threshold).toBeNull();
          expect(e.detection).toBe(false);
        } else if (e.retroactive) {
          pending.delete(e.index);
        }
      }
    }
    const tail = session.close();
    // 右边缘没补齐的单元在关闭时才终态无效，且标记为追溯
    for (const e of tail) {
      expect(e.final).toBe(true);
      expect(e.state).toBe('invalid');
    }
    const oneShot = runCaCfar(amps, geometry);
    // 对中间补齐了窗的单元：把每批事件里出现的 settled 阈值与一趟式对齐
    const session2 = new StreamingCfarSession(geometry);
    const settledAt = new Map<number, CellEvent>();
    for (const a of amps) {
      for (const e of session2.append([a])) {
        if (e.state === 'settled') {
          settledAt.set(e.index, e);
        }
      }
    }
    for (const [i, e] of settledAt) {
      expect(e.threshold).toBeCloseTo(oneShot.thresholds[i]!, 10);
      expect(e.detection).toBe(oneShot.detections[i]);
    }
    session2.close();
  });
});

describe('StreamingCfarSession —— 已落定判决不被后续追加改写', () => {
  test('一个单元落定后，再追加任意多批，事件流里永不复现', () => {
    const session = new StreamingCfarSession({ guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 }); // h=1
    session.append([3, 2, 1]); // index=1 在 n=3 时两侧到齐（参考 0、2），落定
    // 落定当下查询：阈值与一趟式一致
    const frozen = session.resultAt(1);
    expect(frozen).not.toBe('forgotten');
    if (frozen !== 'forgotten' && frozen !== 'future') {
      const oneShot = runCaCfar([3, 2, 1], { guardCells: 0, referenceCellsPerSide: 1, pfa: 0.1 });
      expect(frozen.state).toBe('settled');
      expect(frozen.threshold).toBeCloseTo(oneShot.thresholds[1]!, 10);
      expect(frozen.final).toBe(true);
    }
    const seenAfter = new Set<number>();
    for (const v of [5, 9, 0.1, 100, 0.2]) {
      for (const e of session.append([v])) {
        seenAfter.add(e.index);
      }
    }
    // 哪怕后续出现强目标，也不回头重算/重发左边单元（包括左边缘终态无效的 0）
    expect(seenAfter.has(0)).toBe(false);
    expect(seenAfter.has(1)).toBe(false);
    // 单元滚出保留窗口后查询返回 forgotten，但其正式结果早在事件流里交付过
    expect(session.resultAt(1)).toBe('forgotten');
    session.close();
  });

  test('“多算一次也没差”也不允许：落定事件在后续批次中零次复现', () => {
    const geometry: WindowGeometry = { guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-2 };
    const amps = new Array(60).fill(0.5);
    const session = new StreamingCfarSession(geometry);
    const firstFinalBatch = new Map<number, number>();
    let batch = 0;
    for (let i = 0; i < amps.length; i++) {
      batch += 1;
      const events = session.append([amps[i]]);
      for (const e of events) {
        if (e.final && !firstFinalBatch.has(e.index)) {
          firstFinalBatch.set(e.index, batch);
        } else if (e.final) {
          // 正式事件只能出现一次
          throw new Error(`cell ${e.index} emitted a final event more than once`);
        }
      }
    }
    session.close();
    // 每个"能落定"的单元都恰好有一次正式事件
    const h = 3;
    const expectedSettled = amps.length - 2 * h;
    expect([...firstFinalBatch.keys()].filter((i) => i >= h && i < amps.length - h)).toHaveLength(
      expectedSettled,
    );
  });
});

describe('StreamingCfarSession —— 保留历史量只随窗几何变化', () => {
  test('连续追加很多批后 retainedCells 被钉在 2*(g+r)，不随批次数/总线长增长', () => {
    const g = 2;
    const r = 5;
    const h = g + r;
    const session = new StreamingCfarSession({ guardCells: g, referenceCellsPerSide: r, pfa: 1e-3 });
    const observed: number[] = [];
    for (let i = 0; i < 500; i++) {
      session.append([i % 7]);
      const view = session.view();
      expect(view.retainedCells).toBeLessThanOrEqual(2 * h);
      expect(view.pendingCells).toBeLessThanOrEqual(h);
      observed.push(view.retainedCells);
    }
    // 后期完全稳定：继续追加不再增长
    const tail = observed.slice(-50);
    expect(Math.min(...tail)).toBe(2 * h);
    expect(Math.max(...tail)).toBe(2 * h);
    session.close();
  });

  test('retainedLimit 只跟 g、r 走；换几何上限随之变化，与喂了多少批无关', () => {
    const make = (g: number, r: number) => {
      const s = new StreamingCfarSession({ guardCells: g, referenceCellsPerSide: r, pfa: 0.01 });
      for (let i = 0; i < 300; i++) {
        s.append([1]);
      }
      s.close();
      return s.view();
    };
    const v1 = make(0, 1);
    expect(v1.retainedLimit).toBe(2);
    expect(v1.retainedCells).toBe(0); // close 后释放
    const v2 = make(2, 8);
    expect(v2.retainedLimit).toBe(20);
    const v3 = make(5, 4);
    expect(v3.retainedLimit).toBe(18);
  });

  test('裁剪后老单元查询返回 forgotten，但其正式结果早已在事件流交付；近窗单元可查', () => {
    const session = new StreamingCfarSession({ guardCells: 0, referenceCellsPerSide: 2, pfa: 0.5 });
    for (let i = 0; i < 20; i++) {
      session.append([1]);
    }
    // h=2，n=20，保留 [16,20)
    expect(session.resultAt(0)).toBe('forgotten');
    expect(session.resultAt(15)).toBe('forgotten');
    expect(session.resultAt(19)).not.toBe('forgotten');
    expect(session.resultAt(20)).toBe('future');
    session.close();
    // 关闭后内部历史清空：查询统一落在 forgotten
    expect(session.resultAt(19)).toBe('forgotten');
  });

  test('关闭即释放：retainedCells 归零，且状态为 closed', () => {
    const session = new StreamingCfarSession(G);
    session.append(new Array(50).fill(1));
    expect(session.view().retainedCells).toBeGreaterThan(0);
    session.close();
    const v = session.view();
    expect(v.state).toBe('closed');
    expect(v.retainedCells).toBe(0);
    expect(v.pendingCells).toBe(0);
  });
});

describe('StreamingCfarSession —— 核心约束不被批次切分松动', () => {
  test('保护单元/CUT 不进参考均值：保护与目标灌大值不抬高阈值', () => {
    const geometry: WindowGeometry = { guardCells: 2, referenceCellsPerSide: 2, pfa: 1e-3 };
    const base = new Array(20).fill(1);
    const boosted = new Array(20).fill(1);
    // cut=10：保护 8,9,11,12；CUT 10
    boosted[8] = boosted[9] = 500;
    boosted[10] = 200;
    boosted[11] = boosted[12] = 500;

    const runStreaming = (amps: number[]) => {
      const s = new StreamingCfarSession(geometry);
      const settled = new Map<number, CellEvent>();
      for (const a of amps) {
        for (const e of s.append([a])) {
          if (e.state === 'settled') {
            settled.set(e.index, e);
          }
        }
      }
      s.close();
      return settled;
    };
    const a = runStreaming(base);
    const b = runStreaming(boosted);
    expect(b.get(10)!.threshold).toBeCloseTo(a.get(10)!.threshold, 12);
    expect(b.get(10)!.detection).toBe(true);
  });

  test('拒绝非法输入', () => {
    expect(() => new StreamingCfarSession({ guardCells: -1, referenceCellsPerSide: 2, pfa: 0.1 })).toThrow(
      CfarError,
    );
    expect(() => new StreamingCfarSession({ guardCells: 1, referenceCellsPerSide: 0, pfa: 0.1 })).toThrow(
      CfarError,
    );
    expect(() => new StreamingCfarSession({ guardCells: 1, referenceCellsPerSide: 2, pfa: 0 })).toThrow(
      CfarError,
    );
    const s = new StreamingCfarSession(G);
    expect(() => s.append([1, -2])).toThrow(CfarError);
    expect(() => s.append([1, NaN])).toThrow(CfarError);
    expect(() => s.append('nope')).toThrow(CfarError);
    s.close();
    expect(() => s.append([1])).toThrow(/closed/);
    expect(() => s.close()).toThrow(/already closed/);
  });
});
