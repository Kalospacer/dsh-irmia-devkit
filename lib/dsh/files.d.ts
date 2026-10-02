import type { Context } from '@deepseek-ai/cordis';
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { Settings } from '../config.js';
import { FilePolicy } from './policy.js';
export interface FileSnapshot {
    target: FsTarget;
    path: string;
    version: FsVersion;
    bytes: Buffer;
    text: string;
    encoding: string;
}
/** 固定 BOM/UTF-8/GB18030/单字节降级，不对二进制执行文本编辑。 */
export declare function decodeSource(bytes: Uint8Array): {
    text: string;
    encoding: string;
};
/** 对原字节计算恢复时的版本证据，不替代 provider 的 opaque version。 */
export declare function byteHash(bytes: Uint8Array): string;
/** 受 rc2 文件 provider 管理的读取、观察和有版本写入。 */
export declare class Files {
    readonly ctx: Context;
    readonly config: Settings;
    readonly policy: FilePolicy;
    constructor(ctx: Context, config: Settings, policy: FilePolicy);
    resolve(path: string, exec: ToolExecution): Promise<FsTarget>;
    projectDir(exec: ToolExecution): Promise<string>;
    read(target: FsTarget, exec: ToolExecution, signal?: AbortSignal, observe?: boolean): Promise<FileSnapshot>;
    /** 先读已有观察意图，避免用工具内部读覆盖调用者早先的陈旧观察。 */
    editSnapshot(target: FsTarget, exec: ToolExecution): Promise<FileSnapshot>;
    write(snapshot: FileSnapshot, content: string, version: FsVersion, exec: ToolExecution, policy: SandboxExecutionPolicy | undefined, signal?: AbortSignal): Promise<FsVersion>;
}
