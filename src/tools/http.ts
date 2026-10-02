import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { HttpClient } from '../http/client.js';
import type { Json } from '../protocol.js';

const headers = { type: 'object', additionalProperties: true, description: '请求头键值对' } as const;
function headerMap(input: Record<string, Json> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    if (typeof value !== 'string') throw new Error(`请求头 ${name} 必须为字符串`);
    output[name] = value;
  }
  return output;
}

/** 会话的缓存身份取自不可变会话头，不用全局共享凭据页。 */
function owner(exec: ToolRunContext): string { return exec.agent?.session.header.id ?? 'agentless'; }

export function registerHttpTools(ctx: Context, client: HttpClient): void {
  ctx.tools.register(defineTool({
    name: 'http_get', description: 'Fetch public HTTP(S) content with private-address filtering, fixed validated DNS, bounded decoding and cached pagination. Use web_fetch for a simple fetch.',
    parameters: {
      url: { type: 'string', required: true }, headers,
      format: { type: 'string', enum: ['markdown', 'text', 'html'] }, extract: { type: 'boolean' },
      timeout: { type: 'integer', description: '总请求预算秒数，默认部署配置' }, offset: { type: 'integer' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: (args, exec) => client.get({ ...args, headers: headerMap(args.headers) }, owner(exec), exec.signal),
  }));
  ctx.tools.register(defineTool({
    name: 'http_post', description: 'POST JSON or raw text to a public HTTP(S) URL with the same private-address protections. POST is never automatically retried.',
    parameters: { url: { type: 'string', required: true }, data: { type: 'json' }, headers, timeout: { type: 'integer' } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: (args, exec) => client.post({ ...args, headers: headerMap(args.headers) }, exec.signal),
  }));
}
