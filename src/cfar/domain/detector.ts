import { alphaFactor } from './alpha';
import { CfarError } from './errors';
import { validateGeometry, WindowGeometry } from './geometry';
import {
  isWindowAvailable,
  referenceSlices,
  totalReferenceCount,
} from './reference-window';

/** 一个单元的判决结果。无效单元 threshold 为 null，且 detection 必为 false。 */
export interface CfarCellResult {
  threshold: number | null;
  detection: boolean;
  invalid: boolean;
}

export interface DetectionResult {
  /** 与输入等长的逐单元阈值；边缘参考不足的单元为 null */
  thresholds: (number | null)[];
  /** 与输入等长的检出布尔标记 */
  detections: boolean[];
  /** 与输入等长的无效标记（任一侧参考凑不齐） */
  invalid: boolean[];
  /** 本趟实际使用的阈值因子 α */
  alpha: number;
  /** 本趟实际使用的两侧参考单元总数 N */
  n: number;
}

/**
 * 校验非负幅度序列。
 */
export function validateAmplitudes(amplitudes: unknown): number[] {
  if (!Array.isArray(amplitudes)) {
    throw new CfarError('amplitudes must be an array of non-negative numbers');
  }
  for (const value of amplitudes) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new CfarError('every amplitude must be a finite number');
    }
    if (value < 0) {
      throw new CfarError('amplitudes must be non-negative');
    }
  }
  return amplitudes as number[];
}

/**
 * CA-CFAR 逐单元判决（一趟滑窗）。
 *
 * 对每个 CUT：
 *   1. 两端附近参考凑不齐 -> 标无效、不检出，绝不补零；
 *   2. 否则取两侧参考单元（不含保护单元、不含 CUT）的平均幅度；
 *   3. 阈值 T = 参考均值 * α，α = N * (Pfa^(-1/N) - 1)；
 *   4. CUT 幅度严格压过阈值才报目标。
 *
 * 本函数内部使用的累计和（前缀和）只服务当前这一趟，返回后即释放。
 */
export function runCaCfar(rawAmplitudes: unknown, rawGeometry: unknown): DetectionResult {
  const amplitudes = validateAmplitudes(rawAmplitudes);
  const geometry: WindowGeometry = validateGeometry(
    rawGeometry as Partial<WindowGeometry>,
  );

  const { guardCells, referenceCellsPerSide, pfa } = geometry;
  const n = totalReferenceCount(referenceCellsPerSide); // 每侧至少 1，故 N >= 2
  const alpha = alphaFactor(pfa, n);

  const length = amplitudes.length;
  const thresholds: (number | null)[] = new Array(length).fill(null);
  const detections: boolean[] = new Array(length).fill(false);
  const invalid: boolean[] = new Array(length).fill(false);

  if (length === 0) {
    return { thresholds, detections, invalid, alpha, n };
  }

  // 当前这一趟专用的前缀和（累计和）；不会带到下一趟滑窗。
  const prefix = new Float64Array(length + 1);
  for (let i = 0; i < length; i++) {
    prefix[i + 1] = prefix[i] + amplitudes[i];
  }

  for (let cut = 0; cut < length; cut++) {
    if (!isWindowAvailable(cut, length, guardCells, referenceCellsPerSide)) {
      invalid[cut] = true;
      detections[cut] = false;
      thresholds[cut] = null;
      continue;
    }

    const slices = referenceSlices(amplitudes, cut, guardCells, referenceCellsPerSide);
    // isWindowAvailable 已保证非 null；保留分支以满足类型收窄。
    /* istanbul ignore next */
    if (slices === null) {
      invalid[cut] = true;
      continue;
    }

    const leftStart = cut - guardCells - referenceCellsPerSide;
    const leftEnd = cut - guardCells; // 不含
    const rightStart = cut + guardCells + 1;
    const rightEnd = cut + guardCells + 1 + referenceCellsPerSide; // 不含
    const referenceSum =
      prefix[leftEnd] - prefix[leftStart] + prefix[rightEnd] - prefix[rightStart];

    const referenceMean = referenceSum / n;
    const threshold = referenceMean * alpha;

    thresholds[cut] = threshold;
    detections[cut] = amplitudes[cut] > threshold;
    invalid[cut] = false;
  }

  return { thresholds, detections, invalid, alpha, n };
}
