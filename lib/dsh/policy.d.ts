import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { FsTarget } from '@deepseek-ai/dsh-fs';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
/** 仅在受限组合中公开的单次审批参数。 */
export interface EscalationArgs {
    sandbox_permissions?: string;
    justification?: string;
}
/** 每次调用从会话解析政策，文件服务仍是实际写入的最终裁决者。 */
export declare class FilePolicy {
    private readonly ctx;
    readonly confined: boolean;
    constructor(ctx: Context);
    schemaFields(): {
        readonly sandbox_permissions: {
            readonly type: "string";
            readonly enum: readonly ["workspace-write", "danger-full-access"];
            readonly description: string;
        };
        readonly justification: {
            readonly type: "string";
            readonly description: "申请更宽权限时说明本次操作的理由。";
        };
    };
    resolve(toolName: string, args: EscalationArgs, exec: ToolExecution): Promise<SandboxExecutionPolicy | undefined>;
    assertMutable(policy: SandboxExecutionPolicy | undefined): void;
    assertWritable(target: FsTarget, policy: SandboxExecutionPolicy | undefined): Promise<void>;
    private denial;
    mapError(error: unknown, policy: SandboxExecutionPolicy | undefined): unknown;
}
/** 插件内部状态不能位于被编辑项目内，也不能成为被编辑文件的父子路径别名。 */
export declare function isWithin(root: string, path: string): boolean;
