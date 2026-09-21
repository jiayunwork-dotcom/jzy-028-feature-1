/**
 * 滑窗几何参数及校验。
 *
 * - guardCells: 紧邻 CUT 两侧、不计入参考均值的保护单元数（非负整数）
 * - referenceCellsPerSide: 每侧参考单元数（正整数，至少 1）
 * - pfa: 虚警率，开区间 (0, 1)
 */
export interface WindowGeometry {
  guardCells: number;
  referenceCellsPerSide: number;
  pfa: number;
}

import { CfarError } from './errors';

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * 校验一组窗几何参数。非法时抛 CfarError。
 */
export function validateGeometry(geometry: Partial<WindowGeometry> | null | undefined): WindowGeometry {
  if (geometry === null || typeof geometry !== 'object') {
    throw new CfarError('window geometry must be an object');
  }

  const { guardCells, referenceCellsPerSide, pfa } = geometry as Partial<WindowGeometry>;

  if (!isNonNegativeInteger(guardCells)) {
    throw new CfarError('guardCells must be a non-negative integer');
  }
  if (!isPositiveInteger(referenceCellsPerSide)) {
    throw new CfarError('referenceCellsPerSide must be an integer >= 1');
  }
  if (typeof pfa !== 'number' || !Number.isFinite(pfa) || pfa <= 0 || pfa >= 1) {
    throw new CfarError('pfa must be a finite number in the open interval (0, 1)');
  }

  return { guardCells, referenceCellsPerSide, pfa };
}
