import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { harness } from './harness.mjs';
import { applyEdit } from '../lib/edit/match.js';
import { restoreRaw } from '../lib/dsh/restore-helper.js';
import { byteHash } from '../lib/dsh/files.js';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/alignment-scenes.json', import.meta.url), 'utf8'));
for (const scene of fixtures.filter(scene => scene.suffix === '.txt')) {
  test(`matching parity: ${scene.name}`, () => {
    const result = applyEdit(scene.before, scene.args);
    assert.equal(result.ok, scene.ok);
    assert.equal(result.ok ? result.text : scene.before, scene.after);
  });
}

test('matching preserves nested indentation and literal numbered content', () => {
  const before = '    def outer():\n        return 1\n';
  const result = applyEdit(before, { old: 'def outer():\n    return 1', new: 'def outer():\n    def inner():\n        return 2\n    return inner()' });
  assert.equal(result.ok, true);
  assert.ok(result.text.includes('        def inner():\n            return 2'));
  const literal = applyEdit('2│ keep this', { old: '2│ keep this', new: '2│ changed' });
  assert.equal(literal.text, '2│ changed');
  assert.equal(literal.metadata.line_numbers_stripped, undefined);
});

test('real YAML Loader registers tools and syntax rejects before file publication', async () => {
  const h = await harness({ observe: true });
  try {
    assert.deepEqual(h.ctx.tools.schemas().map(s => s.name), ['safe_edit', 'multi_edit', 'safe_rollback', 'http_get', 'http_post', 'db_query', 'code_index', 'code_explore', 'code_diff_impact', 'syntax_check']);
    const path = join(h.workspace, 'config.json');
    await writeFile(path, '{"value": 1}');
    const failed = await h.call('safe_edit', { filepath: 'config.json', old: '1', new: '' });
    assert.equal(failed.isError, false, JSON.stringify(failed));
    assert.equal(failed.value.ok, false);
    assert.equal(failed.value.unchanged, true);
    assert.equal(await readFile(path, 'utf8'), '{"value": 1}');
    const good = await h.call('safe_edit', { filepath: 'config.json', old: '1', new: '2' });
    assert.equal(good.value.ok, true, JSON.stringify(good));
    assert.equal(await readFile(path, 'utf8'), '{"value": 2}');
    await h.ctx.loader.update('irmia', { disabled: true });
    await h.ctx.loader.await();
    assert.equal(h.ctx.tools.schemas().length, 0);
  } finally { await h.dispose(); }
});

test('sequential multi edits preserve CRLF and safe rollback is undoable', async () => {
  const h = await harness();
  try {
    const path = join(h.workspace, 'text.txt');
    await writeFile(path, 'first\r\nsecond\r\n');
    const result = await h.call('multi_edit', { edits: [
      { file: 'text.txt', old: 'first', new: 'middle' }, { file: 'text.txt', old: 'middle', new: 'last' },
    ] });
    assert.equal(result.value.ok, true, JSON.stringify(result));
    assert.equal(await readFile(path, 'utf8'), 'last\r\nsecond\r\n');
    const list = await h.call('safe_rollback', { filepath: 'text.txt', list: true });
    assert.equal(list.value.backups.length, 1);
    const restored = await h.call('safe_rollback', { filepath: 'text.txt' });
    assert.equal(restored.value.ok, true, JSON.stringify(restored));
    assert.equal(await readFile(path, 'utf8'), 'first\r\nsecond\r\n');
    const undo = await h.call('safe_rollback', { filepath: 'text.txt', backup_name: restored.value.prerollback_backup });
    assert.equal(undo.value.ok, true);
    assert.equal(await readFile(path, 'utf8'), 'last\r\nsecond\r\n');
  } finally { await h.dispose(); }
});

test('backup listing is read-only and foreign backup names are rejected', async () => {
  const h = await harness();
  try {
    await writeFile(join(h.workspace, 'a.txt'), 'before');
    const list = await h.call('safe_rollback', { filepath: 'a.txt', list: true });
    assert.equal(list.value.backups.length, 0);
    await assert.rejects(access(h.stateDir));
    await h.call('safe_edit', { filepath: 'a.txt', old: 'before', new: 'after' });
    const rejected = await h.call('safe_rollback', { filepath: 'a.txt', backup_name: '../escape.json' });
    assert.equal(rejected.isError, true);
    assert.equal(await readFile(join(h.workspace, 'a.txt'), 'utf8'), 'after');
  } finally { await h.dispose(); }
});

test('second write failure restores the first file without masking diagnostics', async () => {
  const h = await harness();
  try {
    await writeFile(join(h.workspace, 'a.txt'), 'a'); await writeFile(join(h.workspace, 'b.txt'), 'b');
    const original = h.ctx.fs.writeText.bind(h.ctx.fs);
    let fault = true;
    h.ctx.fs.writeText = async (...args) => {
      if (fault && args[0].displayPath.endsWith('b.txt')) { fault = false; throw new Error('injected second write failure'); }
      return original(...args);
    };
    const result = await h.call('multi_edit', { edits: [{ file: 'a.txt', old: 'a', new: 'A' }, { file: 'b.txt', old: 'b', new: 'B' }] });
    assert.equal(result.value.ok, false);
    assert.equal(result.value.rolled_back_all, true, JSON.stringify(result));
    assert.equal(await readFile(join(h.workspace, 'a.txt'), 'utf8'), 'a');
    assert.equal(await readFile(join(h.workspace, 'b.txt'), 'utf8'), 'b');
  } finally { await h.dispose(); }
});

test('recovery conflicts preserve human changes and snapshots', async () => {
  const h = await harness();
  try {
    await writeFile(join(h.workspace, 'a.txt'), 'a'); await writeFile(join(h.workspace, 'b.txt'), 'b');
    const original = h.ctx.fs.writeText.bind(h.ctx.fs);
    h.ctx.fs.writeText = async (...args) => {
      if (args[0].displayPath.endsWith('b.txt')) { await writeFile(join(h.workspace, 'a.txt'), 'human'); throw new Error('injected failure'); }
      return original(...args);
    };
    const result = await h.call('multi_edit', { edits: [{ file: 'a.txt', old: 'a', new: 'A' }, { file: 'b.txt', old: 'b', new: 'B' }] });
    assert.equal(result.value.rolled_back_all, false);
    assert.equal(result.value.rollback_errors.length, 1);
    assert.equal(await readFile(join(h.workspace, 'a.txt'), 'utf8'), 'human');
    assert.equal((await readdir(join(h.stateDir, 'backups'))).length, 2);
  } finally { await h.dispose(); }
});

test('read-only denies edits before snapshots and workspace-write denies outside files', async () => {
  for (const mode of ['read-only', 'workspace-write']) {
    const h = await harness({ sandboxMode: mode });
    const path = mode === 'read-only' ? join(h.workspace, 'a.txt')
      : fileURLToPath(new URL(`../../irmia-alignment-research/test-output/irmia-outside-${randomUUID()}.txt`, import.meta.url));
    try {
      await writeFile(path, 'before');
      const result = await h.call('safe_edit', { filepath: path, old: 'before', new: 'after' });
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(result.error.info.code, 'FS_SANDBOX_DENIED');
      assert.equal(await readFile(path, 'utf8'), 'before');
      await assert.rejects(access(h.stateDir));
      const refused = await h.call('safe_edit', { filepath: path, old: 'before', new: 'after', sandbox_permissions: 'danger-full-access', justification: 'test wider request' });
      assert.equal(refused.isError, true);
      assert.equal(await readFile(path, 'utf8'), 'before');
    } finally {
      if (mode === 'workspace-write') await unlink(path);
      await h.dispose();
    }
  }
});

test('raw helper restores BOM and legacy bytes and refuses a changed target', async () => {
  const h = await harness();
  try {
    const path = join(h.workspace, 'legacy.txt');
    const bytes = Buffer.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]);
    await writeFile(path, 'new');
    await restoreRaw({ path, expectedSha256: byteHash(Buffer.from('new')), contentBase64: bytes.toString('base64'), maxBytes: 4096 });
    assert.deepEqual(await readFile(path), bytes);
    await assert.rejects(restoreRaw({ path, expectedSha256: byteHash(Buffer.from('wrong')), contentBase64: Buffer.from('bad').toString('base64'), maxBytes: 4096 }), /其他操作修改/);
    assert.deepEqual(await readFile(path), bytes);
  } finally { await h.dispose(); }
});
