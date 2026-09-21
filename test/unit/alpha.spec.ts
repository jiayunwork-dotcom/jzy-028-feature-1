import { alphaFactor } from '../../src/cfar/domain/alpha';
import { CfarError } from '../../src/cfar/domain/errors';

describe('alphaFactor —— 钉死公式 α = N * (Pfa^(-1/N) - 1)', () => {
  test('严格符合公式：几组 (Pfa, N) 手算比对', () => {
    // N=1, Pfa=0.5 -> 1 * (0.5^-1 - 1) = 1
    expect(alphaFactor(0.5, 1)).toBeCloseTo(1, 12);
    // N=2, Pfa=0.01 -> 2 * (0.01^-0.5 - 1) = 2 * 9 = 18
    expect(alphaFactor(0.01, 2)).toBeCloseTo(18, 10);
    // N=4, Pfa=0.001
    const expected4 = 4 * (Math.pow(0.001, -1 / 4) - 1);
    expect(alphaFactor(0.001, 4)).toBeCloseTo(expected4, 12);
    // N=16, Pfa=1e-6
    const expected16 = 16 * (Math.pow(1e-6, -1 / 16) - 1);
    expect(alphaFactor(1e-6, 16)).toBeCloseTo(expected16, 12);
  });

  test('α 必须随 Pfa 变：同一 N 下 Pfa 降一个数量级，α 必须升高', () => {
    const n = 16;
    const highPfa = alphaFactor(1e-3, n);
    const lowPfa = alphaFactor(1e-4, n);
    const lowerPfa = alphaFactor(1e-5, n);
    expect(lowPfa).toBeGreaterThan(highPfa);
    expect(lowerPfa).toBeGreaterThan(lowPfa);
  });

  test('α 必须随 N 变：同一 Pfa 下 N 不同 α 不同（不许写成与 N 无关的常数）', () => {
    const values = new Set<number>();
    for (let n = 2; n <= 64; n *= 2) {
      values.add(alphaFactor(1e-3, n));
    }
    expect(values.size).toBe(6);
    // 大 N 极限趋近 -ln(Pfa) ≈ 6.9078
    expect(alphaFactor(1e-3, 100000)).toBeCloseTo(-Math.log(1e-3), 2);
  });

  test('Pfa 越界（0、1、负数、>1、NaN、Infinity）一律拒绝', () => {
    for (const pfa of [0, 1, -0.01, 1.5, NaN, Infinity, -Infinity]) {
      expect(() => alphaFactor(pfa as number, 4)).toThrow(CfarError);
    }
  });

  test('窗长 N=0 或负 N / 非整数 N 一律拒绝', () => {
    expect(() => alphaFactor(1e-3, 0)).toThrow(CfarError);
    expect(() => alphaFactor(1e-3, -2)).toThrow(CfarError);
    expect(() => alphaFactor(1e-3, 1.5)).toThrow(CfarError);
  });
});
