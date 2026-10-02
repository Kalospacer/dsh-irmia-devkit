import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** 同名符号通过文件和作用域区分，不以 name 作为全局 identity。 */
export type SymbolRow = {
  id: string; name: string; qualified_name: string; kind: string; file: string;
  line: number; end_line: number; signature: string; source: string;
};
export type ReferenceRow = { from_id: string; target: string; kind: string; file: string; line: number };
export type ImportRow = { file: string; alias: string; module: string; symbol: string };
/** 一次抽取的完整记录；version/size 来自 provider 快照，用于过期判定。 */
export type ParsedFile = { file: string; version: string; size: number; symbols: SymbolRow[]; references: ReferenceRow[]; imports: ImportRow[] };

/** 显式创建新索引库；查询仅打开已有库，不执行 DDL 或创建 sidecar。 */
export class GraphStore {
  constructor(readonly path: string) {}

  readOnly(): DatabaseSync | undefined {
    if (!existsSync(this.path)) return undefined;
    return new DatabaseSync(this.path, { readOnly: true, allowExtension: false });
  }

  writable(): DatabaseSync {
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new DatabaseSync(this.path, { allowExtension: false });
    db.exec(`
      PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files(file TEXT PRIMARY KEY,version TEXT NOT NULL,size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS symbols(id TEXT PRIMARY KEY,name TEXT NOT NULL,qualified_name TEXT NOT NULL,kind TEXT NOT NULL,
        file TEXT NOT NULL,line INTEGER NOT NULL,end_line INTEGER NOT NULL,signature TEXT NOT NULL,source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS references_raw(from_id TEXT NOT NULL,target TEXT NOT NULL,kind TEXT NOT NULL,file TEXT NOT NULL,line INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS imports(file TEXT NOT NULL,alias TEXT NOT NULL,module TEXT NOT NULL,symbol TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS edges(from_id TEXT NOT NULL,to_id TEXT NOT NULL,kind TEXT NOT NULL,file TEXT NOT NULL,line INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file);
      CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id);
      CREATE INDEX IF NOT EXISTS edges_from ON edges(from_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS symbol_fts USING fts5(id UNINDEXED,name,qualified_name,file,signature);
    `);
    return db;
  }

  removeFile(db: DatabaseSync, file: string): void {
    db.prepare('DELETE FROM symbol_fts WHERE id IN (SELECT id FROM symbols WHERE file=?)').run(file);
    db.prepare('DELETE FROM edges WHERE from_id IN (SELECT id FROM symbols WHERE file=?) OR to_id IN (SELECT id FROM symbols WHERE file=?)').run(file, file);
    for (const table of ['symbols', 'references_raw', 'imports', 'files']) db.prepare(`DELETE FROM ${table} WHERE file=?`).run(file);
  }

  addFile(db: DatabaseSync, parsed: ParsedFile): void {
    this.removeFile(db, parsed.file);
    db.prepare('INSERT INTO files(file,version,size) VALUES(?,?,?)').run(parsed.file, parsed.version, parsed.size);
    const symbol = db.prepare('INSERT INTO symbols VALUES(?,?,?,?,?,?,?,?,?)');
    const fts = db.prepare('INSERT INTO symbol_fts VALUES(?,?,?,?,?)');
    for (const row of parsed.symbols) {
      symbol.run(row.id,row.name,row.qualified_name,row.kind,row.file,row.line,row.end_line,row.signature,row.source);
      fts.run(row.id,row.name,row.qualified_name,row.file,row.signature);
    }
    const reference = db.prepare('INSERT INTO references_raw VALUES(?,?,?,?,?)');
    for (const row of parsed.references) reference.run(row.from_id,row.target,row.kind,row.file,row.line);
    const imported = db.prepare('INSERT INTO imports VALUES(?,?,?,?)');
    for (const row of parsed.imports) imported.run(row.file,row.alias,row.module,row.symbol);
  }
}
