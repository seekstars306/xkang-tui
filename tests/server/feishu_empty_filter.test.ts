import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterBySenders } from '../../server/src/feishu/context.ts';
import type { FeishuMessageSummary } from '../../server/src/feishu/context.ts';

function msg(id: string, minute: number, sender: string, text = id, resourceKeys: string[] = []): FeishuMessageSummary {
  return {
    messageId: id, senderOpenId: sender, senderType: 'user',
    createTimeMs: Date.UTC(2026, 9, 26, 1, minute),
    msgType: resourceKeys.length ? 'image' : 'text',
    text, resourceKeys, mentions: [],
    parentId: null, rootId: null, threadId: null,
  };
}

test('清洗后既无正文也无附件的消息不进入上下文', () => {
  const window = [
    msg('real', 0, 'ou_A', '订单 123 有问题'),
    msg('empty1', 1, 'ou_A', ''),           // 空文本
    msg('empty2', 2, 'ou_A', ''),           // 空文本
  ];
  const { kept, dropped } = filterBySenders(window, new Set(['ou_A']), []);
  assert.deepEqual(kept.map(m => m.messageId), ['real'], '空消息应被剔除，否则白白占上下文');
  assert.deepEqual(dropped.map(m => m.messageId), ['empty1', 'empty2']);
});

test('只有图片没有文字的消息必须保留（正文由附件承载）', () => {
  const window = [msg('img', 0, 'ou_A', '', ['img_key_1'])];
  const { kept } = filterBySenders(window, new Set(['ou_A']), []);
  assert.deepEqual(kept.map(m => m.messageId), ['img'], '图片消息不能被当成空消息删掉');
});

test('原问题即使是空的也必须保留，否则窗口失去定位依据', () => {
  const window = [msg('origin', 0, 'ou_A', '')];
  const { kept } = filterBySenders(window, new Set(['ou_A']), ['origin']);
  assert.deepEqual(kept.map(m => m.messageId), ['origin']);
});

test('本次 @ 即使是空的也必须保留', () => {
  const window = [msg('trigger', 0, 'ou_B', '')];
  const { kept } = filterBySenders(window, new Set(['ou_B']), ['trigger']);
  assert.deepEqual(kept.map(m => m.messageId), ['trigger']);
});
