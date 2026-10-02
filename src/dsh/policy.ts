import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { FsTarget } from '@deepseek-ai/dsh-fs';
import { FsError } from '@deepseek-ai/dsh-fs';
import {
  approveEscalation, validateEscalationArgs, sandboxDenialMarker, escalationHintMarker,
  sandboxPermissionsDescription, canonicalPath, writableRoots,
} from '@deepseek-ai/dsh-sandbox';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import type {} from '@deepseek-ai/dsh-user-approval';
import { isAbsolute, relative, sep } from 'node:path';

/** 仅在受限组合中公开的单次审批参数。 */
export interface EscalationArgs { sandbox_permissions?: string; justification?: string }

/** 每次调用从会话解析政策，文件服务仍是实际写入的最终裁决者。 */
export class FilePolicy {
  readonly confined: boolean;
  constructor(private readonly ctx: Context) {
    this.confined = ctx.fs.sandboxMode !== undefined;
    if (this.confined && ctx.get('sandboxPolicy') === undefined) throw new Error('Irmia: 受限文件服务缺少 sandboxPolicy');
  }

  schemaFields() {
    return {
      sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: sandboxPermissionsDescription('operation') },
      justification: { type: 'string', description: '申请更宽权限时说明本次操作的理由。' },
    } as const;
  }

  async resolve(toolName: string, args: EscalationArgs, exec: ToolExecution): Promise<SandboxExecutionPolicy | undefined> {
    validateEscalationArgs(args.sandbox_permissions, args.justification);
    const service = this.ctx.get('sandboxPolicy');
    const standing = service?.resolve({ session: exec.agent?.session });
    if (args.sandbox_permissions === undefined) return standing;
    if (!this.confined || standing === undefined) throw new Error('当前组合不提供 sandbox_permissions');
    const mode = await approveEscalation({
      requestedMode: args.sandbox_permissions, justification: args.justification!, effectiveMode: standing.mode, subject: 'operation',
    }, { approver: this.ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName, signal: exec.signal });
    return { ...standing, mode };
  }

  assertMutable(policy: SandboxExecutionPolicy | undefined): void {
    if (policy?.mode === 'read-only') throw this.denial(policy);
  }

  async assertWritable(target: FsTarget, policy: SandboxExecutionPolicy | undefined): Promise<void> {
    if (policy === undefined || policy.mode === 'danger-full-access') return;
    this.assertMutable(policy);
    // 用 provider 的 contains 和重新解析的身份预检，不能解析 targetKey。
    for (const path of writableRoots(policy)) {
      const root = await this.ctx.fs.resolve(path);
      if (this.ctx.fs.contains(root, target)) return;
    }
    throw this.denial(policy);
  }

  private denial(policy: SandboxExecutionPolicy): FsError {
    return new FsError(`${sandboxDenialMarker(policy.mode)}\n${escalationHintMarker('operation')}`, 'FS_SANDBOX_DENIED');
  }

  mapError(error: unknown, policy: SandboxExecutionPolicy | undefined): unknown {
    if (error instanceof FsError && error.code === 'FS_SANDBOX_DENIED' && policy !== undefined) return this.denial(policy);
    return error;
  }
}

/** 插件内部状态不能位于被编辑项目内，也不能成为被编辑文件的父子路径别名。 */
export function isWithin(root: string, path: string): boolean {
  const delta = relative(canonicalPath(root), canonicalPath(path));
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta));
}
