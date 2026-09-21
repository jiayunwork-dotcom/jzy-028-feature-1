import { runCaCfar } from '../../src/cfar/domain/detector';
import { CfarError } from '../../src/cfar/domain/errors';
import {
  AppendOutcome,
  StreamingCfarSession,
} from '../../src/cfar/domain/streaming-session';

// 与 detector.spec 相同的确定性伪随机数（指数分布背景）
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

function makeLine(rand: () => number, length: number, targets: Record<number, number>): number[] {
  const amps: number[] = [];
  for (let i = 0; i < length; i++) {
    amps.push(targets[i] ?? -Math.log(1 - rand()));
  }
  return amps;
}

/** 把一条线分批喂进会话，汇总每次追加的落定结果，返回逐单元最终判决。 */
function feedAll(
  session: StreamingCfarSession,
  amps: number[],
  batchSize: number,
): { thresholds: (number | null)[]; detections: boolean[]; invalid: boolean[] } {
  const thresholds: (number | null)[] = new Array(amps.length).fill(null);
  const detections: boolean[] = new Array(amps.length).fill(false);
  const invalid: boolean[] = new Array(amps.length).fill(true);
  for (let start = 0; start < amps.length; start += batchSize) {
    const batch = amps.slice(start, start + batchSize);
    const outcome = session.append(batch);
    for (const cell of outcome.finalized) {
      thresholds[cell.index] = cell.threshold;
      detections[cell.index] = cell.detection;
      invalid[cell.index] = cell.invalid;
    }
  }
  return { thresholds, detections, invalid };
}

describe('StreamingCfarSession —— 分批追加 ≡ 一次性整条送入', () => {
  const cases: { label: string; geometry: Record<string, number>; line: number[] }[] = [];

  const geoA = { guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 };
  const randA = mulberry32(20260921);
  const lineA = makeLine(randA, 200, { 60: 30, 120: 8, 121: 7 });
  cases.push({ label: '每侧 2 参考 × 200 点', geometry: geoA, line: lineA });

  const geoB = { guardCells: 2, referenceCellsPerSide: 4, pfa: 1e-2 };
  const randB = mulberry32(7);
  const lineB = makeLine(randB, 150, { 50: 50 });
  cases.push({ label: '每侧 4 参考 × 150 点', geometry: geoB, line: lineB });

  test.each([
    ['整条一次喂入', (_g: Record<string, number>) => 10_000],
    ['每批 1 点（最慢）', () => 1],
    ['每批 5 点', () => 5],
  ])('%s：最终判决与单趟接口逐位一致', (_label: string, batch: (g: Record<string, number>) => number) => {
    for (const { geometry, line } of cases) {
      const oneShot = runCaCfar(line, geometry);
      const session = new StreamingCfarSession(geometry);
      const streamed = feedAll(session, line, batch(geometry));
      // 逐位一致：阈值（含 null）、检出、无效标记全部 toEqual
      expect(streamed.thresholds).toEqual(oneShot.thresholds);
      expect(streamed.detections).toEqual(oneShot.detections);
      expect(streamed.invalid).toEqual(oneShot.invalid);
    }
  });

  test('任意随机批次切分：每一次追加后的中间态都等于"已接收前缀"的单趟结果', () => {
    const rand = mulberry32(99);
    const geometry = { guardCells: 2, referenceCellsPerSide: 3, pfa: 1e-3 } as const;
    const line = makeLine(rand, 120, { 77: 25 });
    const oneShot = runCaCfar(line, geometry);

    // 随机批次大小 1..10 切分同一条线
    const chunks: number[][] = [];
    let cursor = 0;
    while (cursor < line.length) {
      const size = 1 + Math.floor(rand() * 10);
      chunks.push(line.slice(cursor, cursor + size));
      cursor += size;
    }
    const session = new StreamingCfarSession(geometry);
    let received = 0;
    for (const chunk of chunks) {
      session.append(chunk);
      received += chunk.length;
      // 不变式：会话当前对全部已接收单元的判决 ≡ 已接收前缀的单趟结果
      const prefixOneShot = runCaCfar(line.slice(0, received), geometry);
      for (let i = 0; i < received; i++) {
        const cell = session.getCell(i)!;
        expect(cell.threshold).toBe(prefixOneShot.thresholds[i]);
        expect(cell.detection).toBe(prefixOneShot.detections[i]);
        expect(cell.invalid).toBe(prefixOneShot.invalid[i]);
      }
    }
    // 全程结束后与完整单趟一致（严格相等，含浮点逐位）
    for (let i = 0; i < line.length; i++) {
      expect(session.getCell(i)!.threshold).toBe(oneShot.thresholds[i]);
      expect(session.getCell(i)!.detection).toBe(oneShot.detections[i]);
      expect(session.getCell(i)!.invalid).toBe(oneShot.invalid[i]);
    }
  });

  test('目标与保护单元不进参考均值的核心约束在分批下同样成立', () => {
    // 与 detector.spec 同款场景：cut=5，guard=2，perSide=2，保护/目标灌大值
    const boosted = [1, 1, 1, 500, 500, 200, 500, 500, 1, 1, 1];
    const base = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const geo = { guardCells: 2, referenceCellsPerSide: 2, pfa: 1e-3 };
    const oneShotBase = runCaCfar(base, geo);
    const oneShotBoost = runCaCfar(boosted, geo);

    // 逐点喂入
    const session = new StreamingCfarSession(geo);
    const streamed = feedAll(session, boosted, 1);
    expect(streamed.thresholds[5]).toBe(oneShotBoost.thresholds[5]);
    expect(streamed.thresholds[5]).toBe(oneShotBase.thresholds[5]);
    expect(streamed.detections[5]).toBe(true);
  });
});

describe('StreamingCfarSession —— 边界状态反悔与追溯重判', () => {
  const geo = { guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 }; // span = 3
  // 12 个点，cut=6 处一个强目标
  const amps = [0.4, 0.5, 0.3, 0.6, 0.4, 0.5, 50, 0.4, 0.6, 0.3, 0.5, 0.4];
  const oneShot = runCaCfar(amps, geo);

  test('单元先因右窗未齐标无效，窗口补齐后被追溯性重判，且每批只重判一个单元', () => {
    const session = new StreamingCfarSession(geo);
    const outcomes: AppendOutcome[] = [];
    for (const a of amps) {
      outcomes.push(session.append([a]));
    }

    // 每批 1 点：每批落定的单元数要么 0（前 span 批）要么恰好 1
    for (let i = 0; i < amps.length; i++) {
      const finalized = outcomes[i].finalized;
      if (i < 3) {
        expect(finalized).toHaveLength(0);
      } else {
        expect(finalized).toHaveLength(1);
        expect(finalized[0].index).toBe(i - 3); // 恰好是右窗刚补齐的那个单元
      }
    }

    // 聚焦 cut=6（强目标）：追加到下标 6 时右窗未齐 → 无效、无阈值、未落定
    const pending6 = outcomes[6].pending.find((c) => c.index === 6)!;
    expect(pending6.invalid).toBe(true);
    expect(pending6.threshold).toBeNull();
    expect(pending6.detection).toBe(false);
    expect(pending6.final).toBe(false);
    expect(pending6.revision).toBe(1);

    // 追加到下标 9 时，cut=6 的右窗（10,11 之外……右参考为 8,9 加保护 7）补齐：
    // 该批只追溯重判 cut=6 这一个单元
    const rejudged = outcomes[9].finalized;
    expect(rejudged).toHaveLength(1);
    expect(rejudged[0].index).toBe(6);
    expect(rejudged[0].final).toBe(true);
    expect(rejudged[0].invalid).toBe(false);
    expect(rejudged[0].threshold).toBe(oneShot.thresholds[6]);
    expect(rejudged[0].detection).toBe(true); // 强目标检出
    expect(rejudged[0].revision).toBe(2); // 标无效一次 + 追溯重判一次

    // 全部追加完后，cut=6 的最终判决与单趟一致
    const final6 = session.getCell(6)!;
    expect(final6.threshold).toBe(oneShot.thresholds[6]);
    expect(final6.detection).toBe(oneShot.detections[6]);
    expect(final6.invalid).toBe(oneShot.invalid[6]);
  });

  test('左缘单元左侧参考永远凑不齐：落定无效、绝不补零', () => {
    const session = new StreamingCfarSession(geo);
    session.append(amps);
    for (const i of [0, 1, 2]) {
      const cell = session.getCell(i)!;
      expect(cell.final).toBe(true);
      expect(cell.invalid).toBe(true);
      expect(cell.threshold).toBeNull();
      expect(cell.detection).toBe(false);
    }
  });

  test('已落定的判决不会被后续追加改写（revision 冻结，结果不变，不再重算）', () => {
    const session = new StreamingCfarSession(geo);
    const finalizedSeen: number[][] = [];
    // 逐点喂到 cut=6 落定（下标 9 到达时）
    for (let i = 0; i <= 9; i++) {
      finalizedSeen.push(session.append([amps[i]]).finalized.map((c) => c.index));
    }
    const settled = session.getCell(6)!;
    expect(settled.final).toBe(true);
    expect(settled.revision).toBe(2);

    // 之后再追加一大批（含会污染邻近窗口的大幅值），cut=6 不许动
    const extra = [1000, 0.1, 0.2, 999, 0.3, 0.2, 0.1, 0.4];
    const more = session.append(extra);
    expect(more.finalized.some((c) => c.index === 6)).toBe(false);
    const after = session.getCell(6)!;
    expect(after).toEqual(settled); // 阈值/检出/无效/final/revision 全部冻结

    // 更早落定的单元（如 cut=3）同样冻结
    const settled3 = session.getCell(3)!;
    session.append([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    expect(session.getCell(3)!).toEqual(settled3);
  });
});

describe('StreamingCfarSession —— 保留历史量有界', () => {
  test('连续追加很多批：保留的原始幅度不随批次数增长，只随窗几何变化', () => {
    const geoSmall = { guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 }; // span 3
    const geoBig = { guardCells: 2, referenceCellsPerSide: 8, pfa: 1e-3 }; // span 10

    const session = new StreamingCfarSession(geoSmall);
    let retainedMax = 0;
    for (let batch = 0; batch < 500; batch++) {
      const outcome = session.append([0.5, 0.6, 0.4, 0.55, 0.45]);
      retainedMax = Math.max(retainedMax, outcome.retainedAmplitudes);
    }
    const status = session.status();
    expect(status.received).toBe(2500);
    // 全程峰值也不超过 2×span
    expect(retainedMax).toBeLessThanOrEqual(2 * (1 + 2));
    // 稳态下恰好 2×span
    expect(status.retainedAmplitudes).toBe(2 * (1 + 2));

    // 窗几何变大 → 保留量跟着变大，但仍是常数
    const sessionBig = new StreamingCfarSession(geoBig);
    for (let batch = 0; batch < 400; batch++) {
      sessionBig.append([1, 1, 1, 1, 1]);
    }
    expect(sessionBig.status().retainedAmplitudes).toBe(2 * (2 + 8));
  });

  test('不同批次切分同一条线：保留历史上界相同（与切分无关）', () => {
    const geo = { guardCells: 2, referenceCellsPerSide: 3, pfa: 1e-3 };
    const line = new Array(100).fill(0.5);
    for (const batchSize of [1, 7, 33]) {
      const session = new StreamingCfarSession(geo);
      let retainedMax = 0;
      for (let start = 0; start < line.length; start += batchSize) {
        retainedMax = Math.max(retainedMax, session.append(line.slice(start, start + batchSize)).retainedAmplitudes);
      }
      expect(retainedMax).toBeLessThanOrEqual(2 * (2 + 3));
    }
  });
});

describe('StreamingCfarSession —— 空批与非法输入', () => {
  test('空批追加是 no-op', () => {
    const session = new StreamingCfarSession({ guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 });
    session.append([0.1, 0.2, 0.3]);
    const before = session.status();
    const outcome = session.append([]);
    expect(outcome.finalized).toHaveLength(0);
    expect(outcome.pending).toHaveLength(0);
    expect(session.status().received).toBe(before.received);
  });

  test('非法几何开会话被拒；负幅度追加被拒', () => {
    expect(() => new StreamingCfarSession({ guardCells: 1, referencehint: 2 })).toThrow(CfarError);
    expect(() => new StreamingCfarSession({ guardCells: 0, referenceCellsPerSide: 0, pfa: 0.5 })).toThrow(CfarError);
    expect(() => new StreamingCfarSession({ guardCells: 0, referenceCellsPerSide: 1, pfa: 1 })).toThrow(CfarError);
    const session = new StreamingCfarSession({ guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 });
    expect(() => session.append([1, -0.5, 2])).toThrow(CfarError);
    expect(() => session.append('nope')).toThrow(CfarError);
  });
});
