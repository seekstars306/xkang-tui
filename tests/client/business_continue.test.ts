import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBusinessWebServer } from '../../src/business_web_server.ts';
import { BusinessClient } from '../../src/adapters/business_client.ts';

/** 假业务服务：/config/client、会话详情、续查 SSE 都可按用例装配 */
function fakeBackend(handlers: {
  config?: unknown;
  session?: unknown;
  continue?: { status?: number; frames?: string[] } | 'json-409';
  seen?: Array<{ url: string; method: string; auth?: string }>;
}) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    handlers.seen?.push({ url: req.url || '', method: req.method || '', auth: req.headers.authorization });
    if (req.url === '/config/client') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(handlers.config ?? { businessApiVersion: 1, features: {} }));
      return;
    }
    if (req.url?.startsWith('/agent/sessions/') && req.url.endsWith('/continue') && req.method === 'POST') {
      const spec = handlers.continue;
      if (spec === 'json-409' || (spec && spec.status && spec.status !== 200)) {
        res.writeHead(spec === 'json-409' ? 409 : spec.status!, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '会话未处于冻结状态，无需续查' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
      for (const frame of spec?.frames ?? []) res.write(`data: ${frame}\n\n`);
      res.end();
      return;
    }
    if (req.url?.startsWith('/agent/sessions/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(handlers.session ?? { id: 's1', title: 't', createdAt: '', lastActiveAt: '', status: 'idle', turns: [] }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return server;
}

async function withServers<T>(backend: Server, run: (web: Server, base: string, backendBase: string) => Promise<T>): Promise<T> {
  backend.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => backend.once('listening', resolve));
  const backendBase = `http://127.0.0.1:${(backend.address() as any).port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xkang-r3-'));
  const web = await startBusinessWebServer({ port: 0, autoOpen: false, serverUrl: backendBase, token: 'tok_ui', cacheDirectory: directory });
  try {
    return await run(web, `http://127.0.0.1:${(web.address() as any).port}`, backendBase);
  } finally {
    await new Promise<void>(resolve => web.close(() => resolve()));
    await new Promise<void>(resolve => backend.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('R3：/config/client 的 features 经 /api/bootstrap 下发，只保留布尔开关', async () => {
  const backend = fakeBackend({ config: { businessApiVersion: 1, features: { timeBudget: true, partialPublish: false, inputGuard: true, junk: 'nope' } } });
  await withServers(backend, async (_web, base) => {
    const info: any = await (await fetch(`${base}/api/bootstrap`)).json();
    assert.deepEqual(info.features, { timeBudget: true, partialPublish: false, inputGuard: true });
    assert.equal(info.mode, 'business');
  });
});

test('R3：bootstrap 连不上业务服务时按未开启处理', async () => {
  const dead = createServer();
  dead.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => dead.once('listening', resolve));
  const backendBase = `http://127.0.0.1:${(dead.address() as any).port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xkang-r3-'));
  const web = await startBusinessWebServer({ port: 0, autoOpen: false, serverUrl: backendBase, token: 'tok_ui', cacheDirectory: directory });
  try {
    const info: any = await (await fetch(`http://127.0.0.1:${(web.address() as any).port}/api/bootstrap`)).json();
    assert.equal(info.features, undefined, '服务不可达时不下发 features（客户端按关闭处理）');
    assert.equal(info.mcpConnected, false);
  } finally {
    await new Promise<void>(resolve => web.close(() => resolve()));
    await new Promise<void>(resolve => dead.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('R3：冻结会话与逐条核实状态经 /api/session 透传到网页端', async () => {
  const backend = fakeBackend({ session: { id: 's_frozen', title: '核对资料', createdAt: '2026-10-15T00:00:00Z', lastActiveAt: '2026-10-15T00:20:00Z', status: 'idle', frozen: true, extensions: 2, activeElapsedMs: 300000, activeBudgetMs: 300000,
    turns: [{ id: 'r_1', userText: '核对资料', answer: { conclusion: '已核实联系电话。', businessData: [{ label: '联系电话', value: '0013812345678' }], evidenceSummary: [], customerReply: '', pendingItems: [], reviewStatus: 'reviewed', traceId: 'r_1',
      claims: [{ text: '已核实联系电话。', status: 'confirmed', evidenceRefs: ['e_1'] }, { text: '退款对应关系待确认。', status: 'pending' }] } }] } });
  await withServers(backend, async (_web, base) => {
    const data: any = await (await fetch(`${base}/api/session/s_frozen`)).json();
    assert.equal(data.frozen, true);
    assert.equal(data.extensions, 2);
    assert.equal(data.busy, false, '冻结时线缆 status 仍是 idle');
    const assistant = data.messages.find((m: any) => m.role === 'assistant');
    assert.equal(assistant.turnId, 'r_1');
    assert.deepEqual(assistant.publicClaims, [
      { text: '已核实联系电话。', status: 'confirmed', evidenceRefs: ['e_1'] },
      { text: '退款对应关系待确认。', status: 'pending' },
    ]);
    assert.match(assistant.content, /已核实联系电话。/);
    assert.doesNotMatch(assistant.content, /evidenceRefs|claims/);
  });
});

test('R3：continue 代理把 SSE 事件原样转发，并在结束后刷新会话缓存', async () => {
  const answer = JSON.stringify({ type: 'answer', turnId: 'r_1', answer: { conclusion: '已核实联系电话。', businessData: [{ label: '联系电话', value: '0013812345678' }], evidenceSummary: [], customerReply: '', pendingItems: [], reviewStatus: 'reviewed', traceId: 'r_1',
    claims: [{ text: '已核实联系电话。', status: 'confirmed', evidenceRefs: ['e_1'] }] } });
  const seen: Array<{ url: string; method: string; auth?: string }> = [];
  const backend = fakeBackend({ continue: { frames: [JSON.stringify({ type: 'progress', phase: 'checking' }), answer, JSON.stringify({ type: 'done' })] }, seen });
  await withServers(backend, async (_web, base) => {
    const resp = await fetch(`${base}/api/session/s_frozen/continue`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') || '', /text\/event-stream/);
    const text = await resp.text();
    const events = text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)));
    assert.deepEqual(events.map((e: any) => e.type), ['progress', 'answer', 'done']);
    assert.deepEqual(events[1].answer.claims, [{ text: '已核实联系电话。', status: 'confirmed', evidenceRefs: ['e_1'] }]);
    assert.ok(seen.some(s => s.url === '/agent/sessions/s_frozen/continue' && s.method === 'POST'), '续查请求已转发到业务服务');
  });
});

test('R3：续查遇 409 时网页端收到可读的错误帧', async () => {
  const backend = fakeBackend({ continue: 'json-409' });
  await withServers(backend, async (_web, base) => {
    const resp = await fetch(`${base}/api/session/s_live/continue`, { method: 'POST' });
    assert.equal(resp.status, 200, '代理统一以 SSE 返回，错误走事件帧');
    const text = await resp.text();
    assert.match(text, /"type":"error"/);
    assert.match(text, /无需续查|业务服务未接受续查请求/);
  });
});

test('R3：BusinessClient.continue 消费 SSE 并按公开协议解析事件', async () => {
  const backend = fakeBackend({ continue: { frames: [JSON.stringify({ type: 'progress', phase: 'checking' }), JSON.stringify({ type: 'answer', turnId: 'r_9', answer: { conclusion: 'c', businessData: [], evidenceSummary: [], customerReply: '', pendingItems: [], reviewStatus: 'reviewed', traceId: 'r_9' } }), JSON.stringify({ type: 'done' })] } });
  await withServers(backend, async (_web, base, backendBase) => {
    const client = new BusinessClient(backendBase, 'tok_ui');
    const events: string[] = [];
    await client.continue('s_x', event => events.push(event.type));
    assert.deepEqual(events, ['progress', 'answer', 'done']);
  });
});

test('R3：BusinessClient.continue 对 409 给出续查专用提示', async () => {
  const backend = fakeBackend({ continue: 'json-409' });
  await withServers(backend, async (_web, base, backendBase) => {
    const client = new BusinessClient(backendBase, 'tok_ui');
    await assert.rejects(client.continue('s_live', () => {}), /没有到 15 分钟上限，无需续查/);
  });
});
