import type { Result } from '../protocol.js';
import { failure } from '../protocol.js';
import { GraphStore } from './store.js';
import type { ParsedFile } from './store.js';
import { resolveEdges, exploreGraph, impactGraph } from './graph.js';

/** 索引 SQL、FTS 与引用解析都在可终止的 Worker 内完成。 */
export interface GraphRequest {
  kind: 'graph'; path: string; operation: 'inspect' | 'commit' | 'explore' | 'impact' | 'status'; timeoutMs: number;
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

type StoredFile = { file: string; version: string; size: number };

/** 提交是全有或全无：任一步失败回滚，不留下半份索引。 */
function commit(store: GraphStore, db: ReturnType<GraphStore['writable']>, request: GraphRequest): void {
  if (!Array.isArray(request.parsed) || !Array.isArray(request.invalidFiles)) throw new Error('无效索引提交请求');
  db.exec('BEGIN');
  try {
    const known = db.prepare('SELECT file FROM files').all() as { file: string }[];
    if (request.full === true) for (const row of known) store.removeFile(db, row.file);
    else if (Array.isArray(request.present)) {
      const present = new Set(request.present);
      for (const row of known) if (!present.has(row.file)) store.removeFile(db, row.file);
    }
    for (const file of request.invalidFiles) store.removeFile(db, file);
    for (const parsed of request.parsed) store.addFile(db, parsed);
    resolveEdges(db);
    db.prepare("INSERT OR REPLACE INTO meta VALUES('last_index_at',?)").run(new Date().toISOString());
    db.exec('COMMIT');
  } catch (error: unknown) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** 只写调用者指定的内部派生库；查询绝不隐式建库。 */
export function graphOperation(request: GraphRequest): Result {
  const store = new GraphStore(request.path);
  const db = request.operation === 'commit' ? store.writable() : store.readOnly();
  if (!db) return request.operation === 'inspect' ? { ok: true, files: [], index_present: false }
    : failure('索引尚未建立，请先调用 code_index', { index_present: false });
  try {
    if (request.operation === 'commit') commit(store, db, request);
    if (request.operation === 'explore') return exploreGraph(db, request.query ?? '');
    if (request.operation === 'impact') return impactGraph(db, request.filepaths ?? [], request.maxDepth ?? 3);
    const files = db.prepare('SELECT file,version,size FROM files ORDER BY file').all() as StoredFile[];
    const count = db.prepare('SELECT COUNT(*) count FROM symbols').get() as { count: number };
    const edges = db.prepare('SELECT COUNT(*) count FROM edges').get() as { count: number };
    const fts = db.prepare('SELECT COUNT(*) count FROM symbol_fts').get() as { count: number };
    return {
      ok: true, index_present: true, files: files.map(row => ({ ...row })), files_indexed: files.length,
      symbols_total: count.count, edges_total: edges.count, fts5_ok: fts.count === count.count,
      last_index_at: (db.prepare("SELECT value FROM meta WHERE key='last_index_at'").get() as { value: string } | undefined)?.value ?? null,
    };
  } finally { db.close(); }
}
