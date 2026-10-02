import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { CodeGraphService } from '../codegraph/service.js';

/** 保留 MCP 合并的 code_status→code_index(status=true) 形态。 */
export function registerCodeGraphTools(ctx: Context, service: CodeGraphService): void {
  const output = { schema: { type: 'json' }, render: (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }] } as const;
  ctx.tools.register(defineTool({
    name: 'code_index', description: 'Build or update a bounded semantic code index in plugin-owned state. Use incremental=true after edits; status=true only reads an existing index.',
    parameters: { project_dir: { type: 'string', description: '项目目录' }, incremental: { type: 'boolean' }, status: { type: 'boolean' } }, output,
    async execute(args, exec) { if (args.status) return service.status(args.project_dir ?? '.', exec); return service.index(args.project_dir ?? '.', args.incremental ?? false, exec); },
  }));
  ctx.tools.register(defineTool({
    name: 'code_explore', description: 'Search indexed symbols by exact name or file. Build the index first; results include project-relative locations and stale-index context.',
    parameters: { query: { type: 'string', required: true }, project_dir: { type: 'string' } }, output,
    execute: (args, exec) => service.explore(args.project_dir ?? '.', args.query, exec),
  }));
  ctx.tools.register(defineTool({
    name: 'code_diff_impact', description: 'Use an existing index to report bounded static callers affected by changed files. Dynamic calls may not appear.',
    parameters: { filepaths: { type: 'array', required: true, items: { type: 'string' } }, max_depth: { type: 'integer' }, project_dir: { type: 'string' } }, output,
    execute: (args, exec) => service.impact(args.project_dir ?? '.', args.filepaths, args.max_depth ?? 3, exec),
  }));
}
