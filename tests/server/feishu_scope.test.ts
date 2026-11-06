import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildScope, DEFAULT_HISTORY_MINUTES } from '../../server/src/feishu/context.ts';
import type { FeishuMessageSummary } from '../../server/src/feishu/context.ts';

/**
 * 范围定义（用户口径）：
 *   ① 被引用那条（原问题）
 *   ② 原问题往前 30 分钟内的最近 20 条 —— **只算 A 的消息**
 *   ③ 原问题 → 本次@ 之间，距原问题 30 分钟内的所有会话 —— **只算 A 的消息**
 *   ④ @ 当条（无论 A 还是 B）
 *
 * ②③ 只统计 A：别人的发言既不占 20 条名额，也不进范围。
 * 否则群里刷屏时，A 的真实上下文会被挤掉。
 */

const MIN = 60_000;
const BASE = Date.UTC(2026, 9, 27, 6, 0, 0);

function msg(id: string, offsetMin: number, sender = 'ou_a', text = id): FeishuMessageSummary {
  return {
    messageId: id, senderOpenId: sender, senderType: 'user',
    createTimeMs: BASE + offsetMin * MIN,
    msgType: 'text', text, resourceKeys: [], mentions: [],
    parentId: null, rootId: null, threadId: null,
  };
}

const origin = msg('origin', 0, 'ou_a', '护照推送不过来');

test('默认窗口就是 30 分钟', () => {
  assert.equal(DEFAULT_HISTORY_MINUTES, 30);
});

// ---------- ① 原问题 ----------

test('① 原问题本身在范围内', () => {
  const trigger = msg('tg', 5);
  const { scope, originFound } = buildScope([origin, trigger], 'origin', trigger);
  assert.equal(originFound, true);
  assert.ok(scope.some(m => m.messageId === 'origin'));
});

// ---------- ② 往前 ----------

test('② 往前只取 30 分钟内的最近 20 条', () => {
  const timeline: FeishuMessageSummary[] = [origin];
  for (let i = 1; i <= 25; i++) timeline.push(msg('m' + i, -i));
  timeline.push(msg('too-old-1', -35));
  timeline.push(msg('too-old-2', -50));
  const trigger = msg('tg', 2);
  timeline.push(trigger);

  const { scope, backCount } = buildScope(timeline, 'origin', trigger, { backMinutes: 30, backCount: 20 });
  assert.equal(backCount, 20, '往前最多 20 条');
  assert.ok(!scope.some(m => m.messageId === 'too-old-1'), '超出 30 分钟不取');
  assert.ok(!scope.some(m => m.messageId === 'too-old-2'));
  assert.ok(scope.some(m => m.messageId === 'm20'), '最近的一批要在');
  assert.ok(!scope.some(m => m.messageId === 'm21'), '更早的 21..25 被 20 条上限挤掉');
});

test('② 只数 A 的消息：别人的发言不占 20 条名额', () => {
  const timeline: FeishuMessageSummary[] = [origin];
  for (let i = 1; i <= 30; i++) timeline.push(msg('b' + i, -i, 'ou_b'));
  timeline.push(msg('a2', -25, 'ou_a'));
  timeline.push(msg('a3', -12, 'ou_a'));
  const trigger = msg('tg', 2, 'ou_b');
  timeline.push(trigger);

  const { scope, backCount } = buildScope(timeline, 'origin', trigger, {
    backMinutes: 30, backCount: 20, senderOpenId: 'ou_a',
  });
  assert.equal(backCount, 2, '只要 a2、a3');
  assert.ok(!scope.some(m => m.messageId.startsWith('b')), 'B 的消息一条都不进范围');
  assert.ok(scope.some(m => m.messageId === 'a2'));
  assert.ok(scope.some(m => m.messageId === 'a3'));
});

// ---------- ③ 往后 ----------

test('③ 原问题之后 30 分钟内的会话都要（A 的）', () => {
  const timeline = [
    origin,
    msg('after-5', 5, 'ou_a'),
    msg('after-20', 20, 'ou_a'),
    msg('after-40', 40, 'ou_a'),
    msg('tg', 60),
  ];
  const { scope } = buildScope(timeline, 'origin', msg('tg', 60), { forwardMinutes: 30, senderOpenId: 'ou_a' });
  assert.ok(scope.some(m => m.messageId === 'after-5'));
  assert.ok(scope.some(m => m.messageId === 'after-20'));
  assert.ok(!scope.some(m => m.messageId === 'after-40'), '后 40 分钟超出窗口');
});

test('③ 只含 A 的消息，B 在中间的发言不进范围', () => {
  const trigger = msg('tg', 10, 'ou_b');
  const timeline = [origin, msg('b-mid', 3, 'ou_b'), msg('a-mid', 6, 'ou_a'), msg('b-mid2', 9, 'ou_b'), trigger];
  const { scope } = buildScope(timeline, 'origin', trigger, { forwardMinutes: 30, senderOpenId: 'ou_a' });
  assert.deepEqual(scope.map(m => m.messageId), ['origin', 'a-mid', 'tg']);
});

test('③ 往后上界被 @ 时间截断', () => {
  const trigger = msg('tg', 10);
  const timeline = [origin, msg('near', 3), trigger];
  const { scope } = buildScope(timeline, 'origin', trigger, { forwardMinutes: 30 });
  assert.ok(scope.some(m => m.messageId === 'near'));
});

// ---------- ④ @ 当条 ----------

test('④ @ 当条一定在，即使距离原问题很远', () => {
  const trigger = msg('tg', 600);
  const { scope } = buildScope([origin, trigger], 'origin', trigger);
  assert.ok(scope.some(m => m.messageId === 'tg'), '@ 不管多久都要在');
  assert.ok(scope.some(m => m.messageId === 'origin'));
});

test('④ @ 当条不受发送者限制：B 发的也一定在', () => {
  const triggerB = msg('tg-b', 5, 'ou_b');
  const { scope } = buildScope([origin, triggerB], 'origin', triggerB, { senderOpenId: 'ou_a' });
  assert.ok(scope.some(m => m.messageId === 'tg-b'), 'B 发起的 @ 必须保留');
});

// ---------- 边界 ----------

test('原问题找不到时退化为只用 @', () => {
  const trigger = msg('tg', 0, 'ou_b');
  const { scope, originFound } = buildScope([msg('x', -5), trigger], 'missing', trigger);
  assert.equal(originFound, false);
  assert.deepEqual(scope.map(m => m.messageId), ['tg']);
});

test('范围按时间升序，且不重复', () => {
  const trigger = msg('tg', 10);
  const timeline = [origin, msg('a', -5), msg('b', 5), trigger];
  const { scope } = buildScope(timeline, 'origin', trigger, { senderOpenId: 'ou_a' });
  const ids = scope.map(m => m.messageId);
  assert.equal(new Set(ids).size, ids.length, '不能有重复');
  const times = scope.map(m => m.createTimeMs);
  assert.deepEqual([...times].sort((x, y) => x - y), times, '必须升序');
});

test('不传 senderOpenId 时不过滤发送者（保持通用）', () => {
  const trigger = msg('tg', 2, 'ou_b');
  const timeline = [origin, msg('b1', -5, 'ou_b'), trigger];
  const { scope } = buildScope(timeline, 'origin', trigger);
  assert.ok(scope.some(m => m.messageId === 'b1'), '不传时 B 的消息也在');
});
