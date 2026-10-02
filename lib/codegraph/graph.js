import { posix } from 'node:path';
/** 相对 import 按文件目录解析，非相对 import 先按项目根、再按文件目录尝试。 */
function moduleFile(file, module, all) {
    const directory = posix.dirname(file);
    const bases = [];
    if (file.endsWith('.py')) {
        const dots = /^\.+/.exec(module)?.[0].length ?? 0;
        const suffix = module.slice(dots).replace(/\./g, '/');
        if (dots > 0)
            bases.push(posix.normalize(posix.join(directory, ...Array(Math.max(0, dots - 1)).fill('..'), suffix)));
        else {
            bases.push(suffix, posix.normalize(posix.join(directory, suffix)));
        }
    }
    else if (module.startsWith('.'))
        bases.push(posix.normalize(posix.join(directory, module)));
    else
        bases.push(module, posix.normalize(posix.join(directory, module)));
    const extensions = ['.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.rs', '.java'];
    for (const base of bases) {
        for (const candidate of [base, ...extensions.map(extension => base + extension),
            posix.join(base, '__init__.py'), posix.join(base, 'index.ts'), posix.join(base, 'index.js'), posix.join(base, 'mod.rs')]) {
            if (all.has(candidate))
                return candidate;
        }
    }
    return undefined;
}
/** 同名符号只有在本文件作用域或唯一导入内确认时才连边，其余保持未解析。 */
export function resolveEdges(db) {
    const symbols = db.prepare('SELECT * FROM symbols').all();
    const references = db.prepare('SELECT * FROM references_raw').all();
    const imports = db.prepare('SELECT * FROM imports').all();
    const files = new Set(symbols.map(symbol => symbol.file));
    const byId = new Map(symbols.map(symbol => [symbol.id, symbol]));
    const byFile = new Map();
    const byName = new Map();
    const imported = new Map();
    for (const row of symbols) {
        const group = byFile.get(row.file) ?? [];
        group.push(row);
        byFile.set(row.file, group);
        const names = byName.get(row.name) ?? [];
        names.push(row);
        byName.set(row.name, names);
    }
    for (const row of imports) {
        const group = imported.get(row.file) ?? [];
        group.push(row);
        imported.set(row.file, group);
    }
    db.exec('DELETE FROM edges');
    const insert = db.prepare('INSERT INTO edges(from_id,to_id,kind,file,line) VALUES(?,?,?,?,?)');
    /** 导入项解析：命名导入对齐符号，命名空间/默认导入落入模块文件内查找。 */
    const viaImport = (ref, head, rest) => {
        const entry = imported.get(ref.file)?.find(item => item.alias === head);
        if (entry === undefined)
            return [];
        const file = moduleFile(ref.file, entry.module, files);
        if (file === undefined)
            return [];
        const inFile = byFile.get(file) ?? [];
        const names = entry.symbol === '*' ? (rest === '' ? [] : [rest])
            : entry.symbol === 'default' ? [] : [entry.symbol, ...(rest === '' ? [] : [`${entry.symbol}.${rest}`])];
        for (const name of names) {
            const hit = inFile.filter(item => item.qualified_name === name || item.name === name);
            if (hit.length === 1)
                return hit;
        }
        // 默认/命名空间导入只有一个顶层导出时不猜测具体成员。
        const top = inFile.filter(item => item.kind !== 'module');
        return (entry.symbol === 'default' || entry.symbol === '*') && top.length === 1 ? top : [];
    };
    /** 本文件解析：从符号所在作用域逐层向上匹配限定名，然后唯一名兜底。 */
    const viaLocal = (owner, target) => {
        const local = byFile.get(owner.file) ?? [];
        const scope = owner.qualified_name.split('.').slice(0, -1);
        for (let depth = scope.length; depth >= 0; depth--) {
            const qualified = [...scope.slice(0, depth), target].join('.');
            const hit = local.filter(item => item.qualified_name === qualified);
            if (hit.length > 0)
                return hit;
        }
        const direct = local.filter(item => item.qualified_name === target || item.name === target);
        if (direct.length > 0)
            return direct;
        return byName.get(target) ?? [];
    };
    for (const ref of references) {
        const owner = byId.get(ref.from_id);
        if (owner === undefined)
            continue;
        let target = ref.target;
        // self./this. 成员调用归属当前类作用域，不跨类猜测。
        if (/^(self|this)\./.test(target))
            target = [...owner.qualified_name.split('.').slice(0, -1), ...target.split('.').slice(1)].join('.');
        const [head = '', ...trailing] = target.split('.');
        const rest = trailing.join('.');
        let candidates = viaImport(ref, head, rest);
        if (candidates.length === 0)
            candidates = viaLocal(owner, target);
        if (candidates.length === 1)
            insert.run(ref.from_id, candidates[0].id, ref.kind, ref.file, ref.line);
    }
}
/** 查询返回受限来源字段，JSON-safe 数值均由索引自身生成。 */
function publicSymbol(row) {
    return { id: row.id, name: row.name, qualified_name: row.qualified_name, kind: row.kind, file: row.file,
        line: row.line, end_line: row.end_line, signature: row.signature, source: row.source };
}
/** 符号搜索、定义/调用者/被调用者与两点间有界调用链。 */
export function exploreGraph(db, query) {
    const kind = /(?:^|\s)kind:([\w]+)/.exec(query)?.[1];
    const pattern = query.replace(/(?:^|\s)kind:[\w]+/g, '').trim();
    const lookup = (name) => {
        const literal = `%${name}%`;
        const rows = db.prepare('SELECT * FROM symbols WHERE (name LIKE ? OR qualified_name LIKE ?) AND (? IS NULL OR kind=?) ORDER BY CASE WHEN name=? THEN 0 ELSE 1 END,file,line LIMIT 100').all(literal, literal, kind ?? null, kind ?? null, name);
        if (rows.length > 0 || name === '')
            return rows;
        // 分词查询走 FTS；短语按词逐项 OR，避免 FTS 语法注入。
        const terms = name.split(/\W+/).filter(Boolean).map(term => '"' + term.replaceAll('"', '""') + '"').join(' OR ');
        if (terms === '')
            return [];
        return db.prepare('SELECT s.* FROM symbols s JOIN symbol_fts f ON f.id=s.id WHERE symbol_fts MATCH ? LIMIT 100').all(terms);
    };
    const path = pattern.split(/\s*(?:→|->)\s*/);
    if (path.length === 2) {
        const start = lookup(path[0])[0], end = lookup(path[1])[0];
        if (start === undefined || end === undefined)
            return { ok: false, error: '调用链端点未找到', matches: [], project_hint: '可用 code_explore 单独确认两端符号名' };
        const byId = db.prepare('SELECT * FROM symbols WHERE id=?');
        const queue = [[start.id]];
        const seen = new Set([start.id]);
        while (queue.length > 0 && seen.size <= 2000) {
            const route = queue.shift(), last = route[route.length - 1];
            if (last === end.id)
                return { ok: true, found: true, query, hops: route.length - 1, path: route.map(id => publicSymbol(byId.get(id))) };
            if (route.length > 10)
                continue;
            const edges = db.prepare('SELECT to_id FROM edges WHERE from_id=?').all(last);
            for (const edge of edges)
                if (!seen.has(edge.to_id)) {
                    seen.add(edge.to_id);
                    queue.push([...route, edge.to_id]);
                }
        }
        return { ok: false, found: false, error: '静态索引中没有找到调用链', query, matches: [], hint: '可能通过回调、动态调用或框架路由连接，可用 rg/文本搜索确认' };
    }
    const rows = lookup(pattern);
    return { ok: true, found: rows.length > 0, query, matches: rows.map(row => {
            const callers = db.prepare('SELECT s.*, e.line AS reference_line,e.file AS reference_file FROM edges e JOIN symbols s ON s.id=e.from_id WHERE e.to_id=? LIMIT 50').all(row.id);
            const callees = db.prepare('SELECT s.*, e.line AS reference_line,e.file AS reference_file FROM edges e JOIN symbols s ON s.id=e.to_id WHERE e.from_id=? LIMIT 50').all(row.id);
            return { ...publicSymbol(row), callers: callers.map(publicSymbol), callees: callees.map(publicSymbol),
                caller_locations: callers.map(item => ({ file: item.reference_file, line: item.reference_line, name: item.qualified_name })),
                callee_locations: callees.map(item => ({ file: item.reference_file, line: item.reference_line, name: item.qualified_name })) };
        }) };
}
/** 反向 BFS 的深度是真实最短符号距离，循环与重复边只访问一次。 */
export function impactGraph(db, files, maxDepth) {
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 20)
        return { ok: false, error: 'max_depth 必须为 1~20 的整数' };
    const seen = new Set();
    const queue = [];
    for (const file of files)
        for (const row of db.prepare('SELECT id FROM symbols WHERE file=?').all(file)) {
            seen.add(row.id);
            queue.push({ id: row.id, depth: 0 });
        }
    const affected = [];
    const affectedFiles = new Set();
    const byId = db.prepare('SELECT * FROM symbols WHERE id=?');
    while (queue.length > 0 && affected.length < 500) {
        const current = queue.shift();
        if (current.depth >= maxDepth)
            continue;
        const rows = db.prepare('SELECT from_id FROM edges WHERE to_id=?').all(current.id);
        for (const edge of rows) {
            if (seen.has(edge.from_id))
                continue;
            seen.add(edge.from_id);
            const depth = current.depth + 1;
            const row = byId.get(edge.from_id);
            affected.push({ ...publicSymbol(row), depth });
            affectedFiles.add(row.file);
            queue.push({ id: row.id, depth });
        }
    }
    return { ok: true, files, affected, affected_files: [...affectedFiles].sort(), max_depth: maxDepth,
        truncated: affected.length >= 500, dynamic_calls_may_be_missing: true };
}
//# sourceMappingURL=graph.js.map