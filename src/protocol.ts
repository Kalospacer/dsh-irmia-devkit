/** 可通过 Native 和 PTC 返回的 JSON 值，不包含 BigInt 或运行时对象。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** 工具的业务结果；权限或基础设施异常使用异常通道。 */
export type Result = { ok: boolean; [key: string]: Json };

/** 有限业务失败，保留调用者需要的证据与后续参数。 */
export function failure(error: string, extra: Record<string, Json> = {}): Result {
  return { ok: false, error, ...extra };
}

/** 把运行时异常转为日志或诊断消息，不吞掉基础设施失败。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
