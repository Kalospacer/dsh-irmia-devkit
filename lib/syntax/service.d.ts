import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { Settings } from '../config.js';
import type { Result } from '../protocol.js';
import { TaskRunner } from '../runtime/tasks.js';
import { Processes } from '../dsh/process.js';
/** 内部 parser 和固定外部检查器共用一条调度。 */
export declare class SyntaxService {
    private readonly ctx;
    private readonly config;
    private readonly tasks;
    private readonly processes;
    constructor(ctx: Context, config: Settings, tasks: TaskRunner, processes: Processes);
    check(filename: string, source: string, exec: ToolExecution, policy: SandboxExecutionPolicy | undefined): Promise<Result>;
    private powershell;
    private nim;
}
