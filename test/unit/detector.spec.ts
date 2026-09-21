import { alphaFactor } from '../../src/cfar/domain/alpha';
import { runCaCfar, validateAmplitudes } from '../../src/cfar/domain/detector';
import { CfarError } from '../../src/cfar/domain/errors';

const G = { guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 };

describe('runCaCfar —— 逐单元判决与输出形状', () => {
  test('输出与输入等长，边缘无效单元阈值为 null 且不检出', () => {
    const amps = [0.4, 0.5, 0.6, 0.3, 0.5, 0.4, 0.7, 0.3, 0.2, 0.6];
    const r = runCaCfar(amps, G); // guard=1 perSide=2 -> 有效 cut ∈ [3,6]
    expect(r.thresholds).toHaveLength(10);
    expect(r.detections).toHaveLength(10);
    expect(r.invalid).toHaveLength(10);
    expect(r.n).toBe(4);
    expect(r.alpha).toBeCloseTo(alphaFactor(1e-3, 4), 12);
    expect(r.invalid.slice(0, 3)).toEqual([true, true, true]);
    expect(r.invalid.slice(7)).toEqual([true, true, true]);
    for (const i of [0, 1, 2, 7, 8, 9]) {
      expect(r.thresholds[i]).toBeNull();
      expect(r.detections[i]).toBe(false);
    }
  });

  test('空距离线返回等长空数组及本趟 α/N', () => {
    const r = runCaCfar([], G);
    expect(r.thresholds).toEqual([]);
    expect(r.detections).toEqual([]);
    expect(r.invalid).toEqual([]);
    expect(r.alpha).toBeGreaterThan(0);
    expect(r.n).toBe(4);
  });

  test('阈值公式：参考均值 × α，且严格大于才报目标', () => {
    // cut=3 有效：左参考下标 0,1；右参考下标 5,6；保护 2,4
    const amps = [2, 4, 100, 1, 100, 6, 8, 1, 1, 1];
    const r = runCaCfar(amps, G);
    const mean = (2 + 4 + 6 + 8) / 4;
    expect(r.thresholds[3]).toBeCloseTo(mean * r.alpha, 12);
    expect(r.detections[3]).toBe(false); // 1 不压过阈值

    // 等于阈值不算检出（严格 >）
    const t = r.thresholds[3]!;
    const amps2 = [2, 4, 100, t, 100, 6, 8, 1, 1, 1];
    const r2 = runCaCfar(amps2, G);
    expect(r2.thresholds[3]).toBeCloseTo(t, 9);
    expect(r2.detections[3]).toBe(false);
  });

  test('强目标被检出，且保护单元没有被“沾边”一锅端', () => {
    // guard=2, perSide=4, cut=10 放强目标 100，其余背景恒为 1
    const amps = new Array(21).fill(1);
    amps[10] = 100;
    const r = runCaCfar(amps, { guardCells: 2, referenceCellsPerSide: 4, pfa: 1e-3 });
    expect(r.invalid[10]).toBe(false);
    expect(r.detections[10]).toBe(true);
    // 四个保护单元（8,9,11,12）：目标不进它们的参考均值（保护隔开了），不得报目标
    for (const g of [8, 9, 11, 12]) {
      expect(r.detections[g]).toBe(false);
    }
  });

  test('保护单元未抬高目标处阈值：目标和保护灌大值，cut 阈值只由两侧参考决定', () => {
    // cut=5, guard=2, perSide=2：保护 3,4,6,7；左参考 1,2；右参考 8,9
    const base = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const boosted = [1, 1, 1, 500, 500, 200, 500, 500, 1, 1, 1];
    const geo = { guardCells: 2, referenceCellsPerSide: 2, pfa: 1e-3 };
    const rBase = runCaCfar(base, geo);
    const rBoost = runCaCfar(boosted, geo);
    // 目标 CUT 与其保护再大，都不许进参考 -> 目标处阈值与全 1 背景完全相同
    expect(rBoost.thresholds[5]).toBeCloseTo(rBase.thresholds[5]!, 12);
    expect(rBoost.detections[5]).toBe(true);
  });
});

describe('runCaCfar —— 验收性质', () => {
  test('只加大目标 CUT 幅度，该单元相对阈值裕量必须升高', () => {
    const geo = { guardCells: 1, referenceCellsPerSide: 3, pfa: 1e-3 };
    // cut=7：保护 6,8；左参考 3,4,5；右参考 9,10,11 —— 全程不动，阈值恒定
    const make = (cutAmp: number) => {
      const amps = new Array(15).fill(1);
      amps[7] = cutAmp;
      return runCaCfar(amps, geo);
    };
    const weak = make(2);
    const strong = make(50);
    const margin = (cutAmp: number, t: number) => cutAmp - t;
    expect(strong.thresholds[7]).toBeCloseTo(weak.thresholds[7]!, 12);
    expect(margin(50, strong.thresholds[7]!)).toBeGreaterThan(
      margin(2, weak.thresholds[7]!),
    );
    expect(weak.detections[7]).toBe(false);
    expect(strong.detections[7]).toBe(true);
  });

  test('Pfa 降一个数量级：α 升高、同一条带目标距离线上检出变少', () => {
    // 背景恒 1。N=8 时 α(Pfa=1e-2)≈6.23、α(Pfa=1e-3)≈10.94，
    // 故幅度 8 的中等目标只在高 Pfa 下过阈。目标间距 13（=2*(guard+ref)+1）互不污染参考窗。
    const length = 64;
    const amps = new Array(length).fill(1);
    for (const t of [10, 23, 36, 49]) {
      amps[t] = 8;
    }
    amps[23] = 50; // 一个强目标保底
    const high = runCaCfar(amps, { guardCells: 2, referenceCellsPerSide: 4, pfa: 1e-2 });
    const low = runCaCfar(amps, { guardCells: 2, referenceCellsPerSide: 4, pfa: 1e-3 });
    expect(low.alpha).toBeGreaterThan(high.alpha);
    const count = (arr: boolean[]) => arr.filter(Boolean).length;
    expect(count(low.detections)).toBeLessThan(count(high.detections));
    // 更严的门槛下强目标依然检出
    expect(low.detections[23]).toBe(true);
    expect(high.detections[10]).toBe(true);
    expect(low.detections[10]).toBe(false);
  });

  // 确定性的指数分布伪随机数（指数分布即功率检测/瑞利包络下的背景模型）
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

  test('均匀指数噪声、无目标：经验虚警落入 Pfa 的钉死波动带', () => {
    const rand = mulberry32(20260919);
    const length = 400_000;
    const amps = new Array<number>(length);
    for (let i = 0; i < length; i++) {
      amps[i] = -Math.log(1 - rand()); // 均值 1 的指数分布
    }
    const pfa = 1e-3;
    const r = runCaCfar(amps, { guardCells: 2, referenceCellsPerSide: 8, pfa });
    const valid = r.invalid.filter((v) => !v).length;
    const falseAlarms = r.detections.filter(Boolean).length;
    const empirical = falseAlarms / valid;
    // 钉死波动带：[0.5·Pfa, 2·Pfa]；绝不能差一个数量级
    expect(empirical).toBeGreaterThanOrEqual(0.5 * pfa);
    expect(empirical).toBeLessThanOrEqual(2 * pfa);
  });

  test('累计和不跨趟：相邻两趟互不串味（第二趟背景翻倍，阈值跟着翻倍）', () => {
    const geo = { guardCells: 1, referenceCellsPerSide: 2, pfa: 1e-3 };
    const r1 = runCaCfar([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], geo);
    const r2 = runCaCfar([2, 2, 2, 2, 2, 2, 2, 2, 2, 2], geo);
    expect(r2.thresholds[4]).toBeCloseTo(2 * r1.thresholds[4]!, 12);
    expect(r1.detections.some(Boolean)).toBe(false);
    expect(r2.detections.some(Boolean)).toBe(false);
  });
});

describe('runCaCfar —— 拒绝非法输入', () => {
  test('负幅度被拒', () => {
    expect(() => runCaCfar([1, 2, -0.01, 3], G)).toThrow(CfarError);
  });

  test('非有限幅度 / 非数组被拒', () => {
    expect(() => runCaCfar([1, NaN, 3], G)).toThrow(CfarError);
    expect(() => runCaCfar([1, Infinity], G)).toThrow(CfarError);
    expect(() => validateAmplitudes('nope')).toThrow(CfarError);
  });

  test('Pfa 越界被拒', () => {
    for (const pfa of [0, 1, -1, 2, NaN]) {
      expect(() => runCaCfar([1, 2, 3, 4, 5], { ...G, pfa: pfa as number })).toThrow(
        CfarError,
      );
    }
  });

  test('保护单元负数 / 非整数被拒', () => {
    expect(() => runCaCfar([1, 2, 3, 4, 5], { ...G, guardCells: -1 })).toThrow(CfarError);
    expect(() => runCaCfar([1, 2, 3, 4, 5], { ...G, guardCells: 1.5 })).toThrow(
      CfarError,
    );
  });

  test('每侧参考数 <1（含 0 窗长）被拒，绝不退化成无参考检测', () => {
    expect(() => runCaCfar([1, 2, 3, 4, 5], { ...G, referenceCellsPerSide: 0 })).toThrow(
      CfarError,
    );
    expect(() => runCaCfar([1, 2, 3, 4, 5], { ...G, referenceCellsPerSide: -2 })).toThrow(
      CfarError,
    );
  });
});
