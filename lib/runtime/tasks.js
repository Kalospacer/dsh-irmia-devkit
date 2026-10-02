import { Worker } from 'node:worker_threads';
/** 单次 Worker 拥有者；取消、超时、卸载都等待同一 Worker 退出。 */
export class TaskRunner {
    live = new Set();
    closed = false;
    async run(task, signal) {
        signal.throwIfAborted();
        if (this.closed)
            throw new Error('Irmia 计算服务已卸载');
        // 计算程序只运行发布 JS，不继承宿主的 stdin/tsx/调试启动参数。
        const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: task, execArgv: [] });
        this.live.add(worker);
        try {
            return await new Promise((resolve, reject) => {
                let settled = false;
                const finish = (error, value) => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(timer);
                    signal.removeEventListener('abort', abort);
                    void worker.terminate().then(() => {
                        if (error !== undefined)
                            reject(error);
                        else
                            resolve(value);
                    }, reject);
                };
                const abort = () => finish(new Error('Irmia 操作已取消'));
                const timer = setTimeout(() => finish(new Error(`Irmia 计算超过 ${task.timeoutMs}ms`)), task.timeoutMs);
                signal.addEventListener('abort', abort, { once: true });
                worker.once('message', (message) => {
                    if (message.error !== undefined)
                        finish(new Error(message.error));
                    else if (message.value !== undefined && typeof message.value.ok === 'boolean')
                        finish(undefined, message.value);
                    else
                        finish(new Error('Irmia Worker 返回无效结果'));
                });
                worker.once('error', error => finish(error));
                worker.once('exit', code => {
                    if (!settled)
                        finish(new Error(`Irmia Worker 未返回结果即退出 (${code})`));
                });
                if (signal.aborted)
                    abort();
            });
        }
        finally {
            this.live.delete(worker);
        }
    }
    async dispose() {
        this.closed = true;
        await Promise.all([...this.live].map(worker => worker.terminate()));
        this.live.clear();
    }
}
//# sourceMappingURL=tasks.js.map