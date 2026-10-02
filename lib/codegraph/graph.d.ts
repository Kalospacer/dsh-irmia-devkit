import type { DatabaseSync } from 'node:sqlite';
import type { Result } from '../protocol.js';
/** 同名符号只有在本文件作用域或唯一导入内确认时才连边，其余保持未解析。 */
export declare function resolveEdges(db: DatabaseSync): void;
/** 符号搜索、定义/调用者/被调用者与两点间有界调用链。 */
export declare function exploreGraph(db: DatabaseSync, query: string): Result;
/** 反向 BFS 的深度是真实最短符号距离，循环与重复边只访问一次。 */
export declare function impactGraph(db: DatabaseSync, files: string[], maxDepth: number): Result;
