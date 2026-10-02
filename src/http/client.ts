import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { setTimeout as wait } from 'node:timers/promises';
import iconv from 'iconv-lite';
import { detect } from 'chardet';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { createHash } from 'node:crypto';
import { publicAddress, resolveDns, SsrfBlocked } from './ssrf.js';
import type { Address, ResolveDns } from './ssrf.js';
import { errorMessage, failure } from '../protocol.js';
import type { Result, Json } from '../protocol.js';

export interface Body { url: string; status: number; headers: Record<string, string>; bytes: Buffer }
export interface RequestSpec { url: URL; address: Address; method: 'GET' | 'POST'; headers: Record<string, string>; data?: Buffer; timeoutMs: number; maxBytes: number; signal: AbortSignal }
export type Transport = (spec: RequestSpec) => Promise<Body>;

/** 固定 DNS 解析结果，保留原 Host/SNI，且不使用环境代理。 */
export const nodeTransport: Transport = spec => new Promise((resolve, reject) => {
  const client = spec.url.protocol === 'https:' ? httpsRequest : httpRequest;
  const req = client(spec.url, {
    method: spec.method, headers: spec.headers, signal: spec.signal, agent: false,
    lookup: (_host, options, callback) => {
      if (typeof options === 'object' && options.all) callback(null, [spec.address]);
      else callback(null, spec.address.address, spec.address.family);
    },
  }, response => {
    const chunks: Buffer[] = []; let total = 0;
    response.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > spec.maxBytes) { req.destroy(new Error('响应超过大小上限')); return; }
      chunks.push(Buffer.from(chunk));
    });
    response.on('end', () => resolve({ url: spec.url.href, status: response.statusCode ?? 0,
      headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(',') : value ?? ''])), bytes: Buffer.concat(chunks) }));
    response.on('error', reject);
  });
  const timer = setTimeout(() => req.destroy(new Error(`HTTP 请求超过 ${spec.timeoutMs}ms`)), spec.timeoutMs);
  req.once('close', () => clearTimeout(timer)); req.once('error', reject); req.end(spec.data);
});

function decode(body: Body, maxBytes: number): string {
  let bytes = body.bytes;
  const encoding = body.headers['content-encoding']?.toLowerCase();
  if (encoding === 'gzip') bytes = gunzipSync(bytes, { maxOutputLength: maxBytes });
  else if (encoding === 'deflate') bytes = inflateSync(bytes, { maxOutputLength: maxBytes });
  else if (encoding === 'br') bytes = brotliDecompressSync(bytes, { maxOutputLength: maxBytes });
  else if (encoding && encoding !== 'identity') throw new Error(`不支持 Content-Encoding: ${encoding}`);
  if (bytes.length > maxBytes) throw new Error('解压后响应超过大小上限');
  const charset = /charset\s*=\s*([^;]+)/i.exec(body.headers['content-type'] ?? '')?.[1]?.trim().replace(/["']/g, '');
  if (charset && iconv.encodingExists(charset)) return iconv.decode(bytes, charset);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { const found = detect(bytes.subarray(0, 64 * 1024)); return iconv.decode(bytes, found && iconv.encodingExists(found) ? found : 'gb18030'); }
}

function binary(body: Body): boolean {
  const type = body.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? '';
  return /^(image|audio|video)\//.test(type) || /application\/(pdf|octet-stream|zip|gzip|x-7z-compressed)/.test(type);
}
function normalizedHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]).sort(([a], [b]) => a!.localeCompare(b!)));
}

export interface HttpConfig { timeoutMs: number; maxBytes: number; pageChars: number; cacheTtlMs: number; cacheEntries: number }
export interface GetArgs { url: string; headers?: Record<string, string>; format?: 'markdown' | 'text' | 'html'; extract?: boolean; offset?: number; timeout?: number }
export interface PostArgs { url: string; data?: Json; headers?: Record<string, string>; timeout?: number }
interface CacheEntry { expires: number; result: Result; text: string }

/** 独立会话缓存与有界请求所有者；测试只替换网络/DNS，不跳过地址校验。 */
export class HttpClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly live = new Set<AbortController>();
  private closed = false;
  constructor(private readonly config: HttpConfig, private readonly transport: Transport = nodeTransport,
              private readonly dns: ResolveDns = resolveDns) {}

  private async request(urlString: string, headers: Record<string, string>, method: 'GET' | 'POST', signal: AbortSignal, timeout?: number, data?: Buffer): Promise<{ body: Body; retries: number }> {
    signal.throwIfAborted();
    if (this.closed) throw new Error('Irmia HTTP 服务已卸载');
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true }); this.live.add(controller);
    if (signal.aborted) abort();
    const budget = timeout === undefined ? this.config.timeoutMs : Math.min(600_000, Math.max(1000, timeout * 1000));
    const started = Date.now(); const timer = setTimeout(() => controller.abort(new Error('HTTP 总时间预算耗尽')), Math.min(180_000, budget));
    let url = new URL(urlString); let retries = 0; let redirects = 0;
    let currentHeaders = { 'user-agent': 'IrmiaDevKit/0.2.0', 'accept-encoding': 'gzip, deflate, br', ...normalizedHeaders(headers) };
    let currentMethod = method, currentData = data;
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const address = await publicAddress(url, this.dns);
        controller.signal.throwIfAborted();
        let body: Body;
        try {
          body = await this.transport({ url, address, method: currentMethod, headers: currentHeaders, data: currentData,
            timeoutMs: Math.max(1, Math.min(budget, 180_000) - (Date.now() - started)), maxBytes: this.config.maxBytes, signal: controller.signal });
        } catch (error: unknown) {
          if (method !== 'GET' || retries >= 2 || controller.signal.aborted || error instanceof SsrfBlocked || /大小上限|不支持/.test(errorMessage(error))) throw error;
          await wait(250 * 2 ** retries++, undefined, { signal: controller.signal }); continue;
        }
        if (body.status >= 500 && method === 'GET' && retries < 2) { await wait(250 * 2 ** retries++, undefined, { signal: controller.signal }); continue; }
        if ([301, 302, 303, 307, 308].includes(body.status) && body.headers.location) {
          if (++redirects > 10) throw new Error('重定向超过 10 次上限');
          const next = new URL(body.headers.location, url);
          if (next.origin !== url.origin) currentHeaders = Object.fromEntries(Object.entries(currentHeaders).filter(([key]) => !['authorization', 'cookie', 'proxy-authorization', 'host'].includes(key))) as typeof currentHeaders;
          if (currentMethod === 'POST' && [301, 302, 303].includes(body.status)) { currentMethod = 'GET'; currentData = undefined; delete currentHeaders['content-length' as keyof typeof currentHeaders]; }
          url = next; continue;
        }
        return { body, retries };
      }
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); this.live.delete(controller); }
  }

  async get(args: GetArgs, owner: string, signal: AbortSignal): Promise<Result> {
    const offset = args.offset ?? 0, format = args.format ?? 'markdown', headers = args.headers ?? {};
    if (!Number.isInteger(offset) || offset < 0) return failure('offset 必须为非负整数');
    const key = createHash('sha256').update(JSON.stringify([owner, args.url, normalizedHeaders(headers), format, args.extract ?? false])).digest('hex');
    const hit = this.cache.get(key);
    let entry: CacheEntry;
    if (offset > 0 && hit !== undefined && hit.expires > Date.now()) entry = hit;
    else {
      const { body, retries } = await this.request(args.url, headers, 'GET', signal, args.timeout);
      const base = { status: body.status, final_url: body.url, content_type: body.headers['content-type'] ?? '', retries };
      if (binary(body)) return failure('响应是二进制文件，不作为文本解码', { ...base, hint: '使用当前宿主的下载能力保存该资源；本插件不注册 http_download' });
      const raw = decode(body, this.config.maxBytes);
      if (body.status >= 400) return failure(`HTTP ${body.status}`, { ...base, body: raw.slice(0, 4096), hint: body.status === 429 ? '被限流，请稍后重试' : '检查地址、请求头和服务器状态' });
      let text = raw; let converter = 'raw';
      if (/html/i.test(body.headers['content-type'] ?? '') && format !== 'html') {
        const document = parseHTML(raw).document;
        for (const node of Array.from(document.querySelectorAll('script,style,noscript,template'))) node.remove();
        const article = args.extract ? new Readability(document).parse() : undefined;
        const html = article?.content ?? document.toString();
        if (format === 'markdown') { text = new TurndownService().turndown(html); converter = article ? 'readability+turndown' : 'turndown'; }
        else { text = article?.textContent ?? document.body?.textContent ?? document.textContent ?? ''; converter = 'text'; }
      }
      entry = { expires: Date.now() + this.config.cacheTtlMs, result: { ok: true, ...base, converter }, text };
      this.cache.delete(key); this.cache.set(key, entry);
      while (this.cache.size > this.config.cacheEntries) this.cache.delete(this.cache.keys().next().value!);
    }
    signal.throwIfAborted();
    const content = entry.text.slice(offset, offset + this.config.pageChars), hasMore = offset + content.length < entry.text.length;
    return { ...entry.result, content, offset, has_more: hasMore,
      ...(hasMore ? { next_call: { tool: 'http_get', params: { ...args, offset: offset + content.length } } } : {}) };
  }

  async post(args: PostArgs, signal: AbortSignal): Promise<Result> {
    const headers = normalizedHeaders(args.headers ?? {});
    const value = args.data ?? '';
    const data = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    if (typeof value !== 'string') headers['content-type'] ??= 'application/json';
    headers['content-length'] = String(data.length);
    const { body } = await this.request(args.url, headers, 'POST', signal, args.timeout, data);
    const base = { status: body.status, final_url: body.url, content_type: body.headers['content-type'] ?? '', retries: 0 };
    if (binary(body)) return failure('POST 响应是二进制内容', base);
    const text = decode(body, this.config.maxBytes);
    return body.status >= 400 ? failure(`HTTP ${body.status}`, { ...base, body: text.slice(0, 4096) }) : { ok: true, ...base, content: text.slice(0, this.config.pageChars), truncated: text.length > this.config.pageChars };
  }

  clear(): void { this.cache.clear(); }
  dispose(): void { this.closed = true; for (const controller of this.live) controller.abort(); this.clear(); }
}
