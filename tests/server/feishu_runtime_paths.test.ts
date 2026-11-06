import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { FEISHU_PATHS, resolveFeishuPaths } from '../../server/src/feishu/runtime_paths.ts';
import { mountFeishuMonitor } from '../../server/src/feishu/monitor_routes.ts';
import { mountShareRoutes } from '../../server/src/feishu/share.ts';
import { hashPassword } from '../../server/src/feishu/monitor_auth.ts';

const PROJECT_ROOT = path.resolve('.');

test('source and compiled Feishu paths resolve to the same project resources', () => {
  for (const directory of ['src', 'dist']) {
    const modulePath = path.join(PROJECT_ROOT, 'server', directory, 'feishu', 'runtime_paths.js');
    const resolved = resolveFeishuPaths(pathToFileURL(modulePath).href);
    assert.equal(resolved.webRoot, path.join(PROJECT_ROOT, 'web'));
    assert.equal(resolved.monitorDbPath, path.join(PROJECT_ROOT, 'server', 'data', 'feishu_monitor.db'));
  }
  assert.ok(fs.existsSync(path.join(FEISHU_PATHS.webRoot, 'monitor.html')));
  assert.ok(fs.existsSync(path.join(FEISHU_PATHS.webRoot, 'monitor-login.html')));
  assert.ok(fs.existsSync(path.join(FEISHU_PATHS.webRoot, 'share.html')));
});

test('monitor database path does not depend on the launch working directory', () => {
  const initial = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xkang-monitor-cwd-'));
  try {
    for (const cwd of [PROJECT_ROOT, path.join(PROJECT_ROOT, 'server'), temp]) {
      process.chdir(cwd);
      assert.equal(resolveFeishuPaths().monitorDbPath, FEISHU_PATHS.monitorDbPath);
      assert.equal(resolveFeishuPaths().webRoot, FEISHU_PATHS.webRoot);
    }
  } finally {
    process.chdir(initial);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('constructing the monitor database never marks running tasks failed', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xkang-monitor-recovery-'));
  const dbPath = path.join(temp, 'fixture.db');
  const { FeishuMonitorDb } = await import('../../server/src/feishu/monitor_db.ts');
  const first = new FeishuMonitorDb(dbPath);
  try {
    first.createTask({
      id: 'running-sentinel', chatId: 'fake-chat', requesterOpenId: 'fake-user',
      originMessageId: 'fake-origin', triggerMessageId: 'fake-trigger',
    });
    first.markRunning('running-sentinel');
    // A second opener (for example the 8600 server opening the shared file)
    // must not silently kill the task another process is executing.
    const second = new FeishuMonitorDb(dbPath);
    try {
      const rows = second.listTasks({ limit: 10 });
      assert.equal(rows[0].status, 'running');
      assert.equal(rows[0].error_text, null);
      assert.equal(second.recoverInterruptedTasks({ olderThanMs: 60_000 }), 0);
      assert.equal(second.recoverInterruptedTasks({ olderThanMs: -60_000 }), 1);
      assert.equal(second.listTasks({ limit: 10 })[0].status, 'failed');
    } finally { second.close(); }
  } finally { first.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});

test('real HTTP login, cookie-authenticated monitor and share routes work from any cwd', async () => {
  const initial = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xkang-monitor-paths-'));
  const { getMonitorDb } = await import('../../server/src/feishu/monitor_db.ts');
  const db = getMonitorDb(path.join(temp, 'fixture.db'));
  db.createTask({ id: 'path-sentinel', chatId: 'fake-chat', requesterOpenId: 'fake-user', originMessageId: 'fake-origin', triggerMessageId: 'fake-trigger' });
  db.finish('path-sentinel', '{}', null);
  const app = express();
  app.use(express.json());
  mountFeishuMonitor(app, { accounts: [{ username: 'fixture-admin', passwordHash: hashPassword('fixture-password') }], sessionSecret: 'test-secret-only' });
  mountShareRoutes(app);
  app.use(((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.code || 'fixture-error' })) as express.ErrorRequestHandler);
  const server = createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    for (const cwd of [initial, path.join(initial, 'server'), temp]) {
      process.chdir(cwd);
      let r = await fetch(base + '/admin/feishu', { headers: { accept: 'text/html' }, redirect: 'manual' });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), '/admin/feishu/login');
      r = await fetch(base + '/admin/feishu/login');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type') || '', /text\/html/);
      assert.match(await r.text(), /登录/);
      r = await fetch(base + '/admin/feishu/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'fixture-admin', password: 'wrong' }) });
      assert.equal(r.status, 401);
      r = await fetch(base + '/admin/feishu/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'fixture-admin', password: 'fixture-password' }) });
      assert.equal(r.status, 200);
      const cookie = r.headers.get('set-cookie')!;
      assert.match(cookie, /HttpOnly/);
      r = await fetch(base + '/admin/feishu', { headers: { cookie } });
      assert.equal(r.status, 200);
      assert.match(await r.text(), /飞书监控台/);
      r = await fetch(base + '/admin/feishu/stats', { headers: { cookie } });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).total, 1);
      r = await fetch(base + '/admin/feishu/tasks', { headers: { cookie } });
      assert.equal(r.status, 200);
      assert.equal((await r.json())[0].id, 'path-sentinel');
      r = await fetch(base + '/admin/feishu/filters', { headers: { cookie } });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).chats[0].chat_id, 'fake-chat');
      r = await fetch(base + '/admin/feishu/tasks/path-sentinel', { headers: { cookie } });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).task.id, 'path-sentinel');
      r = await fetch(base + '/admin/feishu/stats', { headers: { accept: 'application/json' } });
      assert.equal(r.status, 401);
      r = await fetch(base + '/share/fake-token', { headers: { accept: 'text/html' } });
      assert.equal(r.status, 200);
      assert.match(await r.text(), /html/i);
    }
  } finally {
    process.chdir(initial);
    await new Promise<void>(r => server.close(() => r()));
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
