import { join } from 'node:path';
import type { FsTarget } from '@deepseek-ai/dsh-fs';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { Json, Result } from '../protocol.js';
import { failure } from '../protocol.js';
import type { Settings } from '../config.js';
import type { Files } from '../dsh/files.js';
import type { FilePolicy } from '../dsh/policy.js';
import type { TaskRunner } from '../runtime/tasks.js';
import { scanProject } from './indexer.js';
import type { ImportRow, ParsedFile, ReferenceRow, SymbolRow } from './store.js';

/** 派生库里记录的文件身份，用于增量跳过和过期判定。 */
type IndexedFile = { file: string; version: string; size: number };
/** 索引库操作参数；path 由服务按项目分区计算，模型无法指定。 */
type GraphOperation = {
  operation: 'inspect' | 'commit' | 'explore' | 'impact' | 'status';
  path: string; parsed?: ParsedFile[]; present?: string[]; invalidFiles?: string[]; full?: boolean;
  query?: string; filepaths?: string[]; maxDepth?: number;
};

/** Worker 结果是 JSON 值，这里只做形状收敛，不改变任何字段。 */
function asRows<T>(value: Json | undefined): T[] {
  return Array.isArray(value) ? value as unknown as T[] : [];
}

/** 状态抽查上限：全库逐文件比对版本会退化成又一轮扫描。 */
const STATUS_SAMPLE = 50;

/** 索引状态的拥有者；只有 code_index 会写入插件内部派生库。 */
export class CodeGraphService {
  constructor(
    private readonly files: Files, private readonly policy: FilePolicy,
    private readonly tasks: TaskRunner, private readonly config: Settings,
  ) {}

  private dbPath(projectPath: string): string {
    return join(this.config.stateDir, 'codegraph', encodeURIComponent(projectPath), 'graph.sqlite');
  }

  private run(request: GraphOperation, exec: ToolExecution): Promise<Result> {
    return this.tasks.run({ kind: 'graph', timeoutMs: this.config.indexTimeoutMs, ...request }, exec.signal);
  }

  /** 组合项目目录与库内相对路径，仍由 provider 决定最终身份。 */
  private async locate(projectDir: string, file: string, exec: ToolExecution): Promise<FsTarget> {
    return this.files.resolve(`${projectDir.replace(/[\\/]+$/, '')}/${file}`, exec);
  }

  /** 逐个比对 provider 版本；文件已消失也计入过期。 */
  private async stale(root: FsTarget, projectDir: string, recorded: Map<string, string>, files: string[], exec: ToolExecution): Promise<number> {
    let stale = 0;
    for (const file of new Set(files)) {
      const version = recorded.get(file);
      if (version === undefined) continue;
      const target = await this.locate(projectDir, file, exec);
      if (!this.files.ctx.fs.contains(root, target)) continue;
      const info = await this.files.ctx.fs.stat(target, exec.signal).catch(() => undefined);
      if (info?.type !== 'file' || String(info.version) !== version) stale++;
    }
    return stale;
  }

  private staleNote(count: number): Record<string, Json> {
    if (count <= 0) return {};
    return {
      index_stale: true,
      stale_warning: `${count} 个文件在索引后被修改，行号与调用位置可能已漂移，建议 code_index(incremental=true) 后重查`,
    };
  }

  /** 读取已有索引的文件版本地图；索引不存在时明确报告，而不隐式建库。 */
  private async versions(path: string, exec: ToolExecution): Promise<{ present: boolean; files: IndexedFile[] }> {
    const inspected = await this.run({ operation: 'inspect', path }, exec);
    return { present: inspected.index_present === true, files: asRows<IndexedFile>(inspected.files) };
  }

  /** 显式重建或增量更新索引；任何失败都不留下半份索引。 */
  async index(projectDir: string, incremental: boolean, exec: ToolExecution): Promise<Result> {
    const policy = await this.policy.resolve('code_index', {}, exec);
    this.policy.assertMutable(policy);
    const scan = await scanProject(this.files, this.config, projectDir, exec);
    const path = this.dbPath(scan.projectPath);
    const known = new Map((await this.versions(path, exec)).files.map(row => [row.file, row]));
    const parsed: ParsedFile[] = [];
    const invalidFiles: string[] = [];
    let skipped = 0;
    let unchanged = 0;
    let parseErrors = 0;
    for (const entry of scan.entries) {
      exec.signal.throwIfAborted();
      const old = known.get(entry.file);
      const version = String(entry.version);
      if (incremental && old !== undefined && old.version === version && old.size === entry.size) { unchanged++; continue; }
      if (entry.size > this.config.indexMaxFileBytes) { skipped++; invalidFiles.push(entry.file); continue; }
      const source = await this.files.read(entry.target, exec, exec.signal, false);
      const extraction = await this.tasks.run(
        { kind: 'index', filename: entry.file, source: source.text, timeoutMs: this.config.indexTimeoutMs }, exec.signal);
      if (extraction.skipped === true || !Array.isArray(extraction.symbols)) { skipped++; invalidFiles.push(entry.file); continue; }
      // 语法有错的文件仍记录已识别的符号；错误数量单独报告，调用者据此判断可信度。
      if (extraction.ok !== true) parseErrors++;
      parsed.push({
        file: entry.file, version, size: entry.size,
        symbols: asRows<SymbolRow>(extraction.symbols),
        references: asRows<ReferenceRow>(extraction.references),
        imports: asRows<ImportRow>(extraction.imports),
      });
    }
    // 扫描被截断时既不传 present 也不清库，避免把没看到的旧文件当作已删除。
    const commit = await this.run({
      operation: 'commit', path, parsed, invalidFiles, full: !incremental && !scan.truncated,
      ...(scan.truncated ? {} : { present: scan.entries.map(entry => entry.file) }),
    }, exec);
    if (commit.ok !== true) return commit;
    const totals = await this.run({ operation: 'status', path }, exec);
    return {
      ...totals, ok: true, operation: incremental ? 'incremental' : 'full', project_dir: scan.projectPath,
      files_seen: scan.entries.length, scan_truncated: scan.truncated,
      files_indexed: parsed.length, files_unchanged: unchanged, files_skipped: skipped,
      files_with_parse_errors: parseErrors, invalid_files: invalidFiles.slice(0, 50),
    };
  }

  /** 符号/调用链查询；索引不存在时给出可执行的下一步。 */
  async explore(projectDir: string, query: string, exec: ToolExecution): Promise<Result> {
    const root = await this.files.resolve(projectDir, exec);
    const path = this.dbPath(this.files.ctx.fs.processPath(root));
    const inspected = await this.versions(path, exec);
    if (!inspected.present) return failure('索引尚未建立', { options: [{ tool: 'code_index', params: { project_dir: projectDir } }] });
    const result = await this.run({ operation: 'explore', path, query }, exec);
    if (result.ok !== true) return result;
    const recorded = new Map(inspected.files.map(row => [row.file, row.version]));
    const files = collectFiles(result);
    const stale = await this.stale(root, projectDir, recorded, files, exec);
    return { ...result, project_dir: this.files.ctx.fs.processPath(root), path_note: 'file 为项目相对路径，调用 safe_read/safe_edit 前请与 project_dir 拼接', ...this.staleNote(stale) };
  }

  /** 反向最短深度 BFS；静态近似，动态调用可能缺失。 */
  async impact(projectDir: string, filepaths: string[], maxDepth: number, exec: ToolExecution): Promise<Result> {
    const root = await this.files.resolve(projectDir, exec);
    const path = this.dbPath(this.files.ctx.fs.processPath(root));
    const inspected = await this.versions(path, exec);
    if (!inspected.present) return failure('索引尚未建立', { options: [{ tool: 'code_index', params: { project_dir: projectDir } }] });
    const result = await this.run({ operation: 'impact', path, filepaths, maxDepth }, exec);
    if (result.ok !== true) return result;
    const recorded = new Map(inspected.files.map(row => [row.file, row.version]));
    const stale = await this.stale(root, projectDir, recorded, collectFiles(result), exec);
    return { ...result, project_dir: this.files.ctx.fs.processPath(root), ...this.staleNote(stale) };
  }

  /** 索引健康检查；只读已有库，抽查有界数量的文件版本。 */
  async status(projectDir: string, exec: ToolExecution): Promise<Result> {
    const root = await this.files.resolve(projectDir, exec);
    const projectPath = this.files.ctx.fs.processPath(root);
    const result = await this.run({ operation: 'status', path: this.dbPath(projectPath) }, exec);
    if (result.ok !== true) return failure('索引尚未建立', { index_present: false, project_dir: projectPath, options: [{ tool: 'code_index', params: { project_dir: projectDir } }] });
    const files = asRows<IndexedFile>(result.files).slice(0, STATUS_SAMPLE);
    const stale = await this.stale(root, projectDir, new Map(files.map(row => [row.file, row.version])), files.map(row => row.file), exec);
    return { ...result, project_dir: projectPath, files_checked: files.length, stale_files: stale, ...this.staleNote(stale) };
  }
}

/** 收集结果里出现的项目相对文件路径，供过期比对使用。 */
function collectFiles(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'file' && typeof item === 'string') found.add(item);
      else visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return [...found];
}
