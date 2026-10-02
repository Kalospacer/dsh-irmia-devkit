import { extname, dirname } from 'node:path';
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess';
import { supportsInternalSyntax } from './parser.js';
/** 内部 parser 和固定外部检查器共用一条调度。 */
export class SyntaxService {
    ctx;
    config;
    tasks;
    processes;
    constructor(ctx, config, tasks, processes) {
        this.ctx = ctx;
        this.config = config;
        this.tasks = tasks;
        this.processes = processes;
    }
    async check(filename, source, exec, policy) {
        if (supportsInternalSyntax(filename))
            return this.tasks.run({ kind: 'syntax', filename, source, timeoutMs: this.config.syntaxTimeoutMs }, exec.signal);
        const suffix = extname(filename).toLowerCase();
        if (['.ps1', '.psm1', '.psd1'].includes(suffix))
            return this.powershell(filename, source, exec, policy);
        if (suffix === '.nim')
            return this.nim(filename, source, exec, policy);
        return { ok: true, skipped: true, language: `text/${suffix}`, reason: '没有适用的语法检查器' };
    }
    async powershell(filename, source, exec, policy) {
        const script = '$source=[Console]::In.ReadToEnd();$t=$null;$e=$null;'
            + '[void][System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$t,[ref]$e);'
            + 'if($e.Count -gt 0){@($e | ForEach-Object { @{line=$_.Extent.StartLineNumber;col=$_.Extent.StartColumnNumber;msg=$_.Message} }) | ConvertTo-Json -Compress;exit 1}';
        for (const executable of ['pwsh', 'powershell']) {
            try {
                const checked = await this.processes.run([executable, '-NoProfile', '-NonInteractive', '-Command', script], dirname(filename), policy, exec.signal, this.config.syntaxTimeoutMs, source);
                if (checked.exitCode === 0)
                    return { ok: true, language: 'powershell' };
                const diagnostics = checked.stdout.trim() ? JSON.parse(checked.stdout) : [{ msg: checked.stderr }];
                return { ok: false, language: 'powershell', errors: Array.isArray(diagnostics) ? diagnostics : [diagnostics] };
            }
            catch (error) {
                if (error instanceof SubprocessExecutableNotFoundError)
                    continue;
                throw error;
            }
        }
        return { ok: false, skipped: true, language: 'powershell', reason: 'pwsh/powershell 未安装' };
    }
    async nim(filename, source, exec, policy) {
        // Nim 的 stdin 模式保留实际项目工作目录，但不写候选到用户目标。
        try {
            const checked = await this.processes.run(['nim', 'check', '--verbosity:0', '--hint[Conf]:off', '-'], dirname(filename), policy, exec.signal, this.config.syntaxTimeoutMs, source);
            return checked.exitCode === 0 ? { ok: true, language: 'nim' }
                : { ok: false, language: 'nim', errors: [{ msg: checked.stderr || checked.stdout }] };
        }
        catch (error) {
            if (error instanceof SubprocessExecutableNotFoundError)
                return { ok: false, skipped: true, language: 'nim', reason: 'nim 未安装' };
            throw error;
        }
    }
}
//# sourceMappingURL=service.js.map