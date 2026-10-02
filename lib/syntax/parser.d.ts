import Parser from 'web-tree-sitter';
import type { Result } from '../protocol.js';
/** 返回文件适用的内部解析器，外部 PowerShell/Nim 由 DSH 进程适配器处理。 */
export declare function grammarName(filename: string): string | undefined;
/** 判断是否有内置解析路由。 */
export declare function supportsInternalSyntax(filename: string): boolean;
/** 创建拥有独立取消预算的 parser；调用者负责删除 tree 和 parser。 */
export declare function createParser(filename: string, timeoutMs: number): Promise<Parser | undefined>;
/** 在 Worker 中解析源码，不执行或编译源码；缺路由时明确跳过。 */
export declare function checkSource(filename: string, source: string, timeoutMs: number): Promise<Result>;
