import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import type { Result, Json } from '../protocol.js';
import { failure, errorMessage } from '../protocol.js';

/** 去除注释并识别字符串内分号；单条 SELECT/查询型 PRAGMA，不接受追加语句。 */
export function validateSql(sql: string): string | undefined {
  let clean = '', quote = '', index = 0, terminated = false;
  while (index < sql.length) {
    const char = sql[index]!;
    if (quote) {
      if (terminated) return '不允许多条 SQL';
      clean += char;
      if (char === quote) {
        if (sql[index + 1] === quote) { clean += quote; index += 2; continue; }
        quote = '';
      }
      index++; continue;
    }
    if (sql.slice(index, index + 2) === '--') {
      const end = sql.indexOf('\n', index); index = end < 0 ? sql.length : end + 1; clean += ' '; continue;
    }
    if (sql.slice(index, index + 2) === '/*') {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) return 'SQL 注释未闭合';
      index = end + 2; clean += ' '; continue;
    }
    if (char === ';') {
      if (terminated) return '不允许多条 SQL';
      terminated = true; index++; continue;
    }
    if (terminated && !/\s/.test(char)) return '不允许多条 SQL';
    if (char === '\'' || char === '"' || char === '`') quote = char;
    if (char === '[') quote = ']';
    clean += char; index++;
  }
  if (quote) return 'SQL 字符串未闭合';
  const statement = clean.trim();
  if (/^SELECT\b/i.test(statement)) return undefined;
  // 只允许实际查询用途的 PRAGMA，杜绝 connection-changing pragma。
  if (/^PRAGMA\s+(?:table_info|table_xinfo|index_list|index_info|index_xinfo|foreign_key_list)\s*\([^;=]*\)\s*$/i.test(statement)) return undefined;
  if (/^PRAGMA\s+(?:database_list|compile_options|integrity_check|quick_check|foreign_key_check|schema_version|user_version|page_count|freelist_count)\s*$/i.test(statement)) return undefined;
  return '仅允许单条 SELECT 和查询型 PRAGMA，不能设置 PRAGMA 或 ATTACH';
}

export interface QueryRequest {
  path: string; sql: string; params: (string | number | null)[]; maxRows: number; maxBytes: number; timeoutMs: number;
}

/** 固定 Worker 请求，只读引擎、query_only 和不加载扩展形成实际写入约束。 */
export function queryDatabase(request: QueryRequest): Result {
  const invalid = validateSql(request.sql);
  if (invalid !== undefined) return failure(invalid);
  if (!statSync(request.path).isFile()) return failure('数据库不存在或不是普通文件');
  const db = new DatabaseSync(request.path, { readOnly: true, allowExtension: false, timeout: request.timeoutMs });
  try {
    db.exec('PRAGMA query_only=ON');
    const statement = db.prepare(request.sql);
    statement.setReadBigInts(true);
    const columns = statement.columns().map(column => column.name);
    const rows: Json[] = [];
    let bytes = Buffer.byteLength(JSON.stringify({ columns, rows: [] }));
    let truncated = false;
    for (const row of statement.iterate(...request.params)) {
      if (rows.length >= request.maxRows) { truncated = true; break; }
      const output: Record<string, Json> = {};
      for (const [name, value] of Object.entries(row)) {
        if (typeof value === 'bigint') output[name] = value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : { type: 'integer', decimal: String(value) };
        else if (value instanceof Uint8Array) output[name] = { type: 'blob', base64: Buffer.from(value).toString('base64'), bytes: value.length };
        else output[name] = value;
      }
      const size = Buffer.byteLength(JSON.stringify(output));
      if (bytes + size > request.maxBytes) { truncated = true; break; }
      rows.push(output); bytes += size + 1;
    }
    return { ok: true, columns, rows, row_count: rows.length, truncated };
  } catch (error: unknown) { return failure(errorMessage(error)); }
  finally { db.close(); }
}
