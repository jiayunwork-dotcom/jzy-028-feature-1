/**
 * 启动时载入内存的具名窗规（运行期可追加，不落库）。
 */
import { WindowGeometry } from '../domain/geometry';

export const SEED_PROFILES: Record<string, WindowGeometry> = {
  // 2 个保护单元、每侧 8 个参考（N=16）、Pfa = 1e-3
  standard: { guardCells: 2, referenceCellsPerSide: 8, pfa: 1e-3 },
  // 更紧的虚警率：2 个保护单元、每侧 8 个参考、Pfa = 1e-6
  stringent: { guardCells: 2, referenceCellsPerSide: 8, pfa: 1e-6 },
};
