import type { Result } from '../protocol.js';
/** Worker 的固定操作，不接受任意脚本或模块路径。 */
export interface SyntaxTask {
    kind: 'syntax';
    filename: string;
    source: string;
    timeoutMs: number;
}
export interface IndexTask {
    kind: 'index';
    filename: string;
    source: string;
    timeoutMs: number;
}
/** 当前支持的隔离计算请求。 */
export interface DbTask {
    kind: 'db';
    path: string;
    sql: string;
    params: (string | number | null)[];
    maxRows: number;
    maxBytes: number;
    timeoutMs: number;
}
export type WorkerTask = SyntaxTask | IndexTask | DbTask | import('../codegraph/worker.js').GraphRequest;
/** 单次 Worker 拥有者；取消、超时、卸载都等待同一 Worker 退出。 */
export declare class TaskRunner {
    private readonly live;
    private closed;
    run(task: WorkerTask, signal: AbortSignal): Promise<Result>;
    dispose(): Promise<void>;
}
