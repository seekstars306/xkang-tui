import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMonitorAuth } from '../../server/src/feishu/monitor_auth.ts';
import type { Request, Response } from 'express';

function run(handler: ReturnType<typeof createMonitorAuth>, req: Partial<Request>) {
  const out: { status?: number; body?: unknown; redirect?: string; nexted: boolean } = { nexted: false };
  const res = {
    status(code: number) { out.status = code; return this; },
    json(v: unknown) { out.body = v; return this; },
    redirect(code: number, url: string) { out.status = code; out.redirect = url; return this; },
  } as unknown as Response;
  handler(req as Request, res, () => { out.nexted = true; });
  return out;
}

const accounts = [{ username: 'admin', passwordHash: 'x.y' }];

test('未登录时，浏览器访问页面跳转登录页而不是返回 JSON', () => {
  const handler = createMonitorAuth(accounts, 's');
  const out = run(handler, { method: 'GET', headers: { accept: 'text/html,application/xhtml+xml' } });
  assert.equal(out.status, 302, '地址栏访问应该跳转');
  assert.equal(out.redirect, '/admin/feishu/login');
});

test('未登录时，接口调用仍返回 401 JSON（不跳转）', () => {
  const handler = createMonitorAuth(accounts, 's');
  const out = run(handler, { method: 'GET', headers: { accept: 'application/json' } });
  assert.equal(out.status, 401);
  assert.deepEqual(out.body, { error: '未登录' });
  assert.equal(out.redirect, undefined, 'fetch 调用不能拿到 302，否则前端无法识别未登录');
});

test('POST 请求即使带 text/html 也不跳转，避免把提交请求变成 GET 登录页', () => {
  const handler = createMonitorAuth(accounts, 's');
  const out = run(handler, { method: 'POST', headers: { accept: 'text/html' } });
  assert.equal(out.status, 401);
});

test('未配置账号时任何请求都无法通过', () => {
  const handler = createMonitorAuth([], 's');
  const out = run(handler, { method: 'GET', headers: { accept: 'text/html' } });
  assert.notEqual(out.nexted, true);
});
