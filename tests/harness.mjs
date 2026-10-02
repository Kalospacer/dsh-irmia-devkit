import { Context } from '@deepseek-ai/cordis';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { parse, stringify } from 'yaml';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 测试目录和真实 provider 均由当前测试拥有，不写入用户 profile。 */
export async function harness(options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'irmia-loader-'));
  const workspace = join(base, 'workspace');
  const stateDir = join(base, 'state');
  await mkdir(workspace);
  const entries = [
    { id: 'prompt', name: '@deepseek-ai/dsh-system-prompt' },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    { id: 'fs', name: '@deepseek-ai/dsh-fs-local', config: { cwd: workspace } },
    { id: 'irmia', name: new URL('../lib/index.js', import.meta.url).href, config: { stateDir, enabledGroups: ['edit', 'syntax', 'http', 'codegraph', 'db'], ...options.config } },
  ];
  if (options.sandboxMode) entries.splice(2, 0,
    { id: 'projection', name: '@deepseek-ai/dsh-session-projection' },
    { id: 'policy', name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: options.sandboxMode, workspaceRoot: workspace } });
  if (options.sandboxMode) entries.find(entry => entry.id === 'fs').name = '@deepseek-ai/dsh-fs-sandbox';
  if (options.observe) entries.splice(entries.length - 1, 0, { id: 'observation', name: '@deepseek-ai/dsh-fs-observation-policy' });
  const yamlPath = join(base, 'cordis.yml');
  await writeFile(yamlPath, stringify(entries));
  const ctx = new Context();
  await ctx.plugin(Loader, { baseUrl: new URL('../', import.meta.url).href });
  await ctx.loader.root.update(parse(await readFile(yamlPath, 'utf8')));
  await ctx.loader.await();
  let callId = 0;
  const observedAgent = options.observe ? { session: { header: { cwd: workspace } } } : undefined;
  const call = (name, args, extra = {}) => ctx.tools.execute({
    callId: ToolCallId(`test-${++callId}`), name, arguments: args, signal: new AbortController().signal,
    ...(observedAgent === undefined ? {} : { agent: observedAgent }), ...extra,
  });
  return { ctx, base, workspace, stateDir, call, dispose: async () => {
    await ctx.fiber.dispose();
    await rm(base, { recursive: true, force: true });
  } };
}
