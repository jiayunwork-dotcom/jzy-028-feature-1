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

/**
 * POST /sessions 请求体：开持续检测会话时声明窗几何。
 * 与 /detect 相同的二选一规则：profileName 或内联 guardCells/referenceCellsPerSide/pfa。
 */
export interface CreateSessionRequestDto {
  profileName?: unknown;
  guardCells?: unknown;
  referenceCellsPerSide?: unknown;
  pfa?: unknown;
}

/**
 * POST /sessions/:id/append 请求体。
 */
export interface AppendSessionRequestDto {
  amplitudes?: unknown;
}
