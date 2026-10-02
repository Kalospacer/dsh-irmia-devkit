import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { Files } from '../dsh/files.js';
import type { Settings } from '../config.js';
export interface SourceEntry {
    file: string;
    target: FsTarget;
    version: FsVersion;
    size: number;
}
export interface SourceScan {
    root: FsTarget;
    projectPath: string;
    entries: SourceEntry[];
    truncated: boolean;
}
/** 只通过 provider 扫描源码身份，路径不在 Host 文件系统重新打开。 */
export declare function scanProject(files: Files, config: Settings, projectDir: string, exec: ToolExecution): Promise<SourceScan>;
