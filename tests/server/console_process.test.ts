import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { listProcesses, findBridge, isRunning, parseProcList, startServerProcess } from '../../server/src/feishu/console_process.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 找一段没人用的端口，用来验证端口被占用时启动函数会拒绝 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

test('进程枚举能拿到本进程，命令行为字符串', () => {
  const all = listProcesses();
  assert.ok(Array.isArray(all));
  const self = all.find(p => p.pid === process.pid);
  assert.ok(self, '应能枚举到当前进程');
  assert.equal(typeof self!.commandLine, 'string');
});

test('findBridge 与 isRunning：不存在的进程判为未运行', () => {
  assert.equal(isRunning({ pid: 0x7fffffff, ppid: 0, commandLine: '', startedAt: null }), false);
  assert.equal(isRunning(null), false);
  const bridge = findBridge();
  if (bridge) assert.ok(isRunning(bridge), '枚举到的桥应确实在运行');
});

test('parseProcList：空输出、非 JSON、单对象、数组都能吃下来', () => {
  assert.deepEqual(parseProcList(''), []);
  assert.deepEqual(parseProcList('not json'), []);
  const one = parseProcList(JSON.stringify({ ProcessId: 5, ParentProcessId: 1, CommandLine: 'x', StartedAt: '2026-11-05T11:00:00' }));
  assert.deepEqual(one.map(p => p.pid), [5]);
  // 本地时间 11:00（Asia/Shanghai）对应 UTC 03:00
  assert.equal(one[0].startedAt, '2026-11-05T03:00:00.000Z');
  const many = parseProcList(JSON.stringify([{ ProcessId: 5 }, { ProcessId: 6 }]));
  assert.deepEqual(many.map(p => p.pid), [5, 6]);
});

test('启动服务端：端口已被占用时判定为已在运行，不拉第二份', async () => {
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise<void>(resolve => blocker.listen(port, '127.0.0.1', resolve));
  try {
    const r = startServerProcess(undefined, port, 300);
    assert.equal(r.ok, true, '已在运行不应报错');
    assert.equal((r as any).already, true);
    assert.equal(r.pid, undefined, '不应声称拉起了新进程');
  } finally {
    await new Promise<void>(resolve => blocker.close(() => resolve()));
  }
});
test('端口探测不走 shell：不会经 cmd.exe /c，也就不会闪窗口', () => {
  const src = fs.readFileSync(path.resolve(repoRoot, 'server/src/feishu/console_process.ts'), 'utf8');
  assert.doesNotMatch(src, /spawnSync\([\s\S]{0,200}?shell:\s*true/, '不能走 shell');
  assert.match(src, /spawnSync\('netstat', \['-ano'\]/, 'Windows 上应直接调 netstat.exe');
  assert.match(src, /LISTENING/, '只认 LISTENING 行，别把 TIME_WAIT 当成占用');
});
