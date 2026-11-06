import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_HISTORY_MINUTES } from '../../server/src/feishu/relevance.ts';

/**
 * 时间相关性规则。
 *
 * 真实故障：客服问“因公护照推送不过来”，上下文里混进了 16 小时前的
 * “航变短信发送失败”，模型转而回答旧问题。
 * 群聊里超过半小时的对话，几乎必然已经换了话题，所以要在两处同时约束：
 * 程序侧先粗筛，Jev 侧再按显式的时间差判断。
 */

/**
 * 与 dispatcher 同口径：候选消息的时间窗过滤。
 *
 * anchorMs 取**被引用那条（原问题）**的时间，不是本次 @ 的时间；
 * 只向前截（比锚点早太多才剔除），原问题之后的补充一律保留。
 */
function withinWindow(anchorMs: number, msgMs: number, windowMinutes = MAX_HISTORY_MINUTES): boolean {
  return anchorMs - msgMs <= windowMinutes * 60_000;
}

const MIN = 60_000;

test('半小时内算候选，超过则排除', () => {
  const now = Date.UTC(2026, 9, 27, 1, 0, 0);
  assert.equal(withinWindow(now, now - 5 * MIN), true, '5 分钟前的补充应保留');
  assert.equal(withinWindow(now, now - 29 * MIN), true, '29 分钟仍在窗口内');
  assert.equal(withinWindow(now, now - 31 * MIN), false, '31 分钟应排除');
  assert.equal(withinWindow(now, now - 16 * 60 * MIN), false, '16 小时前的完全不同的话题必须排除');
});

test('时间窗常量就是半小时', () => {
  assert.equal(MAX_HISTORY_MINUTES, 30);
});

test('同一时刻的消息也算候选（间隔 0）', () => {
  const now = Date.UTC(2026, 9, 27, 1, 0, 0);
  assert.equal(withinWindow(now, now), true);
});

test('未来时间戳不会被误判为超窗', () => {
  const now = Date.UTC(2026, 9, 27, 1, 0, 0);
  // 负差值为负数，必然 <= 窗口，属于异常数据但不应导致崩溃
  assert.equal(withinWindow(now, now + 5 * MIN), true);
});
