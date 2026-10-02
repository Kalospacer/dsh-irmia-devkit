import { failure } from '../protocol.js';
import { GraphStore } from './store.js';
import { resolveEdges, exploreGraph, impactGraph } from './graph.js';
/** 提交是全有或全无：任一步失败回滚，不留下半份索引。 */
function commit(store, db, request) {
    if (!Array.isArray(request.parsed) || !Array.isArray(request.invalidFiles))
        throw new Error('无效索引提交请求');
    db.exec('BEGIN');
    try {
        const known = db.prepare('SELECT file FROM files').all();
        if (request.full === true)
            for (const row of known)
                store.removeFile(db, row.file);
        else if (Array.isArray(request.present)) {
            const present = new Set(request.present);
            for (const row of known)
                if (!present.has(row.file))
                    store.removeFile(db, row.file);
        }
        for (const file of request.invalidFiles)
            store.removeFile(db, file);
        for (const parsed of request.parsed)
            store.addFile(db, parsed);
        resolveEdges(db);
        db.prepare("INSERT OR REPLACE INTO meta VALUES('last_index_at',?)").run(new Date().toISOString());
        db.exec('COMMIT');
    }
    catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
/** 只写调用者指定的内部派生库；查询绝不隐式建库。 */
export function graphOperation(request) {
    const store = new GraphStore(request.path);
    const db = request.operation === 'commit' ? store.writable() : store.readOnly();
    if (!db)
        return request.operation === 'inspect' ? { ok: true, files: [], index_present: false }
            : failure('索引尚未建立，请先调用 code_index', { index_present: false });
    try {
        if (request.operation === 'commit')
            commit(store, db, request);
        if (request.operation === 'explore')
            return exploreGraph(db, request.query ?? '');
        if (request.operation === 'impact')
            return impactGraph(db, request.filepaths ?? [], request.maxDepth ?? 3);
        const files = db.prepare('SELECT file,version,size FROM files ORDER BY file').all();
        const count = db.prepare('SELECT COUNT(*) count FROM symbols').get();
        const edges = db.prepare('SELECT COUNT(*) count FROM edges').get();
        const fts = db.prepare('SELECT COUNT(*) count FROM symbol_fts').get();
        return {
            ok: true, index_present: true, files: files.map(row => ({ ...row })), files_indexed: files.length,
            symbols_total: count.count, edges_total: edges.count, fts5_ok: fts.count === count.count,
            last_index_at: db.prepare("SELECT value FROM meta WHERE key='last_index_at'").get()?.value ?? null,
        };
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=worker.js.map