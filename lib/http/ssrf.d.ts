export declare class SsrfBlocked extends Error {
}
export interface Address {
    address: string;
    family: 4 | 6;
}
export type ResolveDns = (host: string) => Promise<Address[]>;
/** 与 MCP 相同的私网、保留、CGNAT 和映射地址约束。 */
export declare function blockedIp(text: string): boolean;
export declare const resolveDns: ResolveDns;
/** 返回唯一已验证的连接地址；传输层必须使用它，不能重新 DNS。 */
export declare function publicAddress(url: URL, resolve?: ResolveDns): Promise<Address>;
