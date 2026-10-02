import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRunner } from '../lib/runtime/tasks.js';

const samples = [
  ['python', 'example.py', '@decorator\nasync def sample(x):\n    match x:\n        case 1: return x\n', 'def sample(:\n'],
  ['typescript', 'example.ts', 'export const answer: number = 42;', 'export const answer: = ;'],
  ['tsx', 'Widget.tsx', 'export const W = () => <div />;', 'export const W = () => <div>;'],
  ['rust', 'example.rs', 'fn sample() {}', 'fn sample( {'],
  ['java', 'random.java', 'public class Foo { Missing dependency; }', 'public class { }'],
  ['cpp', 'example.cpp', 'int main() { return 0; }', 'int main( {'],
  ['json', 'config.json', '{"value": 1}', '{"value": }'],
  ['toml', 'config.toml', 'value = 1', '[value'],
  ['yaml', 'config.yaml', 'value: [1,2]', 'value: [1,2'],
];
for (const [language, filename, valid, invalid] of samples) {
  test(`native ${language} checks syntax without executing source`, async () => {
    const runner = new TaskRunner();
    try {
      const checked = await runner.run({ kind: 'syntax', filename, source: valid, timeoutMs: 10_000 }, new AbortController().signal);
      assert.equal(checked.ok, true, JSON.stringify(checked));
      const failed = await runner.run({ kind: 'syntax', filename, source: invalid, timeoutMs: 10_000 }, new AbortController().signal);
      assert.equal(failed.ok, false, JSON.stringify(failed));
      assert.ok(failed.errors.length > 0);
    } finally {
      await runner.dispose();
    }
  });
}

test('worker honors cancellation and bounded execution', async () => {
  const runner = new TaskRunner();
  try {
    const controller = new AbortController();
    const pending = runner.run({ kind: 'syntax', filename: 'large.py', source: 'x = 1\n'.repeat(100_000), timeoutMs: 10_000 }, controller.signal);
    controller.abort();
    await assert.rejects(pending, /取消/);
    await assert.rejects(runner.run({ kind: 'syntax', filename: 'simple.py', source: 'x = 1', timeoutMs: 1 }, new AbortController().signal), /超过/);
  } finally {
    await runner.dispose();
  }
  await assert.rejects(runner.run({ kind: 'syntax', filename: 'simple.py', source: 'x = 1', timeoutMs: 1000 }, new AbortController().signal), /卸载/);
});
