import type { Context } from '@deepseek-ai/cordis';
import type { Files } from '../dsh/files.js';
import type { Settings } from '../config.js';
import type { TaskRunner } from '../runtime/tasks.js';
/** 只读 SQLite 不创建文件；本地同执行世界才允许 Worker 打开数据库。 */
export declare function registerDbTool(ctx: Context, files: Files, config: Settings, tasks: TaskRunner): void;
