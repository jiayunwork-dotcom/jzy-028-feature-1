/**
 * 领域错误：所有纯算法层（校验、α 计算、切片、判决）抛出的错误。
 * 由 HTTP 层的异常过滤器统一映射成 400。
 */
export class CfarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CfarError';
  }
}
