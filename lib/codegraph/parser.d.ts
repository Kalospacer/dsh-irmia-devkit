import type { SymbolRow, ReferenceRow, ImportRow } from './store.js';
export interface Extraction {
    ok: boolean;
    skipped?: boolean;
    symbols: SymbolRow[];
    references: ReferenceRow[];
    imports: ImportRow[];
}
/** 每个符号带文件/作用域 identity；调用及导入来自语法树，不做全文正则重命名。 */
export declare function extractSymbols(file: string, source: string, timeoutMs: number): Promise<Extraction>;
