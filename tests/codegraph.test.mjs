import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness } from './harness.mjs';

const service = 'from .util import helper\n\ndef run():\n    return helper()\n';
const util = 'def helper():\n    return 1\n';
const main = 'from src.service import run\n\ndef main():\n    return run()\n';

test('code index uses the session filesystem and creates state only explicitly', async () => {
  const h = await harness({ config: { enabledGroups: ['codegraph'] } });
  try {
    await mkdir(join(h.workspace, 'src'));
    await writeFile(join(h.workspace, 'src', 'main.py'), 'def greet(name):\n    return name\n\ndef unused():\n    return 1\n');
    await writeFile(join(h.workspace, 'src', 'other.ts'), 'export function answer(): number { return 42; }\n');
    const before = await h.call('code_explore', { project_dir: '.', query: 'greet' });
    assert.equal(before.value.ok, false);
    await assert.rejects(access(join(h.stateDir, 'codegraph')));
    const indexed = await h.call('code_index', { project_dir: '.', incremental: false });
    assert.equal(indexed.value.ok, true, JSON.stringify(indexed));
    assert.ok(indexed.value.files_indexed >= 2);
    const explored = await h.call('code_explore', { project_dir: '.', query: 'greet' });
    assert.equal(explored.value.ok, true, JSON.stringify(explored));
    assert.equal(explored.value.matches[0].name, 'greet');
    assert.equal(explored.value.matches[0].file, 'src/main.py');
    assert.equal(explored.value.index_stale, undefined);
    const status = await h.call('code_index', { project_dir: '.', status: true });
    assert.equal(status.value.ok, true);
    assert.equal(status.value.files_indexed, 2);
    await rm(join(h.workspace, 'src', 'other.ts'));
    const incremental = await h.call('code_index', { project_dir: '.', incremental: true });
    assert.equal(incremental.value.ok, true);
    assert.equal(incremental.value.files_unchanged, 1);
    const after = await h.call('code_explore', { project_dir: '.', query: 'answer' });
    assert.equal(after.value.matches.length, 0);
    const impact = await h.call('code_diff_impact', { project_dir: '.', filepaths: ['src/main.py'], max_depth: 3 });
    assert.equal(impact.value.ok, true);
    assert.equal(impact.value.max_depth, 3);
  } finally { await h.dispose(); }
});

test('code index refuses read-only construction', async () => {
  const h = await harness({ sandboxMode: 'read-only', config: { enabledGroups: ['codegraph'] } });
  try {
    await writeFile(join(h.workspace, 'main.py'), 'def main(): return 1\n');
    const result = await h.call('code_index', { project_dir: '.' });
    assert.equal(result.isError, true);
    assert.equal(result.error.info.code, 'FS_SANDBOX_DENIED');
  } finally { await h.dispose(); }
});

test('caller/callee resolution follows imports and reports real BFS depth', async () => {
  const h = await harness({ config: { enabledGroups: ['codegraph'] } });
  try {
    await mkdir(join(h.workspace, 'src'));
    await writeFile(join(h.workspace, 'src', 'service.py'), service);
    await writeFile(join(h.workspace, 'src', 'util.py'), util);
    await writeFile(join(h.workspace, 'main.py'), main);
    assert.equal((await h.call('code_index', { project_dir: '.' })).value.ok, true);

    const run = await h.call('code_explore', { project_dir: '.', query: 'run' });
    const symbol = run.value.matches.find(match => match.qualified_name === 'run');
    assert.ok(symbol, JSON.stringify(run.value));
    assert.deepEqual(symbol.callees.map(item => item.qualified_name), ['helper']);
    assert.deepEqual(symbol.callers.map(item => item.qualified_name), ['main']);

    const path = await h.call('code_explore', { project_dir: '.', query: 'main → helper' });
    assert.equal(path.value.ok, true, JSON.stringify(path.value));
    assert.equal(path.value.hops, 2);
    assert.deepEqual(path.value.path.map(item => item.qualified_name), ['main', 'run', 'helper']);

    const impact = await h.call('code_diff_impact', { project_dir: '.', filepaths: ['src/util.py'], max_depth: 2 });
    const depths = Object.fromEntries(impact.value.affected.map(item => [item.qualified_name, item.depth]));
    assert.deepEqual(depths, { run: 1, main: 2 }, JSON.stringify(impact.value));
    assert.deepEqual(impact.value.affected_files, ['main.py', 'src/service.py']);
    assert.equal(impact.value.dynamic_calls_may_be_missing, true);
  } finally { await h.dispose(); }
});

test('index staleness is reported without rewriting the index', async () => {
  const h = await harness({ config: { enabledGroups: ['codegraph'] } });
  try {
    await mkdir(join(h.workspace, 'src'));
    await writeFile(join(h.workspace, 'src', 'util.py'), util);
    await writeFile(join(h.workspace, 'src', 'service.py'), service);
    await writeFile(join(h.workspace, 'main.py'), main);
    await h.call('code_index', { project_dir: '.' });
    await writeFile(join(h.workspace, 'src', 'util.py'), 'def helper():\n    return 2\n');
    const explored = await h.call('code_explore', { project_dir: '.', query: 'run' });
    assert.equal(explored.value.index_stale, true, JSON.stringify(explored.value));
    assert.match(explored.value.stale_warning, /code_index\(incremental=true\)/);
    const status = await h.call('code_index', { project_dir: '.', status: true });
    assert.equal(status.value.stale_files, 1);
    // 查询只报告过期，不隐式更新索引。
    const again = await h.call('code_explore', { project_dir: '.', query: 'run' });
    assert.equal(again.value.index_stale, true);
  } finally { await h.dispose(); }
});

test('oversized and unparsable files are skipped and dropped from the index', async () => {
  const h = await harness({ config: { enabledGroups: ['codegraph'], indexMaxFileBytes: 200 } });
  try {
    await writeFile(join(h.workspace, 'big.py'), `def big():\n    return ${'1 + '.repeat(80)}1\n`);
    await writeFile(join(h.workspace, 'small.py'), 'def small():\n    return 1\n');
    const first = await h.call('code_index', { project_dir: '.' });
    assert.equal(first.value.ok, true, JSON.stringify(first.value));
    assert.deepEqual(first.value.invalid_files, ['big.py']);
    assert.equal(first.value.files_skipped, 1);
    assert.equal((await h.call('code_explore', { project_dir: '.', query: 'big' })).value.matches.length, 0);
    // 已索引文件改成超限后，下一次增量必须清除其旧记录。
    await writeFile(join(h.workspace, 'small.py'), `def small():\n    return ${'2 + '.repeat(80)}2\n`);
    const second = await h.call('code_index', { project_dir: '.', incremental: true });
    assert.ok(second.value.invalid_files.includes('small.py'), JSON.stringify(second.value));
    assert.equal((await h.call('code_explore', { project_dir: '.', query: 'small' })).value.matches.length, 0);
  } finally { await h.dispose(); }
});
