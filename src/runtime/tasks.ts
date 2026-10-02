import { Worker } from 'node:worker_threads';
import type { Result } from '../protocol.js';

/** Worker 的固定操作，不接受任意脚本或模块路径。 */
export interface SyntaxTask { kind: 'syntax'; filename: string; source: string; timeoutMs: number }
export interface IndexTask { kind: 'index'; filename: string; source: string; timeoutMs: number }
/** 当前支持的隔离计算请求。 */
export interface DbTask { kind: 'db'; path: string; sql: string; params: (string | number | null)[]; maxRows: number; maxBytes: number; timeoutMs: number }
export type WorkerTask = SyntaxTask | IndexTask | DbTask | import('../codegraph/worker.js').GraphRequest;

/** 单次 Worker 拥有者；取消、超时、卸载都等待同一 Worker 退出。 */
export class TaskRunner {
  private readonly live = new Set<Worker>();
  private closed = false;

  async run(task: WorkerTask, signal: AbortSignal): Promise<Result> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('Irmia 计算服务已卸载');
    // 计算程序只运行发布 JS，不继承宿主的 stdin/tsx/调试启动参数。
    const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: task, execArgv: [] });
    this.live.add(worker);
    try {
      return await new Promise<Result>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: Result): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          void worker.terminate().then(() => {
            if (error !== undefined) reject(error);
            else resolve(value!);
          }, reject);
        };
        const abort = (): void => finish(new Error('Irmia 操作已取消'));
        const timer = setTimeout(() => finish(new Error(`Irmia 计算超过 ${task.timeoutMs}ms`)), task.timeoutMs);
        signal.addEventListener('abort', abort, { once: true });
        worker.once('message', (message: { value?: Result; error?: string }) => {
          if (message.error !== undefined) finish(new Error(message.error));
          else if (message.value !== undefined && typeof message.value.ok === 'boolean') finish(undefined, message.value);
          else finish(new Error('Irmia Worker 返回无效结果'));
        });
        worker.once('error', error => finish(error));
        worker.once('exit', code => {
          if (!settled) finish(new Error(`Irmia Worker 未返回结果即退出 (${code})`));
        });
        if (signal.aborted) abort();
      });
    } finally {
      this.live.delete(worker);
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.live].map(worker => worker.terminate()));
    this.live.clear();
  }
}
