import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness } from './harness.mjs';

test('classes, methods, self-calls and JS named imports resolve without name collisions', async () => {
  const h = await harness({ config: { enabledGroups: ['codegraph'] } });
  try {
    await mkdir(join(h.workspace, 'pkg'));
    await writeFile(join(h.workspace, 'pkg', '__init__.py'), '');
    await writeFile(join(h.workspace, 'pkg', 'store.py'), [
      'class Store:',
      '    def save(self, item):',
      '        return self.helper(item)',
      '',
      '    def helper(self, item):',
      '        return item',
      '',
      'def save():',
      '    return "module-level"',
      '',
    ].join('\n'));
    await writeFile(join(h.workspace, 'app.py'), [
      'from pkg.store import Store',
      '',
      'def main():',
      '    store = Store()',
      '    return store.save(1)',
      '',
      'def save():',
      '    return "other"',
      '',
    ].join('\n'));
    await writeFile(join(h.workspace, 'util.js'), 'export function helper() { return 1; }\nexport function other() { return 2; }\n');
    await writeFile(join(h.workspace, 'main.js'), "import { helper } from './util.js';\n\nexport function run() {\n  return helper();\n}\n");
    assert.equal((await h.call('code_index', { project_dir: '.' })).value.ok, true);

    const methods = await h.call('code_explore', { project_dir: '.', query: 'kind:method' });
    const saveMethod = methods.value.matches.find(match => match.qualified_name === 'Store.save');
    assert.ok(saveMethod, JSON.stringify(methods.value.matches.map(match => match.qualified_name)));
    // self.helper 必须落在同一个类作用域，而不是模块级 save。
    assert.deepEqual(saveMethod.callees.map(item => item.qualified_name), ['Store.helper']);

    const main = await h.call('code_explore', { project_dir: '.', query: 'main' });
    const mainSymbol = main.value.matches.find(match => match.qualified_name === 'main');
    const callees = mainSymbol.callees.map(item => item.qualified_name).sort();
    // 构造函数经导入解析到类；`store.save` 的实例类型不做推断，因此不得被误连到本文件同名 save。
    assert.deepEqual(callees, ['Store'], JSON.stringify(mainSymbol));
    assert.ok(!mainSymbol.callees.some(item => item.file === 'app.py' && item.name === 'save'));

    const run = await h.call('code_explore', { project_dir: '.', query: 'run' });
    const runSymbol = run.value.matches.find(match => match.qualified_name === 'run');
    assert.deepEqual(runSymbol.callees.map(item => item.qualified_name), ['helper']);
    assert.equal(runSymbol.callees[0].file, 'util.js');

    const trace = await h.call('code_explore', { project_dir: '.', query: 'Store.save → Store.helper' });
    assert.equal(trace.value.ok, true, JSON.stringify(trace.value));
    assert.equal(trace.value.hops, 1);
    assert.deepEqual(trace.value.path.map(item => item.qualified_name), ['Store.save', 'Store.helper']);
  } finally { await h.dispose(); }
});

test('truncated scans do not delete unvisited records', async () => {
  const h = await harness({ config: { enabledGroups: ['codegraph'], indexMaxFiles: 2 } });
  try {
    await writeFile(join(h.workspace, 'a.py'), 'def first():\n    return 1\n');
    await writeFile(join(h.workspace, 'b.py'), 'def second():\n    return 1\n');
    await writeFile(join(h.workspace, 'c.py'), 'def third():\n    return 1\n');
    const full = await h.call('code_index', { project_dir: '.' });
    assert.equal(full.value.ok, true, JSON.stringify(full.value));
    assert.equal(full.value.scan_truncated, true);
    assert.equal(full.value.files_seen, 2);
    assert.equal(full.value.files_indexed, 2);
    const total = await h.call('code_index', { project_dir: '.', status: true });
    assert.equal(total.value.files_indexed, 2);
  } finally { await h.dispose(); }
});
