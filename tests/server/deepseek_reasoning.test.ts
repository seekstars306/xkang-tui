import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BusinessModel } from '../../server/src/agent/model.ts';
import { loadServerConfig } from '../../server/src/config.ts';

// deepseek 排查调用的推理档位（DEEPSEEK_REASONING_EFFORT）。
// 2026-10-29：zcode 以 high 调同一个 deepseek 接口有推理过程，xkang 推理 token 恒为 0；同一道日期题不推理答错、推理后答对。
async function capture(config: Record<string, unknown>, calls: Array<{ signal?: AbortSignal } | undefined>) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"model":"m","choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const model = new BusinessModel({ deepseekApiKey: 'test-only', deepseekBaseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, deepseekModel: 'deepseek-v4.1-flash', modelCallTimeoutMs: 240000, answerReviewTimeoutMs: 180000, ...config } as any, 'deepseek', { log() {} } as any, 'test');
    for (const options of calls) await model.streamChat([{ role: 'user', content: 'JSON' }], [], () => {}, options);
  } finally { server.close(); }
  return requests;
}

test('deepseek：设置推理档位后排查调用带 reasoning_effort，复核调用不带', async () => {
  const [investigation, review] = await capture({ deepseekReasoningEffort: 'high' }, [undefined, { signal: new AbortController().signal }]);
  assert.equal(investigation.reasoning_effort, 'high');
  assert.equal('reasoning_effort' in review, false);
});

test('deepseek：未设置时请求不带 reasoning_effort（与引入前一致）', async () => {
  const [investigation] = await capture({}, [undefined]);
  assert.equal('reasoning_effort' in investigation, false);
});

test('DEEPSEEK_REASONING_EFFORT：未设置为空，合法值透传，写错启动即报错', () => {
  const saved = process.env.DEEPSEEK_REASONING_EFFORT;
  try {
    delete process.env.DEEPSEEK_REASONING_EFFORT;
    assert.equal(loadServerConfig().deepseekReasoningEffort, undefined);
    process.env.DEEPSEEK_REASONING_EFFORT = ' high ';
    assert.equal(loadServerConfig().deepseekReasoningEffort, 'high');
    process.env.DEEPSEEK_REASONING_EFFORT = 'hgih';
    assert.throws(() => loadServerConfig(), /DEEPSEEK_REASONING_EFFORT must be low, high or max/);
  } finally {
    if (saved === undefined) delete process.env.DEEPSEEK_REASONING_EFFORT; else process.env.DEEPSEEK_REASONING_EFFORT = saved;
  }
});

test('CONTEXT_TOKENS：未设置为空（沿用 140000），合法值透传，过小或非整数启动即报错', () => {
  const saved = process.env.CONTEXT_TOKENS;
  try {
    delete process.env.CONTEXT_TOKENS;
    assert.equal(loadServerConfig().contextTokens, undefined);
    process.env.CONTEXT_TOKENS = '1048576';
    assert.equal(loadServerConfig().contextTokens, 1048576);
    for (const bad of ['7999', '150000.5', 'abc']) { process.env.CONTEXT_TOKENS = bad; assert.throws(() => loadServerConfig(), /CONTEXT_TOKENS must be an integer/); }
  } finally {
    if (saved === undefined) delete process.env.CONTEXT_TOKENS; else process.env.CONTEXT_TOKENS = saved;
  }
});
