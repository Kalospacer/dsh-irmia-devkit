import type { Context } from '@deepseek-ai/cordis';
import { FsError } from '@deepseek-ai/dsh-fs';
import type { FsVersion } from '@deepseek-ai/dsh-fs';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import { fileURLToPath } from 'node:url';
import { failure, errorMessage } from '../protocol.js';
import type { Result, Json } from '../protocol.js';
import type { Settings } from '../config.js';
import { Files, byteHash } from '../dsh/files.js';
import type { FileSnapshot } from '../dsh/files.js';
import { FilePolicy } from '../dsh/policy.js';
import type { EscalationArgs } from '../dsh/policy.js';
import { Processes } from '../dsh/process.js';
import { SyntaxService } from '../syntax/service.js';
import { BackupStore } from './backups.js';
import { applyEdit } from './match.js';
import type { EditSpec } from './match.js';

export interface EditItem extends EditSpec { file?: string; filepath?: string }
interface Plan { snapshot: FileSnapshot; content: string; backup?: string; writtenVersion?: FsVersion; metadata: Record<string, Json> }

/** 一批写入的协调者：准备、检查、提交；失败只恢复仍属于本批版本的文件。 */
export class EditTransactions {
  private closed = false;
  private readonly controllers = new Set<AbortController>();
  private readonly pending = new Set<Promise<Result>>();
  constructor(private readonly ctx: Context, private readonly config: Settings, readonly files: Files,
              readonly policy: FilePolicy, readonly backups: BackupStore,
              private readonly syntax: SyntaxService, private readonly processes: Processes) {}

  async edit(items: EditItem[], exec: ToolExecution, args: EscalationArgs, syntaxCheck = true): Promise<Result> {
    return this.owned(exec, current => this.run(items, current, args, syntaxCheck));
  }

  private owned(exec: ToolExecution, run: (exec: ToolExecution) => Promise<Result>): Promise<Result> {
    if (this.closed) return Promise.reject(new Error('Irmia 编辑服务已卸载'));
    exec.signal.throwIfAborted();
    const controller = new AbortController();
    const abort = (): void => controller.abort(exec.signal.reason);
    exec.signal.addEventListener('abort', abort, { once: true });
    this.controllers.add(controller);
    if (exec.signal.aborted) abort();
    const task = run({ ...exec, signal: controller.signal }).finally(() => {
      this.controllers.delete(controller);
      exec.signal.removeEventListener('abort', abort);
      this.pending.delete(task);
    });
    this.pending.add(task);
    return task;
  }

  private async run(items: EditItem[], exec: ToolExecution, args: EscalationArgs, syntaxCheck: boolean): Promise<Result> {
    if (items.length === 0) return failure('edits 至少包含一项');
    const policy = await this.policy.resolve(exec.name, args, exec);
    this.policy.assertMutable(policy);
    const project = await this.files.projectDir(exec);
    const plans = new Map<string, Plan>();
    const operations: Json[] = [];
    for (const [index, item] of items.entries()) {
      exec.signal.throwIfAborted();
      const path = item.file || item.filepath;
      if (!path) return failure(`edit #${index + 1} 缺少 file/filepath`);
      const target = await this.files.resolve(path, exec);
      await this.policy.assertWritable(target, policy);
      this.backups.assertOutsideProject(project, this.ctx.fs.processPath(target));
      let plan = plans.get(target.targetKey);
      if (plan === undefined) {
        const snapshot = await this.files.editSnapshot(target, exec);
        plan = { snapshot, content: snapshot.text, metadata: {} };
        plans.set(target.targetKey, plan);
      }
      const changed = applyEdit(plan.content, item, this.config.maxEditBytes);
      if (!changed.ok) return { ...changed.result, applied: [], total_requested: items.length, total_applied: 0, unchanged: true };
      plan.content = changed.text;
      Object.assign(plan.metadata, changed.metadata);
      operations.push({ file: plan.snapshot.path, edit: index + 1, replaced: changed.replaced, ...changed.metadata });
    }
    const checks: Record<string, Json> = {};
    const protectedNames = new Set<string>();
    // 快照对应读取版本；提交时再次由 provider 的 guard 拒绝外部变更。
    for (const plan of plans.values()) {
      exec.signal.throwIfAborted();
      plan.backup = await this.backups.save(plan.snapshot.path, plan.snapshot.bytes);
      protectedNames.add(plan.backup);
    }
    if (syntaxCheck) {
      for (const plan of plans.values()) {
        const result = await this.syntax.check(plan.snapshot.path, plan.content, exec, policy);
        checks[plan.snapshot.path] = result;
        if (!result.ok && !result.skipped) return failure('候选内容语法检查失败，目标文件未写入', {
          syntax_check: result, syntax_checks: checks, syntax_ok: false, unchanged: true, rolled_back: false,
          applied: [], total_requested: items.length, total_applied: 0,
          backups: Object.fromEntries([...plans.values()].map(entry => [entry.snapshot.path, entry.backup!])),
        });
      }
    }
    const committed: Plan[] = [];
    try {
      for (const plan of plans.values()) {
        exec.signal.throwIfAborted();
        plan.writtenVersion = await this.files.write(plan.snapshot, plan.content, plan.snapshot.version, exec, policy);
        committed.push(plan);
      }
    } catch (error: unknown) {
      if (committed.length === 0) throw error;
      const rollbackErrors: Json[] = [];
      const recovery = AbortSignal.timeout(this.config.recoveryTimeoutMs);
      for (const plan of committed.slice().reverse()) {
        try { await this.restore(plan.snapshot, plan.snapshot.bytes, plan.writtenVersion!, exec, policy, recovery); }
        catch (recoveryError: unknown) { rollbackErrors.push({ file: plan.snapshot.path, error: errorMessage(recoveryError) }); }
      }
      return failure(`批量提交失败: ${errorMessage(error)}`, {
        rolled_back_all: rollbackErrors.length === 0, rolled_back: rollbackErrors.length === 0,
        rollback_errors: rollbackErrors, applied: committed.map(plan => plan.snapshot.path),
        total_requested: items.length, total_applied: committed.length,
        backups: Object.fromEntries([...plans.values()].map(plan => [plan.snapshot.path, plan.backup!])),
      });
    }
    let cleanupWarning: string | undefined;
    try { await this.backups.prune(protectedNames); }
    catch (error: unknown) { cleanupWarning = errorMessage(error); }
    const skipped = !syntaxCheck || Object.values(checks).some(result => result !== null && typeof result === 'object' && !Array.isArray(result) && result.skipped === true);
    return {
      ok: true, applied: committed.map(plan => plan.snapshot.path), total_requested: items.length, total_applied: items.length,
      replacements_made: operations.reduce<number>((sum, operation) => sum + (typeof operation === 'object' && operation !== null && !Array.isArray(operation) && typeof operation.replaced === 'number' ? operation.replaced : 0), 0),
      backups: Object.fromEntries([...plans.values()].map(plan => [plan.snapshot.path, plan.backup!])),
      syntax_checks: checks, syntax_ok: skipped ? null : true, plan: operations,
      diffs: [...plans.values()].map(plan => ({ path: plan.snapshot.path, oldText: plan.snapshot.text, newText: plan.content })),
      ...(cleanupWarning === undefined ? {} : { cleanup_warning: cleanupWarning }),
    };
  }

  async rollback(filepath: string, backupName: string | undefined, list: boolean, exec: ToolExecution, args: EscalationArgs): Promise<Result> {
    const target = await this.files.resolve(filepath, exec);
    const path = this.ctx.fs.processPath(target);
    if (list) return this.backups.list(path);
    return this.owned(exec, async current => {
      const policy = await this.policy.resolve(current.name, args, current);
      this.policy.assertMutable(policy);
      await this.policy.assertWritable(target, policy);
      this.backups.assertOutsideProject(await this.files.projectDir(current), path);
      const snapshot = await this.files.editSnapshot(target, current);
      const saved = await this.backups.load(path, backupName);
      const prior = await this.backups.save(path, snapshot.bytes);
      await this.restore(snapshot, saved.bytes, snapshot.version, current, policy, current.signal);
      return { ok: true, file: path, restored_from: saved.name, prerollback_backup: prior, restored_bytes: saved.bytes.length };
    });
  }

  private async restore(snapshot: FileSnapshot, bytes: Buffer, expected: FsVersion, exec: ToolExecution,
                        policy: SandboxExecutionPolicy | undefined, signal: AbortSignal): Promise<void> {
    const current = await this.ctx.fs.stat(snapshot.target, signal);
    if (current?.version !== expected) throw new FsError('恢复目标已被其他操作修改，保留备份并停止覆盖', 'FS_STALE_VERSION');
    let utf8: string | undefined;
    try { utf8 = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (error: unknown) {
      // 仅解码失败选择字节恢复，provider 写入失败不能改通道绕过。
      if (!(error instanceof TypeError)) throw error;
    }
    if (utf8 !== undefined && !utf8.includes('\0')) {
      await this.files.write(snapshot, utf8, expected, exec, policy, signal);
      return;
    }
    const helperHost = fileURLToPath(new URL('../dsh/restore-helper.js', import.meta.url));
    const helper = this.ctx.fs.processPathFromHostPath(helperHost);
    if (helper === undefined) throw new Error('当前执行世界不能访问原始字节恢复程序');
    const actual = await this.ctx.fs.readBytes(snapshot.target, signal, this.config.maxEditBytes);
    if ((await this.ctx.fs.stat(snapshot.target, signal))?.version !== expected) throw new FsError('恢复前目标发生变化', 'FS_STALE_VERSION');
    const result = await this.processes.run([process.execPath, helper], await this.files.projectDir(exec), policy, signal,
      this.config.recoveryTimeoutMs, JSON.stringify({ path: snapshot.path, expectedSha256: byteHash(actual), contentBase64: bytes.toString('base64'), maxBytes: this.config.maxEditBytes }));
    if (result.exitCode !== 0) throw new Error('原始字节恢复失败: ' + result.stderr);
    const restored = await this.ctx.fs.readBytes(snapshot.target, signal, this.config.maxEditBytes);
    if (byteHash(restored) !== byteHash(bytes)) throw new Error('恢复后的字节校验失败');
    const info = await this.ctx.fs.stat(snapshot.target, signal);
    if (info !== undefined) this.ctx.emit('fs/observed', snapshot.target, { kind: 'present', version: info.version }, exec);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers) controller.abort(new Error('编辑服务卸载'));
    await Promise.allSettled([...this.pending]);
  }
}
