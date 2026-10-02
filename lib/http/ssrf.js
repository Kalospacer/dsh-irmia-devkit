import ipaddr from 'ipaddr.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
export class SsrfBlocked extends Error {
}
/** 与 MCP 相同的私网、保留、CGNAT 和映射地址约束。 */
export function blockedIp(text) {
    if (!ipaddr.isValid(text))
        return true;
    let address = ipaddr.parse(text);
    if (address.kind() === 'ipv6' && address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress())
        address = address.toIPv4Address();
    if (address.range() !== 'unicast')
        return true;
    const extra = ['192.0.0.0/24', '192.0.2.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24'];
    if (address.kind() === 'ipv4')
        return extra.some(cidr => address.match(ipaddr.parseCIDR(cidr)));
    return false;
}
export const resolveDns = async (host) => (await lookup(host, { all: true })).map(result => ({ address: result.address, family: result.family === 6 ? 6 : 4 }));
/** 返回唯一已验证的连接地址；传输层必须使用它，不能重新 DNS。 */
export async function publicAddress(url, resolve = resolveDns) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new SsrfBlocked('只允许 HTTP/HTTPS URL');
    if (url.username || url.password)
        throw new SsrfBlocked('URL 不能内嵌凭据，请使用 headers');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!hostname)
        throw new SsrfBlocked('URL 缺少主机名');
    const literal = isIP(hostname);
    const addresses = literal ? [{ address: hostname, family: literal === 6 ? 6 : 4 }] : await resolve(hostname);
    if (!addresses.length || addresses.some(item => blockedIp(item.address)))
        throw new SsrfBlocked('SSRF 安全策略拒绝该地址');
    return addresses[0];
}
//# sourceMappingURL=ssrf.js.map