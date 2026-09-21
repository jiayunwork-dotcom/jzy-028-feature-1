/**
 * /detect 请求体。
 *
 * 两种用法二选一：
 *   1. { amplitudes, profileName }                 —— 点名一条已登记的具名窗规
 *   2. { amplitudes, guardCells, referenceCellsPerSide, pfa } —— 当次直接给几何
 */
export interface DetectRequestDto {
  amplitudes?: unknown;
  profileName?: unknown;
  guardCells?: unknown;
  referenceCellsPerSide?: unknown;
  pfa?: unknown;
}

export interface RegisterProfileRequestDto {
  name?: unknown;
  guardCells?: unknown;
  referenceCellsPerSide?: unknown;
  pfa?: unknown;
}
