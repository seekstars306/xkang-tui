import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { collectChatStream } from '@xkang/agent-core/protocol';
import { BusinessModel } from '../../server/src/agent/model.ts';
import { getProviderClient, setupLlmProxy } from '../../server/src/llm.ts';
import express from 'express';

test('未收到正常结束标记的流不能放行正文或工具', async () => {
  for (const delta of [{ content: '未完成的结论' }, { tool_calls: [{ index: 0, id: 'c1', function: { name: 'company_db_query', arguments: '{}' } }] }]) {
    const events: unknown[] = [];
    const stream = (async function* () { yield { choices: [{ delta }] }; })();
    await assert.rejects(collectChatStream(stream, event => events.push(event)), /truncated or refused/);
    assert.equal(events.some((event: any) => event.type === 'tool_call_start'), false);
  }
});

test('复核流中止不能在审计中记为成功', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const entries: any[] = [], controller = new AbortController();
    const model = new BusinessModel({ deepseekApiKey: 'test-only', deepseekBaseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, deepseekModel: 'test' } as any,
      'deepseek', { log: (entry: unknown) => entries.push(entry) } as any, 'test');
    await assert.rejects(model.streamChat([{ role: 'user', content: 'JSON' }], [], event => {
      if (event.type === 'content_chunk') controller.abort();
    }, { signal: controller.signal }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].success, false);
    assert.equal(entries[0].details.purpose, 'answer_review');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Gemini调查和复核都显式开启high，审计保留上游总量、思考及缓存用量', async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"model":"provider-flash","choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":19,"completion_tokens_details":{"reasoning_tokens":7},"prompt_tokens_details":{"cached_tokens":3}}}\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const config = { geminiApiKey: 'test-only', geminiBaseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, geminiModel: 'gemini-3.8-flash-high' } as any;
  try {
    const audit: any[] = [];
    const model = new BusinessModel(config, 'gemini', { log: (entry: unknown) => audit.push(entry) } as any, 'test');
    for (const options of [undefined, { signal: new AbortController().signal }]) await model.streamChat([{ role: 'user', content: 'JSON' }], [], () => {}, options);
    assert.ok(requests.every(r => r.reasoning_effort === 'high'));
    assert.deepEqual(audit.map(a => a.details.purpose), ['investigation', 'answer_review']);
    assert.ok(audit.every(a => a.tokensUsed.totalTokens === 19 && a.details.reasoningTokens === 7 && a.details.cachedInputTokens === 3));
    assert.ok(audit.every(a => a.details.targetModel === 'gemini-3.8-flash-high' && a.details.returnedModel === 'provider-flash'));
    await new BusinessModel({ ...config, geminiReasoningEffort: 'default' }, 'gemini', { log() {} } as any, 'control').streamChat([{ role: 'user', content: 'JSON' }], [], () => {});
    assert.equal('reasoning_effort' in requests.at(-1), false);
    assert.equal(getProviderClient('deepseek', { deepseekApiKey: 'test-only' } as any).reasoningEffort, undefined);
    const app = express(); app.use(express.json());
    app.post('/chat', setupLlmProxy(config, { log: (entry: unknown) => audit.push(entry) } as any, { getActive: () => 'gemini' } as any));
    const proxy = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => proxy.once('listening', resolve));
    try {
      const result = await fetch(`http://127.0.0.1:${(proxy.address() as any).port}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'JSON' }], tools: [], stream: true }) });
      await result.text();
      assert.equal(requests.at(-1).reasoning_effort, 'high');
      assert.equal(audit.at(-1).tokensUsed.totalTokens, 19);
      assert.equal(audit.at(-1).details.reasoningTokens, 7);
    } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
