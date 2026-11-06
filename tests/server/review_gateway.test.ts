import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FallbackReviewGateway } from '../../server/src/agent/review_gateway.ts';
import { reviewCallTimeoutMs } from '../../server/src/agent/service.ts';

/**
 * 复核模型换了以后必须保证一件事：**复核不能停摆**。
 * 独立模型失败或超时，立刻用原模型重跑，行为与改造前一致。
 *
 * 另一个坑：主模型可能已经流出一部分内容才失败。若直接转发事件，
 * 降级后两份内容会拼在一起，复核拿到的是乱码。所以要先缓冲、成功才回放。
 */

const okMessage = { role: 'assistant', content: 'ok' };

test('主模型成功时用主模型，并回放事件', async () => {
  const events = [];
  const primary = {
    getCurrentModel: () => 'primary',
    switchModel: () => {},
    streamChat: async (_m: unknown, _t: unknown, emit: (e: unknown) => void) => { emit({ type: 'content_chunk', chunk: 'P' }); return { ...okMessage, content: 'primary' }; },
  };
  const fallback = { getCurrentModel: () => 'fb', switchModel: () => {}, streamChat: async () => ({ ...okMessage, content: 'fallback' }) };
  const gw = new FallbackReviewGateway(primary as never, fallback as never);
  const out = [];
  const msg = await gw.streamChat([], [], e => out.push(e));
  assert.equal(msg.content, 'primary');
  assert.equal(out.length, 1, '主模型事件要回放一次');
});

test('主模型失败 → 降级到原模型', async () => {
  const logs: string[] = [];
  const primary = { getCurrentModel: () => 'p', switchModel: () => {}, streamChat: async () => { throw new Error('timeout'); } };
  const fallback = { getCurrentModel: () => 'f', switchModel: () => {}, streamChat: async () => ({ ...okMessage, content: 'fallback' }) };
  const gw = new FallbackReviewGateway(primary as never, fallback as never, m => logs.push(m));
  const msg = await gw.streamChat([], [], () => {});
  assert.equal(msg.content, 'fallback');
  assert.match(String(logs[0]), /降级/);
});

test('主模型中途失败时，已流出的事件不能重复回放', async () => {
  const seen: Array<{ type: string; chunk?: string }> = [];
  const primary = {
    getCurrentModel: () => 'p', switchModel: () => {},
    streamChat: async (_m: unknown, _t: unknown, emit: (e: unknown) => void) => {
      emit({ type: 'content_chunk', chunk: '半个答案' });
      throw new Error('stream terminated');
    },
  };
  const fallback = {
    getCurrentModel: () => 'f', switchModel: () => {},
    streamChat: async (_m: unknown, _t: unknown, emit: (e: unknown) => void) => { emit({ type: 'content_chunk', chunk: '完整答案' }); return okMessage; },
  };
  const gw = new FallbackReviewGateway(primary as never, fallback as never);
  await gw.streamChat([], [], e => seen.push(e as { type: string; chunk?: string }));
  assert.equal(seen.length, 1, '只应有降级那次的事件');
  assert.equal(seen[0].chunk, '完整答案');
});

test('主模型已产出的分析要交给兜底模型接着做，不能整段丢弃', async () => {
  let received: Array<{ role: string; content: unknown }> = [];
  const primary = {
    getCurrentModel: () => 'p', switchModel: () => {},
    streamChat: async (_m: unknown, _t: unknown, emit: (e: { type: string; chunk?: string }) => void) => {
      emit({ type: 'content_chunk', chunk: '已核对：订单已退款。' });
      emit({ type: 'content_chunk', chunk: '待确认：入住人证件。' });
      throw new Error('Review deadline exceeded');
    },
  };
  const fallback = {
    getCurrentModel: () => 'f', switchModel: () => {},
    streamChat: async (m: Array<{ role: string; content: unknown }>) => { received = m; return okMessage; },
  };
  const gw = new FallbackReviewGateway(primary as never, fallback as never);
  await gw.streamChat([{ role: 'user', content: '原始复核请求' }], [], () => {});
  const joined = received.map(x => String(x.content)).join('\n');
  assert.match(joined, /已核对：订单已退款/, '超时前已完成的分析必须带给兜底模型');
  assert.match(joined, /待确认：入住人证件/);
  assert.match(joined, /超时被截断/, '要说明这是续做，避免兜底模型从头再来');
  assert.ok(received.some(x => x.role === 'assistant'), '已完成的分析要以 assistant 身份交接');
});

test('主模型没有任何产出时，兜底收到的就是原始请求', async () => {
  let received: unknown[] = [];
  const primary = { getCurrentModel: () => 'p', switchModel: () => {}, streamChat: async () => { throw new Error('boom'); } };
  const fallback = { getCurrentModel: () => 'f', switchModel: () => {}, streamChat: async (m: unknown[]) => { received = m; return okMessage; } };
  const original = [{ role: 'user', content: '原始请求' }];
  await new FallbackReviewGateway(primary as never, fallback as never).streamChat(original as never, [], () => {});
  assert.equal(received.length, 1, '没有产出就不要凭空加内容');
});

test('复核超时（signal 已中止）也必须降级', async () => {
  // 曾经把"signal 已中止"一律当成主动取消而不降级，
  // 结果独立复核模型一超时整轮就判 unavailable，兜底模型没机会跑。
  const controller = new AbortController();
  const primary = {
    getCurrentModel: () => 'p', switchModel: () => {},
    streamChat: async () => { controller.abort(); throw new Error('Review deadline exceeded'); },
  };
  let fallbackCalled = false;
  const fallback = {
    getCurrentModel: () => 'f', switchModel: () => {},
    streamChat: async () => { fallbackCalled = true; return { ...okMessage, content: 'fallback' }; },
  };
  const gw = new FallbackReviewGateway(primary as never, fallback as never);
  let fallbackSignal: unknown = 'unset';
  const fallback2 = {
    getCurrentModel: () => 'f', switchModel: () => {},
    streamChat: async (_m: unknown, _t: unknown, _e: unknown, o?: { signal?: AbortSignal }) => {
      fallbackSignal = o?.signal;
      return { ...okMessage, content: 'fallback' };
    },
  };
  const gw2 = new FallbackReviewGateway(primary as never, fallback2 as never);
  const msg = await gw2.streamChat([], [], () => {}, { signal: controller.signal });
  assert.equal(msg.content, 'fallback', '超时必须让兜底模型接手');
  assert.equal(fallbackSignal, undefined, '已中止的 signal 不能传给兜底模型，否则它立刻失败');
});

test('没配独立模型时直接用原模型', async () => {
  const fallback = { getCurrentModel: () => 'f', switchModel: () => {}, streamChat: async () => ({ ...okMessage, content: 'fallback' }) };
  const gw = new FallbackReviewGateway(null, fallback as never);
  assert.equal((await gw.streamChat([], [], () => {})).content, 'fallback');
});

/**
 * L3 单次调用的时限要由 REVIEW_MODEL_TIMEOUT_MS 决定。
 * 复核调用把 timeout 作为每次请求的时限传下去，会覆盖客户端默认值——
 * 线上实测 L3 一次调用跑了 204 秒（配置 120 秒）仍没被截住，降级被拖到整轮预算才发生。
 */
test('L3 单次调用时限取复核预算与复核模型预算的较小值', () => {
  assert.equal(reviewCallTimeoutMs(300000, 120000), 120000);
  assert.equal(reviewCallTimeoutMs(300000, 600000), 300000, '复核模型预算更大时不能被它放大');
  assert.equal(reviewCallTimeoutMs(300000, undefined), 300000, '未配置时沿用复核整体预算');
  assert.equal(reviewCallTimeoutMs(300000, 0), 300000, '0 视为未配置，不能把调用时限压成 0');
  assert.equal(reviewCallTimeoutMs(300000, 1), 1000, '下限保护：不能出现不可用的极短时限');
});
