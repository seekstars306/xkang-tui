import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverMcpServices, detectTransport, findMcpProcess, listMcpStatus, mcpStatus, startMcpService, stopMcpService,
} from '../../server/src/feishu/console_mcp.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('自动发现 tools/ 下的 mcp-* 服务', () => {
  const list = discoverMcpServices();
  assert.ok(list.length >= 1, '至少应发现 grafana 日志这一个');
  const g = list.find(s => s.name === 'mcp-grafana-logs')!;
  assert.ok(g, '应发现 mcp-grafana-logs');
  assert.equal(g.transport, 'stdio');
  assert.equal(g.startable, false, 'stdio 服务不能由控制台启动');
  assert.ok(g.entry.endsWith('index.mjs'));
  assert.match(g.clientCommand, /^node tools\/mcp-grafana-logs\/index\.mjs$/);
});

test('detectTransport：stdio / http / 读不到', () => {
  assert.equal(detectTransport(path.join(repoRoot, 'tools/mcp-grafana-logs/index.mjs')), 'stdio');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-mcp-'));
  try {
    const httpEntry = path.join(dir, 'index.mjs');
    fs.writeFileSync(httpEntry, "import { SSEServerTransport } from 'x';");
    assert.equal(detectTransport(httpEntry), 'http');
    assert.equal(detectTransport(path.join(dir, 'nope.mjs')), 'unknown');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('findMcpProcess：按入口路径或目录名匹配，匹配不到返回 null', () => {
  const svc = discoverMcpServices()[0];
  const fake = [
    { pid: 1, ppid: 1, commandLine: 'node D:/web_pro/xkang-tui/tools/mcp-grafana-logs/index.mjs', startedAt: null },
    { pid: 2, ppid: 1, commandLine: 'node --import tsx src/index.ts', startedAt: null },
  ];
  assert.equal(findMcpProcess(svc, fake)!.pid, 1);
  assert.equal(findMcpProcess(svc, [fake[1]]), null);
});

test('mcpStatus：进程在就把 pid/启动时间带上，不在就是未运行', () => {
  const svc = discoverMcpServices()[0];
  const up = mcpStatus(svc, [{ pid: 42, ppid: 7, commandLine: svc.entry, startedAt: '2026-11-05T03:00:00.000Z' }]);
  assert.equal(up.running, true);
  assert.equal(up.pid, 42);
  assert.equal(up.startedAt, '2026-11-05T03:00:00.000Z');
  const down = mcpStatus(svc, []);
  assert.equal(down.running, false);
  assert.equal(down.pid, null);
  assert.equal(down.logFile, null);
});

test('stopMcpService：未运行时明确说"未在运行"，不假装成功', () => {
  // 用一个不存在的名字，走的是"没有这个服务"分支
  const r = stopMcpService('mcp-does-not-exist');
  assert.equal(r.ok, false);
  assert.match(r.error!, /没有这个 MCP 服务/);
});

test('startMcpService：未知服务名直接报错', () => {
  const r = startMcpService('mcp-does-not-exist');
  assert.equal(r.ok, false);
  assert.match(r.error!, /没有这个 MCP 服务/);
});

test('listMcpStatus：返回的每条都带 transport 与 startable', () => {
  for (const s of listMcpStatus()) {
    assert.ok(['stdio', 'http', 'unknown'].includes(s.transport));
    assert.equal(typeof s.startable, 'boolean');
    assert.equal(s.startable, s.transport !== 'stdio');
  }
});
