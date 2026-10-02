import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { EditTransactions } from '../edit/transaction.js';
import type { FilePolicy } from '../dsh/policy.js';

const editFields = {
  old: { type: 'string', description: 'replace 模式要替换的原文' },
  new: { type: 'string', description: '新内容，空串表示删除' },
  occurrence: { type: 'integer', description: '替换第 N 次出现，1-based；默认 0 要求唯一' },
  replace_all: { type: 'boolean', description: '替换所有匹配，不能同时指定 occurrence' },
  align_whitespace: { type: 'boolean', description: '缩进容错时保留内部缩进层次，默认 true' },
  mode: { type: 'string', enum: ['replace', 'insert_at_line', 'delete_lines'], description: '编辑模式，默认 replace' },
  line: { type: 'integer', description: '指定行后插入，0=开头' },
  start_line: { type: 'integer', description: '闭区间删除的起始行，1-based' },
  end_line: { type: 'integer', description: '闭区间删除的结束行，1-based' },
} as const;

/** 三个既有编辑工具，保留合并备份列表和多文件参数。 */
export function registerEditTools(ctx: Context, edits: EditTransactions, policy: FilePolicy): void {
  const output = { schema: { type: 'json' }, render: (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }] } as const;
  const register = (definition: ToolDefinition): void => {
    if (policy.confined) { ctx.tools.register(definition); return; }
    // 只裁剪展示给模型的可选审批字段；执行器仍拒绝无沙箱组合的升权参数。
    const properties = Object.fromEntries(Object.entries(definition.parameters.properties ?? {})
      .filter(([key]) => key !== 'sandbox_permissions' && key !== 'justification'));
    ctx.tools.register({ ...definition, parameters: { ...definition.parameters, properties } });
  };
  register(defineTool({
    name: 'safe_edit',
    description: 'Edit an existing file with a recoverable snapshot, exact-match disambiguation, line modes and syntax validation before writing. A skipped check is not a pass.',
    parameters: { filepath: { type: 'string', required: true, description: '文件路径' }, ...editFields, ...policy.schemaFields() },
    output,
    async execute(args, exec) {
      const result = await edits.edit([{ ...args, file: args.filepath }], exec, args);
      if (result.ok) {
        const backups = result.backups;
        const file = Array.isArray(result.applied) && typeof result.applied[0] === 'string' ? result.applied[0] : args.filepath;
        return { ...result, file, backup: backups !== null && typeof backups === 'object' && !Array.isArray(backups) ? backups[file] ?? null : null,
          replaced: result.replacements_made ?? 0 };
      }
      return result;
    },
    presentCall: args => ({ card: 'generic', kind: 'edit', title: 'safe_edit', locations: [{ path: args.filepath }] }),
  }));
  register(defineTool({
    name: 'multi_edit',
    description: 'Plan sequential edits for each file, check all candidates, then commit with compensating rollback. On a recovery conflict, preserve snapshots and report affected files.',
    parameters: {
      edits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        file: { type: 'string' }, filepath: { type: 'string' }, ...editFields,
      } }, description: '编辑列表；同一文件按顺序应用' },
      syntax_check: { type: 'boolean', description: '提交前检查全部候选，默认 true' },
      ...policy.schemaFields(),
    },
    output,
    execute: (args, exec) => edits.edit(args.edits, exec, args, args.syntax_check ?? true),
  }));
  register(defineTool({
    name: 'safe_rollback',
    description: 'Restore an owned snapshot, or list snapshots with list=true without mutating state. A restore first snapshots the current state and never overwrites a recovery conflict.',
    parameters: {
      filepath: { type: 'string', required: true, description: '目标文件路径' },
      backup_name: { type: 'string', description: '指定备份名称，省略则用最新' },
      list: { type: 'boolean', description: '只列出备份，不创建目录和快照' },
      ...policy.schemaFields(),
    },
    output,
    execute: (args, exec) => edits.rollback(args.filepath, args.backup_name, args.list ?? false, exec, args),
  }));
}
