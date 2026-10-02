import type { Result } from '../protocol.js';
import type { ParsedFile } from './store.js';
/** 索引 SQL、FTS 与引用解析都在可终止的 Worker 内完成。 */
export interface GraphRequest {
    kind: 'graph';
    path: string;
    operation: 'inspect' | 'commit' | 'explore' | 'impact' | 'status';
    timeoutMs: number;
    /** 本次抽取成功的文件记录。 */
    parsed?: ParsedFile[];
    /** 本次扫描实际看到的全部文件；扫描被截断时省略，避免误删未看到的旧记录。 */
    present?: string[];
    /** 超限、无解析路由或已失效的文件，其旧记录必须清除。 */
    invalidFiles?: string[];
    /** 全量重建：先清空已知文件再写入。 */
    full?: boolean;
    query?: string;
    filepaths?: string[];
    maxDepth?: number;
}
/** 只写调用者指定的内部派生库；查询绝不隐式建库。 */
export declare function graphOperation(request: GraphRequest): Result;
