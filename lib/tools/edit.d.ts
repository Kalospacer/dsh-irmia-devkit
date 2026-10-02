import type { Context } from '@deepseek-ai/cordis';
import type { EditTransactions } from '../edit/transaction.js';
import type { FilePolicy } from '../dsh/policy.js';
/** 三个既有编辑工具，保留合并备份列表和多文件参数。 */
export declare function registerEditTools(ctx: Context, edits: EditTransactions, policy: FilePolicy): void;
