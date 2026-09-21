import { CfarError } from './errors';

/**
 * CA-CFAR 阈值因子 α。
 *
 * 对指数分布（功率）或瑞利分布（包络）杂波背景，N 个参考单元的样本均值
 * 估计背景功率时，恒虚警阈值因子为：
 *
 *   α = N * (Pfa^(-1/N) - 1)
 *
 * N 是两侧参考单元个数之和。α 必须随 Pfa 与 N 变化，不是常数。
 *
 * @param pfa 虚警率，0 < pfa < 1
 * @param n   两侧参考单元总数，正整数（窗长为 0 一律拒绝）
 */
export function alphaFactor(pfa: number, n: number): number {
  if (typeof pfa !== 'number' || !Number.isFinite(pfa) || pfa <= 0 || pfa >= 1) {
    throw new CfarError('pfa must be a finite number in the open interval (0, 1)');
  }
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new CfarError('reference window length N must be a positive integer (N=0 is rejected)');
  }

  return n * (Math.pow(pfa, -1 / n) - 1);
}
