import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { Config, resolveSettings } from './config.js';
import type { Settings } from './config.js';
import { TaskRunner } from './runtime/tasks.js';
import { FilePolicy } from './dsh/policy.js';
import { Files } from './dsh/files.js';
import { Processes } from './dsh/process.js';
import { SyntaxService } from './syntax/service.js';
import { BackupStore } from './edit/backups.js';
import { EditTransactions } from './edit/transaction.js';
import { registerEditTools } from './tools/edit.js';
import { HttpClient } from './http/client.js';
import { registerHttpTools } from './tools/http.js';
import { registerDbTool } from './tools/db.js';
import { CodeGraphService } from './codegraph/service.js';
import { registerCodeGraphTools } from './tools/codegraph.js';

export { Config };
/** Cordis 诊断名，保留既有插件行身份。 */
export const name = 'tool-irmia-devkit';
/** 文件、工具及提示均使用宿主的实际服务。 */
export const inject = ['tools', 'fs', 'systemPrompt'];

/** 资源先停止事务恢复，再释放计算与进程；注册项由 Cordis effect 管理。 */
export function apply(ctx: Context, raw: Settings): void {
  const config = resolveSettings(raw);
  const tasks = new TaskRunner();
  const policy = new FilePolicy(ctx);
  const files = new Files(ctx, config, policy);
  const processes = new Processes(ctx, config);
  const syntax = new SyntaxService(ctx, config, tasks, processes);
  const backups = new BackupStore(config);
  const edits = new EditTransactions(ctx, config, files, policy, backups, syntax, processes);
  const graph = new CodeGraphService(files, policy, tasks, config);
  const http = new HttpClient({ timeoutMs: config.httpTimeoutMs, maxBytes: config.httpMaxBytes, pageChars: config.httpPageChars, cacheTtlMs: config.cacheTtlMs, cacheEntries: config.cacheEntries });
  ctx.effect(() => async () => {
    http.dispose();
    await edits.dispose();
    await tasks.dispose();
    await processes.dispose();
  }, 'irmia resource cleanup');
  if (config.enabledGroups.includes('edit')) registerEditTools(ctx, edits, policy);
  if (config.enabledGroups.includes('http')) registerHttpTools(ctx, http);
  if (config.enabledGroups.includes('db')) registerDbTool(ctx, files, config, tasks);
  if (config.enabledGroups.includes('codegraph')) registerCodeGraphTools(ctx, graph);
  if (config.enabledGroups.includes('syntax')) ctx.tools.register(defineTool({
    name: 'syntax_check',
    description: 'Parse code or configuration without executing it. Return line diagnostics or an explicit skipped result; this is not a type checker.',
    parameters: { filepath: { type: 'string', required: true, description: '文件路径，相对于当前会话项目' } },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const target = await files.resolve(args.filepath, exec);
      const source = await files.read(target, exec);
      const standing = ctx.get('sandboxPolicy')?.resolve({ session: exec.agent?.session });
      return syntax.check(source.path, source.text, exec, standing);
    },
  }));
  ctx.systemPrompt.section({
    name: 'tool:irmia-devkit', order: 150,
    text: 'Use safe_edit for recoverable edits and multi_edit for sequential or cross-file edits. Syntax is checked before writing; skipped checks are not passes. A failed partial batch attempts recovery but reports conflicts instead of overwriting external changes. Do not commit or push without user authorization.',
  });
}
