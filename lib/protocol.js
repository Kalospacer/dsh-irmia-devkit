/** 有限业务失败，保留调用者需要的证据与后续参数。 */
export function failure(error, extra = {}) {
    return { ok: false, error, ...extra };
}
/** 把运行时异常转为日志或诊断消息，不吞掉基础设施失败。 */
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=protocol.js.map