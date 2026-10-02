import type { Context } from '@deepseek-ai/cordis';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { Settings } from '../config.js';
export interface ProcessResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
}
/** 固定检查器与恢复辅助程序的 argv 执行，禁止 shell 拼接和无沙箱回退。 */
export declare class Processes {
    private readonly ctx;
    private readonly config;
    private closed;
    private readonly live;
    constructor(ctx: Context, config: Settings);
    run(argv: string[], cwd: string, policy: SandboxExecutionPolicy | undefined, signal: AbortSignal, timeoutMs: number, input?: string): Promise<ProcessResult>;
    dispose(): Promise<void>;
}
