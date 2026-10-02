import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';

test('default plugin exposes exactly the planned ten tools', async () => {
  const h = await harness();
  try {
    assert.deepEqual(h.ctx.tools.schemas().map(schema => schema.name), [
      'safe_edit', 'multi_edit', 'safe_rollback', 'http_get', 'http_post',
      'db_query', 'code_index', 'code_explore', 'code_diff_impact', 'syntax_check',
    ]);
  } finally { await h.dispose(); }
});

test('plugin config can disable a group without changing native services', async () => {
  const h = await harness({ config: { enabledGroups: ['edit', 'syntax'] } });
  try {
    assert.deepEqual(h.ctx.tools.schemas().map(schema => schema.name), ['safe_edit', 'multi_edit', 'safe_rollback', 'syntax_check']);
    assert.ok(h.ctx.fs);
  } finally { await h.dispose(); }
});
