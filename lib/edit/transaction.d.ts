import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { Result } from '../protocol.js';
import type { Settings } from '../config.js';
import { Files } from '../dsh/files.js';
import { FilePolicy } from '../dsh/policy.js';
import type { EscalationArgs } from '../dsh/policy.js';
import { Processes } from '../dsh/process.js';
import { SyntaxService } from '../syntax/service.js';
import { BackupStore } from './backups.js';
import type { EditSpec } from './match.js';
export interface EditItem extends EditSpec {
    file?: string;
    filepath?: string;
}
/** 一批写入的协调者：准备、检查、提交；失败只恢复仍属于本批版本的文件。 */
export declare class EditTransactions {
    private readonly ctx;
    private readonly config;
    readonly files: Files;
    readonly policy: FilePolicy;
    readonly backups: BackupStore;
    private readonly syntax;
    private readonly processes;
    private closed;
    private readonly controllers;
    private readonly pending;
    constructor(ctx: Context, config: Settings, files: Files, policy: FilePolicy, backups: BackupStore, syntax: SyntaxService, processes: Processes);
    edit(items: EditItem[], exec: ToolExecution, args: EscalationArgs, syntaxCheck?: boolean): Promise<Result>;
    private owned;
    private run;
    rollback(filepath: string, backupName: string | undefined, list: boolean, exec: ToolExecution, args: EscalationArgs): Promise<Result>;
    private restore;
    dispose(): Promise<void>;
}
