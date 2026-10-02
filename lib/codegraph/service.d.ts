import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { Result } from '../protocol.js';
import type { Settings } from '../config.js';
import type { Files } from '../dsh/files.js';
import type { FilePolicy } from '../dsh/policy.js';
import type { TaskRunner } from '../runtime/tasks.js';
/** 索引状态的拥有者；只有 code_index 会写入插件内部派生库。 */
export declare class CodeGraphService {
    private readonly files;
    private readonly policy;
    private readonly tasks;
    private readonly config;
    constructor(files: Files, policy: FilePolicy, tasks: TaskRunner, config: Settings);
    private dbPath;
    private run;
    /** 组合项目目录与库内相对路径，仍由 provider 决定最终身份。 */
    private locate;
    /** 逐个比对 provider 版本；文件已消失也计入过期。 */
    private stale;
    private staleNote;
    /** 读取已有索引的文件版本地图；索引不存在时明确报告，而不隐式建库。 */
    private versions;
    /** 显式重建或增量更新索引；任何失败都不留下半份索引。 */
    index(projectDir: string, incremental: boolean, exec: ToolExecution): Promise<Result>;
    /** 符号/调用链查询；索引不存在时给出可执行的下一步。 */
    explore(projectDir: string, query: string, exec: ToolExecution): Promise<Result>;
    /** 反向最短深度 BFS；静态近似，动态调用可能缺失。 */
    impact(projectDir: string, filepaths: string[], maxDepth: number, exec: ToolExecution): Promise<Result>;
    /** 索引健康检查；只读已有库，抽查有界数量的文件版本。 */
    status(projectDir: string, exec: ToolExecution): Promise<Result>;
}
