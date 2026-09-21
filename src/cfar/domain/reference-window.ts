import { CfarError } from './errors';

/**
 * 参考窗切片。
 *
 * 一个被测单元 CUT 两侧的布局为：
 *
 *   ... 左侧参考 | 左侧保护 | CUT | 右侧保护 | 右侧参考 ...
 *
 * 目标（CUT 本身）和保护单元都不允许进入参考均值——把目标或保护单元算进
 * 均值会把该处阈值顶高，强目标反而漏检。
 */
export interface ReferenceSlices {
  cut: number;
  left: number[];
  right: number[];
}

/** 左侧参考单元下标：离 CUT 最近到最远，共 perSide 个（仅在窗完整时有效）。 */
export function leftReferenceIndices(cut: number, guardCells: number, perSide: number): number[] {
  const guard = cut - guardCells; // 离 CUT 最近的左侧保护单元下标
  const indices: number[] = [];
  for (let k = 0; k < perSide; k++) {
    indices.push(guard - 1 - k);
  }
  return indices;
}

/** 右侧参考单元下标：离 CUT 最近到最远，共 perSide 个（仅在窗完整时有效）。 */
export function rightReferenceIndices(cut: number, guardCells: number, perSide: number): number[] {
  const guard = cut + guardCells; // 离 CUT 最近的右侧保护单元下标
  const indices: number[] = [];
  for (let k = 0; k < perSide; k++) {
    indices.push(guard + 1 + k);
  }
  return indices;
}

/**
 * 两端附近的 CUT 若某一侧参考凑不齐，窗即不可用。
 * 缺失的参考绝不拿零去填。
 */
export function isWindowAvailable(
  cut: number,
  length: number,
  guardCells: number,
  perSide: number,
): boolean {
  const leftmost = cut - guardCells - perSide;
  const rightmost = cut + guardCells + perSide;
  return leftmost >= 0 && rightmost <= length - 1;
}

/**
 * 取出 CUT 两侧的参考幅度。
 * 窗不完整（任一侧凑不齐）时返回 null，由调用方把该单元标成无效。
 */
export function referenceSlices(
  amplitudes: readonly number[],
  cut: number,
  guardCells: number,
  perSide: number,
): ReferenceSlices | null {
  if (!Number.isInteger(cut) || cut < 0 || cut >= amplitudes.length) {
    throw new CfarError('cut index out of range');
  }
  if (!isWindowAvailable(cut, amplitudes.length, guardCells, perSide)) {
    return null;
  }

  const left = leftReferenceIndices(cut, guardCells, perSide).map((i) => amplitudes[i]);
  const right = rightReferenceIndices(cut, guardCells, perSide).map((i) => amplitudes[i]);
  return { cut, left, right };
}

/** 参考单元总数 N = 两侧参考个数之和。 */
export function totalReferenceCount(referenceCellsPerSide: number): number {
  return 2 * referenceCellsPerSide;
}
