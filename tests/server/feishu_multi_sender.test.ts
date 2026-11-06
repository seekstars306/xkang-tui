import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterBySenders } from '../../server/src/feishu/context.ts';
import type { FeishuMessageSummary } from '../../server/src/feishu/context.ts';

function msg(id: string, minute: number, sender: string): FeishuMessageSummary {
  return {
    messageId: id, senderOpenId: sender, senderType: 'user',
    createTimeMs: Date.UTC(2026, 9, 26, 1, minute),
    msgType: 'text', text: id, resourceKeys: [], mentions: [],
    parentId: null, rootId: null, threadId: null,
  };
}

test('A 发问题、B 来 @ 时，两人的消息都要保留', () => {
  const window = [
    msg('a1', 0, 'ou_A'),   // 原问题作者提供的材料
    msg('a2', 1, 'ou_B'),   // 发起人补充
    msg('c1', 2, 'ou_C'),   // 无关的人
  ];
  const { kept, dropped } = filterBySenders(window, new Set(['ou_A', 'ou_B']), []);
  assert.deepEqual(kept.map(m => m.messageId), ['a1', 'a2'], 'A 的材料不能被当成外人剔掉');
  assert.deepEqual(dropped.map(m => m.messageId), ['c1']);
});

test('只传一个发送者时退化为原行为', () => {
  const window = [msg('x', 0, 'ou_A'), msg('y', 1, 'ou_B')];
  const { kept } = filterBySenders(window, new Set(['ou_A']), []);
  assert.deepEqual(kept.map(m => m.messageId), ['x']);
});

test('原问题由外人发出时，也必须按 mustKeep 保留', () => {
  const window = [msg('origin', 0, 'ou_other'), msg('mine', 1, 'ou_A')];
  const { kept } = filterBySenders(window, new Set(['ou_A']), ['origin']);
  assert.deepEqual(kept.map(m => m.messageId), ['origin', 'mine'], '原问题是定位依据，不能因为作者是别人就丢');
});
