import { extname, relative } from 'node:path';
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { Files } from '../dsh/files.js';
import type { Settings } from '../config.js';

const extensions = new Set(['.py','.js','.mjs','.cjs','.jsx','.ts','.mts','.cts','.tsx','.go','.rs','.java','.c','.h','.cpp','.cc','.cxx','.hpp','.hh','.hxx']);
export interface SourceEntry { file: string; target: FsTarget; version: FsVersion; size: number }
export interface SourceScan { root: FsTarget; projectPath: string; entries: SourceEntry[]; truncated: boolean }

/** 只通过 provider 扫描源码身份，路径不在 Host 文件系统重新打开。 */
export async function scanProject(files: Files, config: Settings, projectDir: string, exec: ToolExecution): Promise<SourceScan> {
  const root = await files.resolve(projectDir, exec);
  const info = await files.ctx.fs.stat(root, exec.signal);
  if (info?.type !== 'directory') throw new Error('project_dir 不是目录');
  const projectPath = files.ctx.fs.processPath(root);
  const entries: SourceEntry[] = [];
  const visited = new Set<string>();
  let truncated = false;
  const visit = async (directory: FsTarget, depth: number): Promise<void> => {
    exec.signal.throwIfAborted();
    if (depth > 32 || visited.has(directory.targetKey)) return;
    visited.add(directory.targetKey);
    for (const entry of await files.ctx.fs.listDir(directory, exec.signal)) {
      if (config.indexIgnoreDirs.includes(entry.name) || !files.ctx.fs.contains(root, entry.target)) continue;
      if (entries.length >= config.indexMaxFiles) { truncated = true; return; }
      if (entry.type === 'directory') { await visit(entry.target, depth + 1); continue; }
      if (entry.type !== 'file' || !extensions.has(extname(entry.name).toLowerCase())) continue;
      const snapshot = await files.ctx.fs.stat(entry.target, exec.signal);
      if (snapshot?.type !== 'file') continue;
      const file = relative(projectPath, files.ctx.fs.processPath(entry.target)).replace(/\\/g, '/');
      entries.push({ file, target: entry.target, version: snapshot.version, size: snapshot.size ?? 0 });
    }
  };
  await visit(root, 0);
  return { root, projectPath, entries, truncated };
}
