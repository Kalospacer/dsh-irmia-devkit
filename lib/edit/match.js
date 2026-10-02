import { failure } from '../protocol.js';
function normalize(text) { return text.replace(/\r\n/g, '\n'); }
function indent(text) { return text.length - text.trimStart().length; }
/** 仅在每一行均带读取行号前缀时去掉前缀，精确匹配在调用方先执行。 */
function stripNumbers(text) {
    const lines = text.split('\n');
    const numbered = /^\s*(?:→\s*)?\d+│ ?/u;
    if (lines.length === 0 || !lines.every(line => numbered.test(line)))
        return { changed: false, text };
    return { changed: true, text: lines.map(line => line.replace(numbered, '')).join('\n') };
}
/** 只用于无匹配时的有界建议，不根据相似性修改文件。 */
function nearbyLine(source, old) {
    const needle = old.split('\n')[0].trim().slice(0, 120);
    const words = needle.split(/\W+/u).filter(word => word.length > 1);
    let best = { line: 0, text: '', score: 0 };
    for (const [index, line] of source.split('\n').slice(0, 5000).entries()) {
        const preview = line.trim().slice(0, 120);
        const score = words.filter(word => preview.includes(word)).length;
        if (score > best.score)
            best = { line: index + 1, text: line.slice(0, 120), score };
    }
    return best.line === 0 ? {} : { line: best.line, text: best.text };
}
function whitespace(source, old, replacement, preserve) {
    const expected = old.split('\n').map(line => line.trim());
    if (!expected[0])
        return undefined;
    const lines = source.split('\n');
    for (let start = 0; start + expected.length <= lines.length; start++) {
        if (!expected.every((line, index) => lines[start + index].trim() === line))
            continue;
        const matched = lines.slice(start, start + expected.length);
        const newLines = replacement.split('\n');
        const delta = indent(matched[0]) - indent(newLines[0]);
        const aligned = newLines.map((line, index) => {
            if (preserve)
                return line.trimStart() ? ' '.repeat(Math.max(0, indent(line) + delta)) + line.trimStart() : line;
            const base = matched[Math.min(index, matched.length - 1)];
            return base.slice(0, indent(base)) + line.trimStart();
        });
        return [matched.join('\n'), aligned.join('\n')];
    }
    return undefined;
}
/** 内存编辑计划；成功才返回候选，不读写文件。 */
export function applyEdit(original, args, maxBytes = 20 * 1024 * 1024) {
    const crlf = original.includes('\r\n');
    const source = normalize(original);
    let old = normalize(args.old ?? '');
    let replacement = normalize(args.new ?? '');
    const mode = args.mode ?? 'replace';
    const metadata = {};
    const done = (text, replaced) => {
        const restored = crlf ? text.replace(/\n/g, '\r\n') : text;
        if (Buffer.byteLength(restored, 'utf8') > maxBytes)
            return { ok: false, result: failure('编辑结果超过大小上限') };
        return { ok: true, text: restored, replaced, metadata };
    };
    if (mode !== 'replace') {
        const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        if (mode === 'insert_at_line') {
            const line = args.line ?? 0;
            if (!replacement)
                return { ok: false, result: failure('插入内容不能为空') };
            if (!Number.isInteger(line) || line < 0 || line > lines.length)
                return { ok: false, result: failure('line 超出文件行号范围') };
            if (!replacement.endsWith('\n'))
                replacement += '\n';
            if (line > 0 && !lines[line - 1].endsWith('\n'))
                lines[line - 1] += '\n';
            lines.splice(line, 0, replacement);
        }
        else if (mode === 'delete_lines') {
            const start = args.start_line ?? 0, end = args.end_line ?? 0;
            if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length)
                return { ok: false, result: failure('删除范围必须为有效的闭区间行号') };
            lines.splice(start - 1, end - start + 1);
        }
        else
            return { ok: false, result: failure('无效编辑模式') };
        metadata.mode = mode;
        return done(lines.join(''), 1);
    }
    if (!old)
        return { ok: false, result: failure('replace 模式 old 不能为空；new 可以为空') };
    const occurrence = args.occurrence ?? 0;
    if (!Number.isInteger(occurrence) || occurrence < 0)
        return { ok: false, result: failure('occurrence 必须为非负整数') };
    if (occurrence > 0 && args.replace_all)
        return { ok: false, result: failure('occurrence 与 replace_all 不能同时使用') };
    if (!source.includes(old)) {
        const stripped = stripNumbers(old);
        if (stripped.changed && source.includes(stripped.text)) {
            old = stripped.text;
            replacement = stripNumbers(replacement).text;
            metadata.line_numbers_stripped = true;
        }
    }
    if (!source.includes(old)) {
        const aligned = whitespace(source, old, replacement, args.align_whitespace ?? true);
        if (aligned !== undefined) {
            [old, replacement] = aligned;
            metadata.whitespace_aligned = true;
        }
    }
    let count = 0, selected = -1;
    const evidence = [];
    for (let position = source.indexOf(old); position >= 0; position = source.indexOf(old, position + old.length)) {
        count++;
        if (count === (occurrence || 1))
            selected = position;
        if (evidence.length < 20) {
            const lineStart = source.lastIndexOf('\n', position - 1) + 1;
            const lineEnd = source.indexOf('\n', position);
            evidence.push({ line: source.slice(0, position).split('\n').length, col: position - lineStart + 1,
                preview: source.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim().slice(0, 100) });
        }
    }
    if (count === 0)
        return { ok: false, result: failure('未找到匹配文本，文件未修改', {
                proposal: '重新读取文件，确认内容和缩进后重试', evidence: nearbyLine(source, old),
            }) };
    if (count > 1 && occurrence === 0 && !args.replace_all)
        return { ok: false, result: failure(`old 出现 ${count} 次，请指定 occurrence 或 replace_all`, {
                matches: evidence, occurrence_count: count, evidence: { matches: evidence, occurrence_count: count },
            }) };
    if (selected < 0 && !args.replace_all)
        return { ok: false, result: failure('occurrence 超出匹配次数', { occurrence_count: count }) };
    if (args.replace_all) {
        const projected = Buffer.byteLength(source) + count * (Buffer.byteLength(replacement) - Buffer.byteLength(old));
        if (projected > maxBytes)
            return { ok: false, result: failure('编辑结果超过大小上限') };
        return done(source.split(old).join(replacement), count);
    }
    return done(source.slice(0, selected) + replacement + source.slice(selected + old.length), 1);
}
//# sourceMappingURL=match.js.map