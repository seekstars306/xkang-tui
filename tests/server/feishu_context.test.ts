import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildWindow,
  filterBySender,
  mentionsBot,
  resolveOrigin,
  toSummary,
  type FeishuMessageSummary,
} from '../../server/src/feishu/context.ts';

function msg(id: string, minute: number, sender: string, extra: Partial<FeishuMessageSummary> = {}): FeishuMessageSummary {
  return {
    messageId: id,
    senderOpenId: sender,
    senderType: 'user',
    createTimeMs: Date.UTC(2026, 9, 26, 1, minute),
    msgType: 'text',
    text: id,
    resourceKeys: [],
    mentions: [],
    parentId: null,
    rootId: null,
    threadId: null,
    ...extra,
  };
}

test('只在结构化 mentions 命中本机器人时触发，正文里出现名字不算', () => {
  const bot = 'ou_bot';
  const withoutMention = msg('m1', 0, 'ou_a', { text: '@小康客服助手 帮看看这个单' });
  assert.equal(mentionsBot(withoutMention, bot), false, '正文里的 @ 名字不构成触发');

  const withMention = msg('m2', 0, 'ou_a', { mentions: [{ openId: bot, name: '小康客服助手', mentionedType: 'bot' }] });
  assert.equal(mentionsBot(withMention, bot), true);

  const otherBot = msg('m3', 0, 'ou_a', { mentions: [{ openId: 'ou_other', name: '别的机器人', mentionedType: 'bot' }] });
  assert.equal(mentionsBot(otherMentionFix(otherBot), bot), false);
});

function otherMentionFix(m: FeishuMessageSummary): FeishuMessageSummary { return m; }

test('直接 @ 且无引用时，原问题就是本条', () => {
  const r = resolveOrigin(msg('m1', 0, 'ou_a', { parentId: null }));
  assert.deepEqual(r, { originMessageId: 'm1', anchorKind: 'self', degraded: false });
});

test('普通回复引用时，原问题取 parent_id', () => {
  const r = resolveOrigin(msg('m2', 5, 'ou_a', { parentId: 'm1', rootId: 'm1', threadId: null }));
  assert.equal(r.originMessageId, 'm1');
  assert.equal(r.anchorKind, 'parent');
  assert.equal(r.degraded, false);
});

test('话题内引用 parent 等于根时降级为话题根，并标记 degraded', () => {
  const r = resolveOrigin(msg('m3', 9, 'ou_a', { parentId: 'root1', rootId: 'root1', threadId: 'omt_x' }));
  assert.equal(r.originMessageId, 'root1');
  assert.equal(r.anchorKind, 'thread-root');
  assert.equal(r.degraded, true, '不能假装还原了任意楼层');
});

test('窗口取原问题前 N 条到本次 @，之后的消息不纳入', () => {
  const timeline = [
    msg('a0', 0, 'ou_x'), msg('a1', 1, 'ou_x'), msg('a2', 2, 'ou_x'),
    msg('origin', 3, 'ou_req'),
    msg('t1', 4, 'ou_x'),
    msg('trigger', 5, 'ou_req', { mentions: [{ openId: 'ou_bot', name: 'bot', mentionedType: 'bot' }] }),
    msg('later', 6, 'ou_x'),
  ];
  const trigger = timeline.find(m => m.messageId === 'trigger')!;
  const { window, originFound } = buildWindow(timeline, 'origin', trigger, { beforeCount: 2 });
  assert.equal(originFound, true);
  assert.deepEqual(window.map(m => m.messageId), ['a1', 'a2', 'origin', 't1', 'trigger'], '截点固定在本次 @，later 不得进入');
});

test('原问题之前不足 N 条时如实缩短，不向外补', () => {
  const timeline = [msg('origin', 0, 'ou_req'), msg('trigger', 1, 'ou_req')];
  const { window, truncated } = buildWindow(timeline, 'origin', timeline[1], { beforeCount: 20 });
  assert.equal(truncated, true);
  assert.equal(window.length, 2);
});

test('找不到原问题时退回只用本次消息，并在结果里可知', () => {
  const timeline = [msg('trigger', 1, 'ou_req')];
  const r = buildWindow(timeline, 'missing', timeline[0], { beforeCount: 20 });
  assert.equal(r.originFound, false);
  assert.deepEqual(r.window.map(m => m.messageId), ['trigger']);
});

test('先截窗口再按发送者过滤，原问题与本次 @ 必须保留', () => {
  const timeline = [
    msg('a0', 0, 'ou_other'), msg('a1', 1, 'ou_req'), msg('a2', 2, 'ou_other'),
    msg('origin', 3, 'ou_other'),  // 原问题由别人发出
    msg('t1', 4, 'ou_other'), msg('t2', 5, 'ou_req'),
    msg('trigger', 6, 'ou_req'),
  ];
  const trigger = timeline[6];
  const { window } = buildWindow(timeline, 'origin', trigger, { beforeCount: 20 });
  const { kept, dropped } = filterBySender(window, 'ou_req', ['origin', 'trigger']);
  assert.deepEqual(kept.map(m => m.messageId), ['a1', 'origin', 't2', 'trigger'], '别人发的原问题必须保留');
  assert.deepEqual(dropped.map(m => m.messageId), ['a0', 'a2', 't1']);
});

test('toSummary 兼容秒级与毫秒级时间戳', () => {
  const seconds = toSummary({ message_id: 'x', create_time: '1729900000' });
  const millis = toSummary({ message_id: 'y', create_time: '1729900000000' });
  assert.equal(seconds.createTimeMs, 1729900000000);
  assert.equal(millis.createTimeMs, 1729900000000);
});
