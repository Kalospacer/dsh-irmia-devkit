import type { Context } from '@deepseek-ai/cordis';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import { classifyRunnerFailure, matchesSignature, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox';
import type {} from '@deepseek-ai/dsh-subprocess';
import type { Settings } from '../config.js';

export interface ProcessResult { exitCode: number | null; stdout: string; stderr: string }

/** 固定检查器与恢复辅助程序的 argv 执行，禁止 shell 拼接和无沙箱回退。 */
export class Processes {
  private closed = false;
  private readonly live = new Set<import('@deepseek-ai/dsh-subprocess').SubprocessHandle>();
  constructor(private readonly ctx: Context, private readonly config: Settings) {}

  async run(argv: string[], cwd: string, policy: SandboxExecutionPolicy | undefined, signal: AbortSignal,
            timeoutMs: number, input?: string): Promise<ProcessResult> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('Irmia 进程服务已卸载');
    const subprocess = this.ctx.get('subprocess');
    if (subprocess === undefined) throw new Error('此操作需要 DSH subprocess 服务');
    const executable = await subprocess.resolveExecutable(argv[0]!, undefined, signal);
    let command = [executable, ...argv.slice(1)];
    let confined: Awaited<ReturnType<import('@deepseek-ai/dsh-sandbox').SandboxProvider['confine']>> | undefined;
    if (policy !== undefined && policy.mode !== 'danger-full-access') {
      const sandbox = this.ctx.get('sandbox');
      if (sandbox === undefined) throw new Error('请求受限进程但缺少 DSH sandbox 服务，拒绝无沙箱执行');
      confined = await sandbox.confine(command, { ...policy, mode: policy.mode }, signal);
      command = confined.argv;
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Irmia 进程超时')), timeoutMs);
    let handle: import('@deepseek-ai/dsh-subprocess').SubprocessHandle | undefined;
    try {
      if (signal.aborted) abort();
      handle = subprocess.spawn({
        argv: command, cwd, signal: controller.signal, graceMs: this.config.processGraceMs,
        stdio: { stdin: input === undefined ? 'ignore' : { data: input }, stdout: { maxBytes: this.config.maxEditBytes * 2 + 4096 }, stderr: { maxBytes: 32 * 1024 } },
      });
      this.live.add(handle);
      const outcome = await handle.done;
      if (controller.signal.aborted) throw new Error(signal.aborted ? 'Irmia 进程已取消' : 'Irmia 进程超时');
      const stdout = handle.collected.stdout!.readFrom(0);
      const stderr = handle.collected.stderr!.readFrom(0);
      if (stdout.lossy) throw new Error('检查器输出超过上限，不能将截断数据当完整结果');
      if (confined !== undefined) {
        const runnerFailure = classifyRunnerFailure(outcome.exitCode, stderr.text, confined.runnerFailureRules);
        if (runnerFailure) throw new Error('DSH 沙箱启动器失败: ' + stderr.text);
        if (outcome.exitCode !== 0 && matchesSignature(outcome.exitCode, stderr.text, confined.denialSignatures)) throw new Error(sandboxDenialMarker(policy!.mode));
      }
      return { exitCode: outcome.exitCode, stdout: stdout.text, stderr: stderr.text };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (handle !== undefined) {
        handle.terminate();
        await handle.waitForExit(AbortSignal.timeout(this.config.processGraceMs * 2));
        this.live.delete(handle);
      }
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const handle of this.live) handle.terminate();
    await Promise.all([...this.live].map(handle => handle.waitForExit(AbortSignal.timeout(this.config.processGraceMs * 2))));
    this.live.clear();
  }
}
