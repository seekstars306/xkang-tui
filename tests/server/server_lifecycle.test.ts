import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const casesRoot = path.join(project, 'tests/eval/reports/server-startup-tests');
const loader = pathToFileURL(path.join(project, 'node_modules/tsx/dist/loader.mjs')).href;
const entry = path.join(project, 'server/src/index.ts');

async function reservePort() {
  const server = net.createServer();
  server.listen(0);
  await once(server, 'listening');
  return { server, port: (server.address() as net.AddressInfo).port };
}

function fixture(port: number, options: { programmatic?: boolean; diagnostic?: boolean } = {}) {
  fs.mkdirSync(casesRoot, { recursive: true });
  const work = fs.mkdtempSync(path.join(casesRoot, 'case-'));
  fs.writeFileSync(path.join(work, '.env'), '');
  const code = path.join(work, 'code');
  fs.mkdirSync(code);
  const graph = path.join(work, 'data/codegraph');
  fs.mkdirSync(graph, { recursive: true });
  fs.writeFileSync(path.join(graph, 'stats.json'), JSON.stringify({
    version: '1.0.0', createdAt: '2026-01-01T00:00:00Z',
    stats: { totalRepos: 0, totalFiles: 0, frontendFiles: 0, backendFiles: 0, totalDefinitions: 0, totalImplementations: 0, totalCalls: 0, totalReferences: 0 },
  }));
  for (const name of ['definitions', 'implementations', 'callers', 'callees', 'references']) {
    fs.writeFileSync(path.join(graph, name + '.json'), '{}');
  }
  const args = ['--report-exclude-env', '--report-exclude-network', '--report-on-fatalerror', '--import', loader];
  const canary = 'startup-secret-that-must-not-enter-diagnostics';
  const report = path.join(work, 'data/diagnostics/test-report.json');
  if (options.diagnostic) {
    const preload = path.join(work, 'diagnostic-preload.mjs');
    fs.writeFileSync(preload, [
      'const deadline = Date.now() + 15000;',
      'const timer = setInterval(async () => {',
      '  if (Date.now() > deadline) { clearInterval(timer); process.exit(9); }',
      '  try {',
      '    const r = await fetch(' + JSON.stringify('http://127.0.0.1:' + port + '/healthz') + ');',
      '    if (!r.ok) return;',
      '    clearInterval(timer);',
      '    process.report.writeReport(' + JSON.stringify(path.basename(report)) + ');',
      "    process.emit('SIGTERM');",
      '  } catch {}',
      '}, 100);',
    ].join('\n'));
    args.push('--import', pathToFileURL(preload).href);
  }
  if (options.programmatic) {
    const wrapper = path.join(work, 'embedded.mjs');
    fs.writeFileSync(wrapper, [
      'import { startServer } from ' + JSON.stringify(pathToFileURL(entry).href) + ';',
      'const service = startServer();',
      'try { await service.ready; process.exit(3); }',
      "catch (error) { if (error.code !== 'EADDRINUSE') throw error; console.log('EXPECTED_BIND_FAILURE'); process.exitCode = 1; }",
    ].join('\n'));
    args.push(wrapper);
  } else args.push(entry);
  const child = spawn(process.execPath, args, {
    cwd: work, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_OPTIONS: '', PORT: String(port), CODE_REPO_PATH: code,
      CODE_SYNC_ENABLED: options.programmatic ? 'true' : 'false', CODE_SYNC_INTERVAL_MINUTES: '1',
      XKANG_LLM_MOCK: '1', XKANG_TOKENS: 'startup_employee:启动测试',
      XKANG_ADMIN_TOKENS: 'startup_admin:启动测试管理员', ACTIVE_MODEL: 'gemini',
      GEMINI_API_KEY: 'test-only', GEMINI_BASE_URL: 'http://127.0.0.1:9/v1',
      GEMINI_REASONING_EFFORT: 'high', ANSWER_REVIEW_TIMEOUT_MS: '180000',
      STARTUP_TEST_CANARY: canary,
    },
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ code: exitCode, signal }));
  });
  const waitExit = async (ms = 12000) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Server did not exit in time:\n' + logs)), ms);
      })]);
    } finally { clearTimeout(timer); }
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    const resolved = fs.realpathSync(work);
    if (!resolved.startsWith(fs.realpathSync(casesRoot) + path.sep) || fs.lstatSync(work).isSymbolicLink()) {
      throw new Error('Refusing to remove an unverified test directory');
    }
    fs.rmSync(work, { recursive: true, force: true });
  };
  return { child, work, code, report, canary, logs: () => logs, waitExit, stop, url: 'http://127.0.0.1:' + port };
}

test('端口占用时明确启动失败并非零退出，不加载图谱或创建业务数据库', async () => {
  const owner = await reservePort();
  const second = fixture(owner.port);
  try {
    const result = await second.waitExit();
    assert.equal(result.code, 1);
    assert.match(second.logs(), /端口.*已被占用/);
    assert.doesNotMatch(second.logs(), /服务继续运行|核心服务端已启动|已加载分块图谱/);
    assert.equal(fs.existsSync(path.join(second.work, 'data/xkang.db')), false);
    assert.equal(owner.server.listening, true);
  } finally {
    await second.stop();
    await new Promise<void>(resolve => owner.server.close(() => resolve()));
  }
});

test('正常启动能持续响应，错误请求和客户端断开不会使服务退出', async () => {
  const available = await reservePort();
  await new Promise<void>(resolve => available.server.close(() => resolve()));
  const service = fixture(available.port);
  try {
    const deadline = Date.now() + 12000;
    let ready = false;
    while (Date.now() < deadline) {
      if (service.child.exitCode !== null) break;
      try { if ((await fetch(service.url + '/healthz', { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, service.logs());
    const invalid = await fetch(service.url + '/agent/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.ok(invalid.status >= 400);
    const socket = net.connect(available.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n');
    socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(service.child.exitCode, null);
    assert.equal((await fetch(service.url + '/healthz')).status, 200);
    const entries = fs.readFileSync(path.join(service.work, 'data/service-lifecycle.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(entries.some(e => e.event === 'started' && e.pid === service.child.pid), true);
  } finally { await service.stop(); }
});

test('嵌入式启动遇到监听失败时ready拒绝，后台同步不启动', async () => {
  const owner = await reservePort();
  const second = fixture(owner.port, { programmatic: true });
  try {
    const result = await second.waitExit();
    assert.equal(result.code, 1);
    assert.match(second.logs(), /EXPECTED_BIND_FAILURE/);
    assert.doesNotMatch(second.logs(), /开始同步代码库|定时同步调度器已启动/);
    assert.deepEqual(fs.readdirSync(second.code), []);
  } finally {
    await second.stop();
    await new Promise<void>(resolve => owner.server.close(() => resolve()));
  }
});

test('停止信号留下退出原因，Node诊断报告不包含环境凭据', async () => {
  const available = await reservePort();
  await new Promise<void>(resolve => available.server.close(() => resolve()));
  const service = fixture(available.port, { diagnostic: true });
  try {
    const result = await service.waitExit(18000);
    assert.equal(result.code, 0, service.logs());
    const report = fs.readFileSync(service.report, 'utf8');
    assert.equal(report.includes(service.canary), false);
    assert.equal('environmentVariables' in JSON.parse(report), false);
    const entries = fs.readFileSync(path.join(service.work, 'data/service-lifecycle.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(entries.some(e => e.event === 'stop_requested' && e.signal === 'SIGTERM'));
    assert.ok(entries.some(e => e.event === 'exit' && e.exitCode === 0 && e.reason === 'SIGTERM'));
  } finally { await service.stop(); }
});

