import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import iconv from 'iconv-lite';
import { HttpClient } from '../lib/http/client.js';
import { blockedIp, publicAddress } from '../lib/http/ssrf.js';

const config = { timeoutMs: 5000, maxBytes: 4096, pageChars: 20, cacheTtlMs: 300000, cacheEntries: 10 };
const dns = async () => [{ address: '8.8.8.8', family: 4 }];
const signal = () => new AbortController().signal;
const body = (spec, text, status = 200, headers = {}) => ({ url: spec.url.href, status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers }, bytes: Buffer.from(text) });

test('SSRF blocks private, mapped, CGNAT, link-local and reserved destinations', async () => {
  for (const ip of ['127.0.0.1','100.64.0.1','100.127.0.1','192.0.2.1','198.18.0.1','0.0.0.0','224.0.0.1','::1','::','fe80::1','::ffff:127.0.0.1']) assert.equal(blockedIp(ip), true, ip);
  assert.equal(blockedIp('8.8.8.8'), false);
  await assert.rejects(publicAddress(new URL('http://0177.0.0.1/'), dns), /SSRF/);
  await assert.rejects(publicAddress(new URL('https://example.org'), async () => [{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]), /SSRF/);
});

test('headers and owner isolate cache and next page makes zero requests', async () => {
  let requests=0;
  const client=new HttpClient(config,async spec=>{requests++;assert.equal(spec.address.address,'8.8.8.8');return body(spec,(spec.headers.authorization??'public').repeat(30));},dns);
  const args={url:'https://example.org',headers:{Authorization:'first'}};
  const first=await client.get(args,'session-a',signal());
  assert.equal(first.has_more,true); assert.equal(first.next_call.tool,'http_get');
  const next=await client.get(first.next_call.params,'session-a',signal());
  assert.equal(requests,1); assert.equal(next.offset,20);
  await client.get({...args,headers:{authorization:'second'},offset:20},'session-a',signal());
  await client.get({...args,offset:20},'session-b',signal());
  assert.equal(requests,3);
  client.dispose();
});

test('GET retries 5xx but POST and 4xx do not retry', async () => {
  let requests=0;
  const client=new HttpClient(config,async spec=>body(spec,'server',++requests<3?503:200),dns);
  const get=await client.get({url:'https://example.org'},'a',signal());assert.equal(requests,3);assert.equal(get.retries,2);
  requests=0;const post=await client.post({url:'https://example.org',data:{value:1}},signal());assert.equal(requests,1);assert.equal(post.ok,false);
  let four=0;const other=new HttpClient(config,async spec=>{four++;return body(spec,'denied',403)},dns);
  assert.equal((await other.get({url:'https://example.org'},'a',signal())).ok,false);assert.equal(four,1);
});

test('private redirects are not retried and cross-origin credentials are removed', async () => {
  let count=0;
  const client=new HttpClient(config,async spec=>{count++;return body(spec,'',302,{location:'http://127.0.0.1/'})},dns);
  await assert.rejects(client.get({url:'https://example.org'},'a',signal()),/SSRF/);assert.equal(count,1);
  const seen=[];
  const second=new HttpClient(config,async spec=>{seen.push(spec);return seen.length===1?body(spec,'',302,{location:'https://other.org/'}):body(spec,'ok')},dns);
  await second.get({url:'https://example.org',headers:{Authorization:'secret',Cookie:'session'}},'a',signal());
  assert.equal(seen[1].headers.authorization,undefined);assert.equal(seen[1].headers.cookie,undefined);
});

test('GBK decodes correctly and compressed output is bounded', async () => {
  const client=new HttpClient({...config,pageChars:100},async spec=>({...body(spec,''),bytes:iconv.encode('中文内容','gb18030'),headers:{'content-type':'text/plain; charset=GB18030'}}),dns);
  assert.equal((await client.get({url:'https://example.org'},'a',signal())).content,'中文内容');
  const bomb=new HttpClient(config,async spec=>({...body(spec,''),bytes:gzipSync('x'.repeat(100000)),headers:{'content-encoding':'gzip'}}),dns);
  await assert.rejects(bomb.get({url:'https://example.org'},'a',signal()));
});

test('HTML conversion strips scripts and binary responses give a usable hint', async () => {
  const client=new HttpClient({...config,pageChars:1000},async spec=>body(spec,'<html><body><h1>Title</h1><p>Useful text</p><script>secretJS()</script><style>.hidden{}</style></body></html>',200,{'content-type':'text/html'}),dns);
  const result=await client.get({url:'https://example.org'},'a',signal());assert.ok(result.content.includes('Useful text'));assert.ok(!result.content.includes('secretJS'));
  const binary=new HttpClient(config,async spec=>body(spec,'PDF',200,{'content-type':'application/pdf'}),dns);
  const response=await binary.get({url:'https://example.org'},'a',signal());assert.equal(response.ok,false);assert.ok(response.hint.includes('不注册 http_download'));
});
