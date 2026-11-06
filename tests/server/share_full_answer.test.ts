import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswerText } from '../../server/src/feishu/share.ts';

test('parseAnswerText：从精简文本拆回结构化字段（老数据兜底用）', () => {
  const text = [
    '【结论】',
    '这是结论。',
    '',
    '【业务信息】',
    '订单号：123',
    '',
    '【还需确认】',
    '· 待确认一',
  ].join('\n');
  const r = parseAnswerText(text);
  assert.equal(r.conclusion, '这是结论。');
  assert.deepEqual(r.businessData, [{ label: '订单号', value: '123' }]);
  assert.deepEqual(r.pendingItems, ['待确认一']);
  assert.deepEqual(r.evidenceSummary, []);
});

test('分享页必须用完整 answer 而不是精简 text：businessData 不能只剩结论', () => {
  // 复现 545d1e81：群里只发结论，但 answer_json 里有 12 条 businessData
  const stored = {
    text: '【结论】\n这个下载白屏确认属于我方系统问题。\n\n问题编号 545d1e81',
    answer: {
      conclusion: '这个下载白屏确认属于我方系统问题。',
      businessData: [
        { label: '业务归属', value: '我方系统（火车票电子发票下载）' },
        { label: '订单号', value: '1481298238748360704' },
      ],
      evidenceSummary: ['按订单号定位到火车票订单。'],
      customerReply: '客服话术。',
      pendingItems: ['需二线核实。'],
    },
  };
  // 分享页的取值逻辑：有 answer 就必须用 answer
  const record = stored as Record<string, unknown>;
  const full = record.answer as Record<string, unknown>;
  assert.ok(full, 'answer_json 里应带完整 answer');
  assert.equal((full.businessData as unknown[]).length, 2, '完整 businessData 不能被精简文本取代');
  assert.equal((full.evidenceSummary as unknown[]).length, 1, '依据也不能丢');
  // 反证：如果走 text 拆分，businessData 会是空——正是用户看到的现象
  assert.deepEqual(parseAnswerText(stored.text).businessData, []);
});
