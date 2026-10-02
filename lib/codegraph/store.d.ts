import { DatabaseSync } from 'node:sqlite';
/** 同名符号通过文件和作用域区分，不以 name 作为全局 identity。 */
export type SymbolRow = {
    id: string;
    name: string;
    qualified_name: string;
    kind: string;
    file: string;
    line: number;
    end_line: number;
    signature: string;
    source: string;
};
export type ReferenceRow = {
    from_id: string;
    target: string;
    kind: string;
    file: string;
    line: number;
};
export type ImportRow = {
    file: string;
    alias: string;
    module: string;
    symbol: string;
};
/** 一次抽取的完整记录；version/size 来自 provider 快照，用于过期判定。 */
export type ParsedFile = {
    file: string;
    version: string;
    size: number;
    symbols: SymbolRow[];
    references: ReferenceRow[];
    imports: ImportRow[];
};
/** 显式创建新索引库；查询仅打开已有库，不执行 DDL 或创建 sidecar。 */
export declare class GraphStore {
    readonly path: string;
    constructor(path: string);
    readOnly(): DatabaseSync | undefined;
    writable(): DatabaseSync;
    removeFile(db: DatabaseSync, file: string): void;
    addFile(db: DatabaseSync, parsed: ParsedFile): void;
}
