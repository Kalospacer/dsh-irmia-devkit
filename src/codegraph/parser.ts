import type Parser from 'web-tree-sitter';
import { createParser, grammarName } from '../syntax/parser.js';
import type { SymbolRow, ReferenceRow, ImportRow } from './store.js';

export interface Extraction { ok: boolean; skipped?: boolean; symbols: SymbolRow[]; references: ReferenceRow[]; imports: ImportRow[] }
const declarations: Record<string, string> = {
  function_definition: 'function', function_declaration: 'function', method_definition: 'method', method_declaration: 'method',
  class_definition: 'class', class_declaration: 'class', class_specifier: 'class', struct_item: 'class', struct_specifier: 'class',
  interface_declaration: 'interface', function_item: 'function', constructor_declaration: 'method',
};

function identifier(node: Parser.SyntaxNode | null | undefined): string {
  if (node === null || node === undefined) return '';
  if (node.type === 'call' || node.type === 'call_expression') return identifier(node.childForFieldName('function'));
  if (node.type === 'attribute' || node.type === 'member_expression') {
    const object = identifier(node.childForFieldName('object'));
    const field = identifier(node.childForFieldName('attribute') ?? node.childForFieldName('property'));
    return object ? `${object}.${field}` : field;
  }
  return node.text.replace(/\s+/g, '').slice(0, 300);
}

function declarationName(node: Parser.SyntaxNode): string {
  let name = node.childForFieldName('name');
  if (name) return name.text;
  if (node.type === 'function_definition') {
    let declarator = node.childForFieldName('declarator');
    while (declarator) {
      name = declarator.childForFieldName('name') ?? declarator.namedChildren.find(child => ['identifier','field_identifier'].includes(child.type)) ?? null;
      if (name) return name.text;
      declarator = declarator.childForFieldName('declarator');
    }
  }
  return '';
}

function importsAt(node: Parser.SyntaxNode, file: string): ImportRow[] {
  const rows: ImportRow[] = [];
  if (node.type === 'import_from_statement') {
    const module = node.childForFieldName('module_name')?.text ?? '';
    for (const child of node.namedChildren.filter(child => child.type === 'aliased_import' || child.type === 'dotted_name' || child.type === 'identifier')) {
      if (child.id === node.childForFieldName('module_name')?.id) continue;
      const symbol = child.childForFieldName('name')?.text ?? child.text;
      rows.push({ file, module, symbol, alias: child.childForFieldName('alias')?.text ?? symbol });
    }
  } else if (node.type === 'import_statement') {
    const source = node.childForFieldName('source');
    if (source) {
      const module = source.text.slice(1, -1);
      for (const specifier of node.descendantsOfType('import_specifier')) {
        const symbol = specifier.childForFieldName('name')?.text ?? '';
        rows.push({ file, module, symbol, alias: specifier.childForFieldName('alias')?.text ?? symbol });
      }
      const clause = node.namedChildren.find(child => child.type === 'import_clause');
      for (const child of clause?.namedChildren ?? []) {
        if (child.type === 'identifier') rows.push({ file, module, alias: child.text, symbol: 'default' });
        if (child.type === 'namespace_import') {
          const alias = child.namedChildren.find(item => item.type === 'identifier')?.text ?? '';
          rows.push({ file, module, alias, symbol: '*' });
        }
      }
    } else {
      for (const child of node.namedChildren) {
        const module = child.childForFieldName('name')?.text ?? child.text;
        rows.push({ file, module, symbol: '*', alias: child.childForFieldName('alias')?.text ?? module.split('.')[0]! });
      }
    }
  }
  return rows;
}

/** 每个符号带文件/作用域 identity；调用及导入来自语法树，不做全文正则重命名。 */
export async function extractSymbols(file: string, source: string, timeoutMs: number): Promise<Extraction> {
  const parser = await createParser(file, timeoutMs);
  if (!parser) return { ok: true, skipped: true, symbols: [], references: [], imports: [] };
  try {
    const tree = parser.parse(source);
    try {
      const symbols: SymbolRow[] = [], references: ReferenceRow[] = [], imports: ImportRow[] = [];
      const moduleId = `${file}:module`;
      symbols.push({ id: moduleId, file, name: '<module>', qualified_name: '<module>', kind: 'module', line: 1,
        end_line: Math.max(1, source.split('\n').length), signature: file, source: '' });
      /** 每层递归都带着当前作用域身份，类内函数记为 method 而不是 function。 */
      const visit = (node: Parser.SyntaxNode, scope: string[], owner: string, inClass: boolean): void => {
        imports.push(...importsAt(node, file));
        let nextOwner = owner, nextScope = scope, nextInClass = inClass;
        let kind = declarations[node.type];
        if (kind === 'function' && inClass && (node.type === 'function_definition' || node.type === 'function_declaration')) kind = 'method';
        let name = kind ? declarationName(node) : '';
        if (node.type === 'variable_declarator' && ['arrow_function','function_expression'].includes(node.childForFieldName('value')?.type ?? '')) {
          kind = 'function'; name = node.childForFieldName('name')?.text ?? '';
        }
        if (kind && name && symbols.length < 20_000) {
          const qualified = [...scope, name].join('.');
          const id = `${file}:${node.startPosition.row + 1}:${qualified}`;
          const body = node.childForFieldName('body');
          const signature = source.slice(node.startIndex, body?.startIndex ?? node.endIndex).trim().slice(0, 500);
          symbols.push({ id, file, name, qualified_name: qualified, kind,
            line: node.startPosition.row + 1, end_line: node.endPosition.row + 1, signature, source: node.text.slice(0, 6000) });
          nextOwner = id; nextScope = [...scope, name];
          if (kind === 'class') nextInClass = true;
          const bases = node.childForFieldName('superclasses') ?? node.childForFieldName('superclass');
          for (const base of bases?.namedChildren ?? []) references.push({ from_id: id, target: identifier(base), kind: 'extends', file, line: base.startPosition.row + 1 });
        }
        if (['call','call_expression','method_invocation','new_expression'].includes(node.type)) {
          const called = identifier(node.childForFieldName('function') ?? node.childForFieldName('name') ?? node.childForFieldName('constructor'));
          if (called && references.length < 100_000) references.push({ from_id: nextOwner, target: called, kind: 'calls', file, line: node.startPosition.row + 1 });
          // 注册型调用的命名回调形成 triggers 边，参数不是符号时不猜测。
          if (/\.(register|add_tool|on|subscribe)$/.test(called)) {
            for (const arg of node.childForFieldName('arguments')?.namedChildren ?? []) {
              if (arg.type === 'identifier') references.push({ from_id: nextOwner, target: arg.text, kind: 'triggers', file, line: arg.startPosition.row + 1 });
            }
          }
        }
        for (const child of node.namedChildren) visit(child, nextScope, nextOwner, nextInClass);
      };
      visit(tree.rootNode, [], moduleId, false);
      return { ok: !tree.rootNode.hasError(), symbols, references, imports };
    } finally { tree.delete(); }
  } finally { parser.delete(); }
}
