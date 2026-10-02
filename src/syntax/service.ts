import { extname, dirname } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess';
import type { Settings } from '../config.js';
import type { Result, Json } from '../protocol.js';
import { TaskRunner } from '../runtime/tasks.js';
import { supportsInternalSyntax } from './parser.js';
import { Processes } from '../dsh/process.js';

/** 内部 parser 和固定外部检查器共用一条调度。 */
export class SyntaxService {
  constructor(private readonly ctx: Context, private readonly config: Settings, private readonly tasks: TaskRunner, private readonly processes: Processes) {}

  async check(filename: string, source: string, exec: ToolExecution, policy: SandboxExecutionPolicy | undefined): Promise<Result> {
    if (supportsInternalSyntax(filename)) return this.tasks.run({ kind: 'syntax', filename, source, timeoutMs: this.config.syntaxTimeoutMs }, exec.signal);
    const suffix = extname(filename).toLowerCase();
    if (['.ps1', '.psm1', '.psd1'].includes(suffix)) return this.powershell(filename, source, exec, policy);
    if (suffix === '.nim') return this.nim(filename, source, exec, policy);
    return { ok: true, skipped: true, language: `text/${suffix}`, reason: '没有适用的语法检查器' };
  }

  private async powershell(filename: string, source: string, exec: ToolExecution, policy: SandboxExecutionPolicy | undefined): Promise<Result> {
    const script = '$source=[Console]::In.ReadToEnd();$t=$null;$e=$null;'
      + '[void][System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$t,[ref]$e);'
      + 'if($e.Count -gt 0){@($e | ForEach-Object { @{line=$_.Extent.StartLineNumber;col=$_.Extent.StartColumnNumber;msg=$_.Message} }) | ConvertTo-Json -Compress;exit 1}';
    for (const executable of ['pwsh', 'powershell']) {
      try {
        const checked = await this.processes.run([executable, '-NoProfile', '-NonInteractive', '-Command', script], dirname(filename), policy, exec.signal, this.config.syntaxTimeoutMs, source);
        if (checked.exitCode === 0) return { ok: true, language: 'powershell' };
        const diagnostics: Json = checked.stdout.trim() ? JSON.parse(checked.stdout) : [{ msg: checked.stderr }];
        return { ok: false, language: 'powershell', errors: Array.isArray(diagnostics) ? diagnostics : [diagnostics] };
      } catch (error: unknown) {
        if (error instanceof SubprocessExecutableNotFoundError) continue;
        throw error;
      }
    }
    return { ok: false, skipped: true, language: 'powershell', reason: 'pwsh/powershell 未安装' };
  }

  private async nim(filename: string, source: string, exec: ToolExecution, policy: SandboxExecutionPolicy | undefined): Promise<Result> {
    // Nim 的 stdin 模式保留实际项目工作目录，但不写候选到用户目标。
    try {
      const checked = await this.processes.run(['nim', 'check', '--verbosity:0', '--hint[Conf]:off', '-'], dirname(filename), policy, exec.signal, this.config.syntaxTimeoutMs, source);
      return checked.exitCode === 0 ? { ok: true, language: 'nim' }
        : { ok: false, language: 'nim', errors: [{ msg: checked.stderr || checked.stdout }] };
    } catch (error: unknown) {
      if (error instanceof SubprocessExecutableNotFoundError) return { ok: false, skipped: true, language: 'nim', reason: 'nim 未安装' };
      throw error;
    }
  }
}
