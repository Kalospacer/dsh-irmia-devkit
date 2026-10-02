import type { Json, Result } from '../protocol.js';
/** 保留旧工具参数名，行号操作使用闭区间和 1-based 行号。 */
export interface EditSpec {
    old?: string;
    new?: string;
    replace_all?: boolean;
    occurrence?: number;
    align_whitespace?: boolean;
    mode?: 'replace' | 'insert_at_line' | 'delete_lines';
    line?: number;
    start_line?: number;
    end_line?: number;
}
export type MatchResult = {
    ok: true;
    text: string;
    replaced: number;
    metadata: Record<string, Json>;
} | {
    ok: false;
    result: Result;
};
/** 内存编辑计划；成功才返回候选，不读写文件。 */
export declare function applyEdit(original: string, args: EditSpec, maxBytes?: number): MatchResult;
