import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEEPER_PORT, ensureKeeper, keeperPath } from '../../server/src/feishu/console_process.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const keeper = keeperPath();

test('接棒脚本存在，且是合法 JS', () => {
  assert.ok(fs.existsSync(keeper), keeper);
  const src = fs.readFileSync(keeper, 'utf8');
  assert.match(src, /createServer/, '应自己起一个 HTTP 服务');
  assert.match(src, /LISTENING/, '端口探测应只认 LISTENING 行');
});

test('ensureKeeper：脚本不在时报错，不抛异常', () => {
  // 在一个没有接棒脚本的目录里构造模块 URL，验证走的是报错分支而不是抛异常
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-keeper-'));
  try {
    const r = ensureKeeper('file://' + dir + '/module.ts');
    assert.equal(r.ok, false);
    assert.match(r.error!, /接棒脚本/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('接棒服务：起一份、/health 可访问、/start 在已运行时返回 already', async () => {
  // 用随机端口起一份，避免和线上 8601 的那份打架
  const probe = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
  const child = spawn(process.execPath, [keeper], {
    cwd: repoRoot,
    env: { ...process.env, XKANG_KEEPER_PORT: String(port) },
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.unref();
  try {
    let health: any = null;
    for (let i = 0; i < 20 && !health; i += 1) {
      await new Promise(r => setTimeout(r, 300));
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/health');
        if (res.ok) health = await res.json();
      } catch { /* 还没起来 */ }
    }
    assert.ok(health, '接棒服务应能起来并提供 /health');
    assert.equal(health.keeper, true);
    assert.equal(typeof health.mainListening, 'boolean');

    // 服务端此刻在跑（测试进程连的是线上 8600 的状态），/start 应直接返回 already
    const res = await fetch('http://127.0.0.1:' + port + '/start', { method: 'POST' });
    const body = await res.json();
    assert.ok(body.already === true || body.ok === true, JSON.stringify(body));
  } finally {
    try { process.kill(child.pid!, 'SIGTERM'); } catch { /* 已经退出 */ }
  }
});

test('KEEPER_PORT 默认 8601，可用环境变量覆盖', () => {
  assert.equal(KEEPER_PORT, Number(process.env.XKANG_KEEPER_PORT || 8601));
  assert.ok(KEEPER_PORT > 0 && KEEPER_PORT < 65536);
});
