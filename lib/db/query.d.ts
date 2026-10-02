import type { Result } from '../protocol.js';
/** 去除注释并识别字符串内分号；单条 SELECT/查询型 PRAGMA，不接受追加语句。 */
export declare function validateSql(sql: string): string | undefined;
export interface QueryRequest {
    path: string;
    sql: string;
    params: (string | number | null)[];
    maxRows: number;
    maxBytes: number;
    timeoutMs: number;
}
/** 固定 Worker 请求，只读引擎、query_only 和不加载扩展形成实际写入约束。 */
export declare function queryDatabase(request: QueryRequest): Result;
