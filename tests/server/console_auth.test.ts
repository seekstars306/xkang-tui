import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consoleAuth } from '../../server/src/feishu/console_routes.ts';
import { hashPassword } from '../../server/src/feishu/monitor_auth.ts';
import type { ServerConfig } from '../../server/src/types.ts';

const ACCOUNTS = [{ username: 'ops', passwordHash: hashPassword('pw') }];
const ADMIN_TOKEN = 'admin_secret_token_123';

function options(): { accounts: typeof ACCOUNTS; sessionSecret: string; config: ServerConfig } {
  return {
    accounts: ACCOUNTS,
    sessionSecret: 'test-secret',
    config: { adminTokens: new Map([[ADMIN_TOKEN, '系统管理员']]) } as unknown as ServerConfig,
  };
}

interface FakeRes {
  statusCode: number;
  redirected?: string;
  body?: unknown;
}

function fakeReq(headers: Record<string, string> = {}, accept = 'application/json', method = 'GET') {
  return { headers: { ...headers, accept }, method } as any;
}

function fakeRes(): FakeRes & { status(code: number): FakeRes; json(body: unknown): FakeRes; redirect(to: string): FakeRes } {
  const out: FakeRes = { statusCode: 200 };
  const res = out as any;
  res.status = (code: number) => { out.statusCode = code; return res; };
  res.json = (body: unknown) => { out.body = body; return res; };
  // Express 的 redirect 既支持 redirect(url) 也支持 redirect(status, url)
  res.redirect = (a: unknown, b?: unknown) => { out.redirected = String(b ?? a); return res; };
  return res;
}

test('未登录：GET 直接返回 401，带 text/html 的 GET 跳登录页', () => {
  const auth = consoleAuth(options());
  const json = fakeRes();
  auth(fakeReq(), json, () => { throw new Error('不应放行'); });
  assert.equal(json.statusCode, 401);

  const html = fakeRes();
  auth(fakeReq({}, 'text/html'), html, () => { throw new Error('不应放行'); });
  assert.equal(html.redirected, '/admin/feishu/login');
});

test('任意非空 Bearer 一律拒绝：写操作不能靠"随便一个令牌"放行', () => {
  const auth = consoleAuth(options());
  for (const method of ['GET', 'POST']) {
    const res = fakeRes();
    auth(fakeReq({ authorization: 'Bearer whatever-i-want' }, 'application/json', method), res, () => { throw new Error('不应放行'); });
    assert.equal(res.statusCode, 403, method + ' 也应被拒');
  }
});

test('有效管理员令牌放行，身份记为 admin:名称', () => {
  const auth = consoleAuth(options());
  const req = fakeReq({ authorization: 'Bearer ' + ADMIN_TOKEN });
  let passed = false;
  auth(req, fakeRes(), () => { passed = true; });
  assert.ok(passed, '有效管理员令牌应放行');
  assert.equal(req.user.name, 'admin:系统管理员');
});

test('监控台会话 Cookie 放行，身份就是登录用户名', async () => {
  const { createSessionCookie } = await import('../../server/src/feishu/monitor_auth.ts');
  const auth = consoleAuth(options());
  const req = fakeReq({ cookie: createSessionCookie('ops', 'test-secret') });
  let passed = false;
  auth(req, fakeRes(), () => { passed = true; });
  assert.ok(passed, '有效会话应放行');
  assert.equal(req.user.name, 'ops');
});

test('过期会话不放行', async () => {
  const { createSessionCookie } = await import('../../server/src/feishu/monitor_auth.ts');
  const auth = consoleAuth(options());
  // 用过去的时间签名，exp 已过
  const cookie = createSessionCookie('ops', 'test-secret', Date.now() - 9 * 60 * 60 * 1000).replace(/Max-Age=\d+/, 'Max-Age=0');
  const res = fakeRes();
  auth(fakeReq({ cookie }), res, () => { throw new Error('不应放行'); });
  assert.equal(res.statusCode, 401);
});
