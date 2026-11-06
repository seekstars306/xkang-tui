import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStopIntent } from '../../server/src/feishu/stop_intent.ts';

/**
 * 停止意图判定。
 *
 * 判定完全交给 Jev，不自建关键词表：「别停吧」「先别停，继续查」这类否定说法
 * 用词表很容易判反，反过来会误停一整轮排查。
 *
 * 安全方向是**不停止**：Jev 不可达、超时、没给明确判断，一律不停。
 */

test('没有 Jev 密钥时一律不停止，并说明原因', async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const r = await isStopIntent('停', { timeoutMs: 100 });
    assert.equal(r.shouldStop, false, '判不了就不能停');
    assert.ok(r.degraded, '应说明为何没判');
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

test('空消息直接返回不停止', async () => {
  assert.equal((await isStopIntent('', { timeoutMs: 50 })).shouldStop, false);
  assert.equal((await isStopIntent('   ', { timeoutMs: 50 })).shouldStop, false);
});

test('否定说法一律不能判成停止（Jev 在线时是真实校验；离线时退路也是不停止）', async () => {
  const negations = ['别停吧', '别停', '先别停', '不要停', '不用停', '先别停，继续查', '别停止排查'];
  for (const text of negations) {
    const r = await isStopIntent(text, { timeoutMs: 3000 });
    assert.equal(r.shouldStop, false, `不能把否定当成停止：${text}`);
  }
});
