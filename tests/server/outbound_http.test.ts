import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { outboundFetch } from '../../server/src/outbound_http.ts';

/** 起一个只接受 CONNECT 的假代理，验证请求确实走了代理而不是直连 */
function fakeConnectProxy(handler: (target: string) => void): Promise<{ server: http.Server; url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
    server.on('connect', (req, socket) => {
      handler(String(req.url));
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

test('未配置代理时直连，行为与普通 fetch 一致', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await outboundFetch(`http://127.0.0.1:${port}/ping`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});

test('配置代理后请求确实经过代理（CONNECT 被调用）', async () => {
  let seen: string | null = null;
  const proxy = await fakeConnectProxy((t) => { seen = t; });
  try {
    await assert.rejects(
      () => outboundFetch('https://example.invalid/x', {}, proxy.url),
      /代理 CONNECT 失败 502/,
      '假代理返回 502 时应当抛出带状态码的错误',
    );
    assert.equal(seen, 'example.invalid:443', 'CONNECT 的目标应是 host:443');
  } finally { await proxy.close(); }
});

test('代理只接受 http:// 形式，其它协议直接报错', async () => {
  await assert.rejects(
    () => outboundFetch('https://example.invalid/x', {}, 'socks5://127.0.0.1:1080'),
    /仅支持 http/,
  );
});

test('走代理时拒绝非 https 目标，避免明文穿过隧道', async () => {
  await assert.rejects(
    () => outboundFetch('http://example.invalid/x', {}, 'http://127.0.0.1:7897'),
    /仅支持 https/,
  );
});
