import Parser from 'web-tree-sitter';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { parseDocument } from 'yaml';
import { errorMessage } from '../protocol.js';
/** grammar 名称与实际打包文件一一对应；不从网络下载。 */
const GRAMMARS = {
    '.py': 'python', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
    '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
    '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.h': 'c',
    '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
    '.php': 'php', '.sh': 'bash', '.bash': 'bash',
};
const CONFIG_FORMATS = new Set(['.json', '.toml', '.yaml', '.yml']);
let ready;
const languages = new Map();
/** 返回文件适用的内部解析器，外部 PowerShell/Nim 由 DSH 进程适配器处理。 */
export function grammarName(filename) {
    return GRAMMARS[extname(filename).toLowerCase()];
}
/** 判断是否有内置解析路由。 */
export function supportsInternalSyntax(filename) {
    const suffix = extname(filename).toLowerCase();
    return grammarName(filename) !== undefined || CONFIG_FORMATS.has(suffix);
}
/** 创建拥有独立取消预算的 parser；调用者负责删除 tree 和 parser。 */
export async function createParser(filename, timeoutMs) {
    const grammar = grammarName(filename);
    if (grammar === undefined)
        return undefined;
    ready ??= Parser.init({ locateFile: () => fileURLToPath(new URL('../../assets/runtime/web-tree-sitter.wasm', import.meta.url)) });
    await ready;
    let language = languages.get(grammar);
    if (language === undefined) {
        language = Parser.Language.load(fileURLToPath(new URL(`../../assets/grammars/tree-sitter-${grammar}.wasm`, import.meta.url)));
        languages.set(grammar, language);
    }
    const parser = new Parser();
    parser.setLanguage(await language);
    parser.setTimeoutMicros(timeoutMs * 1000);
    return parser;
}
/** 给诊断添加 1-based 行列和原源码上下文。 */
function diagnostic(source, line, col, msg) {
    const lines = source.split('\n');
    return {
        line, col, msg,
        context: lines.slice(Math.max(0, line - 3), line + 2).map((text, index) => {
            const actual = Math.max(0, line - 3) + index + 1;
            return `${actual === line ? '→' : ' '}${String(actual).padStart(4)}│ ${text.slice(0, 120)}`;
        }),
    };
}
/** 在 Worker 中解析源码，不执行或编译源码；缺路由时明确跳过。 */
export async function checkSource(filename, source, timeoutMs) {
    const suffix = extname(filename).toLowerCase();
    const language = grammarName(filename) ?? suffix.slice(1);
    if (CONFIG_FORMATS.has(suffix)) {
        try {
            if (suffix === '.json')
                JSON.parse(source.replace(/^\uFEFF/, ''));
            else if (suffix === '.toml')
                parseToml(source);
            else {
                const parsed = parseDocument(source, { uniqueKeys: false });
                if (parsed.errors.length > 0) {
                    const issue = parsed.errors[0];
                    const position = issue.linePos?.[0];
                    const error = diagnostic(source, position?.line ?? 1, position?.col ?? 1, issue.message);
                    return { ok: false, language: 'yaml', errors: [error] };
                }
            }
            return { ok: true, language: suffix === '.yml' ? 'yaml' : language };
        }
        catch (error) {
            const message = errorMessage(error);
            const offset = /position (\d+)/i.exec(message);
            const pos = offset === null ? 0 : Number(offset[1]);
            const before = source.slice(0, pos);
            const line = before.split('\n').length;
            const col = pos - before.lastIndexOf('\n');
            return { ok: false, language, errors: [diagnostic(source, line, col, message)] };
        }
    }
    const parser = await createParser(filename, timeoutMs);
    if (parser === undefined)
        return { ok: true, language: `text/${suffix}`, skipped: true, reason: '没有适用的内置解析器' };
    try {
        const tree = parser.parse(source);
        try {
            if (!tree.rootNode.hasError())
                return { ok: true, language };
            const errors = [];
            const pending = [tree.rootNode];
            while (pending.length > 0 && errors.length < 5) {
                const node = pending.pop();
                if (node.type === 'ERROR' || node.isMissing()) {
                    errors.push(diagnostic(source, node.startPosition.row + 1, node.startPosition.column + 1, node.isMissing() ? `缺少 ${node.type}` : `无法解析 ${node.text.slice(0, 80)}`));
                }
                else {
                    pending.push(...node.children.slice().reverse());
                }
            }
            return { ok: false, language, errors };
        }
        finally {
            tree.delete();
        }
    }
    finally {
        parser.delete();
    }
}
//# sourceMappingURL=parser.js.map