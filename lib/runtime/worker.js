import { parentPort, workerData } from 'node:worker_threads';
import { checkSource } from '../syntax/parser.js';
import { extractSymbols } from '../codegraph/parser.js';
import { errorMessage } from '../protocol.js';
/** 固定请求操作，无模块名或任意脚本执行入口。 */
const task = workerData;
try {
    if (!Number.isInteger(task.timeoutMs) || task.timeoutMs <= 0)
        throw new Error('Irmia Worker 收到无效时间预算');
    if (task.kind === 'graph') {
        if (typeof task.path !== 'string')
            throw new Error('无效索引库请求');
        const { graphOperation } = await import('../codegraph/worker.js');
        parentPort?.postMessage({ value: graphOperation(task) });
    }
    else if (task.kind === 'db') {
        if (typeof task.path !== 'string' || typeof task.sql !== 'string' || !Array.isArray(task.params)
            || !Number.isInteger(task.maxRows) || task.maxRows <= 0 || !Number.isInteger(task.maxBytes) || task.maxBytes <= 0)
            throw new Error('无效数据库请求');
        const { queryDatabase } = await import('../db/query.js');
        parentPort?.postMessage({ value: queryDatabase(task) });
    }
    else if (task.kind === 'syntax' || task.kind === 'index') {
        if (typeof task.filename !== 'string' || typeof task.source !== 'string')
            throw new Error('无效解析请求');
        if (task.kind === 'syntax')
            parentPort?.postMessage({ value: await checkSource(task.filename, task.source, task.timeoutMs) });
        else
            parentPort?.postMessage({ value: await extractSymbols(task.filename, task.source, task.timeoutMs) });
    }
    else
        throw new Error('Irmia Worker 操作不存在');
}
catch (error) {
    parentPort?.postMessage({ error: errorMessage(error) });
}
finally {
    parentPort?.close();
}
//# sourceMappingURL=worker.js.map