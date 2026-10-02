import { extname, relative } from 'node:path';
const extensions = new Set(['.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx']);
/** 只通过 provider 扫描源码身份，路径不在 Host 文件系统重新打开。 */
export async function scanProject(files, config, projectDir, exec) {
    const root = await files.resolve(projectDir, exec);
    const info = await files.ctx.fs.stat(root, exec.signal);
    if (info?.type !== 'directory')
        throw new Error('project_dir 不是目录');
    const projectPath = files.ctx.fs.processPath(root);
    const entries = [];
    const visited = new Set();
    let truncated = false;
    const visit = async (directory, depth) => {
        exec.signal.throwIfAborted();
        if (depth > 32 || visited.has(directory.targetKey))
            return;
        visited.add(directory.targetKey);
        for (const entry of await files.ctx.fs.listDir(directory, exec.signal)) {
            if (config.indexIgnoreDirs.includes(entry.name) || !files.ctx.fs.contains(root, entry.target))
                continue;
            if (entries.length >= config.indexMaxFiles) {
                truncated = true;
                return;
            }
            if (entry.type === 'directory') {
                await visit(entry.target, depth + 1);
                continue;
            }
            if (entry.type !== 'file' || !extensions.has(extname(entry.name).toLowerCase()))
                continue;
            const snapshot = await files.ctx.fs.stat(entry.target, exec.signal);
            if (snapshot?.type !== 'file')
                continue;
            const file = relative(projectPath, files.ctx.fs.processPath(entry.target)).replace(/\\/g, '/');
            entries.push({ file, target: entry.target, version: snapshot.version, size: snapshot.size ?? 0 });
        }
    };
    await visit(root, 0);
    return { root, projectPath, entries, truncated };
}
//# sourceMappingURL=indexer.js.map