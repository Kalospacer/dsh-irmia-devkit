import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { resolve, isAbsolute } from 'node:path';
export const Config = z.object({
    stateDir: z.string().default(resolve(process.env.DSH_PROFILE_DIR ?? resolve(homedir(), '.dsh'), 'plugin-state', 'irmia-devkit')),
    legacyBackupDir: z.string().default(''),
    enabledGroups: z.array(z.string()).default(['edit', 'syntax', 'http', 'codegraph', 'db']),
    maxEditBytes: z.number().default(20 * 1024 * 1024),
    backupRetention: z.number().default(10), maxBackupBytes: z.number().default(500 * 1024 * 1024),
    syntaxTimeoutMs: z.number().default(30_000), recoveryTimeoutMs: z.number().default(10_000), processGraceMs: z.number().default(1000),
    httpTimeoutMs: z.number().default(15_000), httpMaxBytes: z.number().default(5 * 1024 * 1024), httpPageChars: z.number().default(8000),
    cacheTtlMs: z.number().default(300_000), cacheEntries: z.number().default(10),
    indexMaxFileBytes: z.number().default(1024 * 1024), indexMaxFiles: z.number().default(10_000),
    indexIgnoreDirs: z.array(z.string()).default(['.git', '.codegraph', '.venv', 'venv', 'node_modules', 'dist', 'build', '__pycache__']),
    indexTimeoutMs: z.number().default(120_000),
    dbMaxRows: z.number().default(200), dbTimeoutMs: z.number().default(10_000), dbMaxBytes: z.number().default(128 * 1024),
});
/** 独立 Config 约束尽早失败，不自动忽略旧 pythonPath 配置。 */
export function resolveSettings(config) {
    if ('pythonPath' in config)
        throw new Error('pythonPath 已移除；原生版不再使用 Python，请删除此配置');
    if (!isAbsolute(config.stateDir) || (config.legacyBackupDir !== '' && !isAbsolute(config.legacyBackupDir)))
        throw new Error('stateDir/legacyBackupDir 必须是绝对路径');
    for (const [name, value] of Object.entries(config)) {
        if (typeof value === 'number' && (!Number.isInteger(value) || value < 1 || value > 2_147_483_647))
            throw new Error(`${name} 必须是有效的正整数`);
    }
    for (const group of config.enabledGroups) {
        if (!['edit', 'syntax', 'http', 'codegraph', 'db'].includes(group))
            throw new Error(`未知工具组: ${group}`);
    }
    return config;
}
//# sourceMappingURL=config.js.map