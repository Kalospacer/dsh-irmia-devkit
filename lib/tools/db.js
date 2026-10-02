import { defineTool } from '@deepseek-ai/dsh-tools';
import { FsError } from '@deepseek-ai/dsh-fs';
import { isAbsolute } from 'node:path';
/** 只读 SQLite 不创建文件；本地同执行世界才允许 Worker 打开数据库。 */
export function registerDbTool(ctx, files, config, tasks) {
    ctx.tools.register(defineTool({
        name: 'db_query', description: 'Read an existing local SQLite database using a read-only connection and bound parameters. Only one SELECT or query-form PRAGMA is allowed; results are bounded.',
        parameters: {
            db_path: { type: 'string', required: true }, sql: { type: 'string', required: true },
            params: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] } },
        },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        async execute(args, exec) {
            const target = await files.resolve(args.db_path, exec);
            const info = await ctx.fs.stat(target, exec.signal);
            if (info?.type !== 'file')
                throw new FsError('数据库不存在或不是普通文件', 'FS_NOT_REGULAR_FILE');
            const path = ctx.fs.processPath(target);
            if (!isAbsolute(path) || ctx.fs.processPathFromHostPath(path) !== path)
                throw new Error('SQLite 查询暂不支持非本地同执行世界 provider');
            return tasks.run({ kind: 'db', path, sql: args.sql, params: args.params ?? [], maxRows: config.dbMaxRows, maxBytes: config.dbMaxBytes, timeoutMs: config.dbTimeoutMs }, exec.signal);
        },
    }));
}
//# sourceMappingURL=db.js.map