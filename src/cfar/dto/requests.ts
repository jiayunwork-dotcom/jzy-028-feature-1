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
 * POST /sessions 请求体：声明本次会话的窗几何。
 * 与 /detect 同一套二选一：{ profileName } 或
 * { guardCells, referenceCellsPerSide, pfa }。
 */
export interface CreateSessionRequestDto {
  profileName?: unknown;
  guardCells?: unknown;
  referenceCellsPerSide?: unknown;
  pfa?: unknown;
}

/** POST /sessions/:id/append 请求体。 */
export interface AppendRequestDto {
  amplitudes?: unknown;
}
