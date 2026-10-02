import type { Address, ResolveDns } from './ssrf.js';
import type { Result, Json } from '../protocol.js';
export interface Body {
    url: string;
    status: number;
    headers: Record<string, string>;
    bytes: Buffer;
}
export interface RequestSpec {
    url: URL;
    address: Address;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    data?: Buffer;
    timeoutMs: number;
    maxBytes: number;
    signal: AbortSignal;
}
export type Transport = (spec: RequestSpec) => Promise<Body>;
/** 固定 DNS 解析结果，保留原 Host/SNI，且不使用环境代理。 */
export declare const nodeTransport: Transport;
export interface HttpConfig {
    timeoutMs: number;
    maxBytes: number;
    pageChars: number;
    cacheTtlMs: number;
    cacheEntries: number;
}
export interface GetArgs {
    url: string;
    headers?: Record<string, string>;
    format?: 'markdown' | 'text' | 'html';
    extract?: boolean;
    offset?: number;
    timeout?: number;
}
export interface PostArgs {
    url: string;
    data?: Json;
    headers?: Record<string, string>;
    timeout?: number;
}
/** 独立会话缓存与有界请求所有者；测试只替换网络/DNS，不跳过地址校验。 */
export declare class HttpClient {
    private readonly config;
    private readonly transport;
    private readonly dns;
    private readonly cache;
    private readonly live;
    private closed;
    constructor(config: HttpConfig, transport?: Transport, dns?: ResolveDns);
    private request;
    get(args: GetArgs, owner: string, signal: AbortSignal): Promise<Result>;
    post(args: PostArgs, signal: AbortSignal): Promise<Result>;
    clear(): void;
    dispose(): void;
}
