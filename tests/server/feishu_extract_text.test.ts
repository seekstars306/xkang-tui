import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * 消息正文提取。两个来源形态不同：
 * - 历史接口：body.content 是 JSON 字符串 {"text":"..."}
 * - 事件推送：content 已经是纯文本（@ 已还原）
 *
 * 真实事故：客服的消息以订单号开头、整段恰好是合法 JSON（一个数字），
 * 旧实现先 JSON.parse 再取 .text，parse 成功但没有 .text，于是返回空串，
 * 「本次问题原文」整段丢失，模型拿不到问题。
 */

// 与 dispatcher 同口径的实现
function cleanMentions(text: string): string {
  return text.replace(/@_user_\d+/g, '').replace(/\u200b/g, '').trim();
}
function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
function textFromParsed(parsed: Record<string, unknown>): string {
  if (typeof parsed.text === 'string') return cleanMentions(parsed.text);
  const post = parsed.content;
  if (Array.isArray(post)) {
    return cleanMentions(post.flat().map((n: any) => (typeof n?.text === 'string' ? n.text : '')).join(''));
  }
  return '';
}
function extractText(item: Record<string, unknown>): string {
  const bodyContent = (item.body as Record<string, unknown> | undefined)?.content;
  const contentField = item.content;
  if (typeof bodyContent === 'string' && bodyContent.trim()) {
    const parsed = tryParseJsonObject(bodyContent);
    if (parsed) { const t = textFromParsed(parsed); if (t) return t; }
    return cleanMentions(bodyContent);
  }
  if (typeof contentField === 'string') {
    const trimmed = contentField.trim();
    if (!trimmed) return '';
    const parsed = trimmed.startsWith('{') ? tryParseJsonObject(trimmed) : null;
    if (parsed) { const t = textFromParsed(parsed); if (t) return t; }
    return cleanMentions(trimmed);
  }
  return '';
}

test('事件形态：纯文本直接返回，不当 JSON 解析', () => {
  const evt = { content: '能帮我查一下这个航变短信的原因吗' };
  assert.equal(extractText(evt), '能帮我查一下这个航变短信的原因吗');
});

test('事件形态：整段恰好是合法 JSON（纯数字）也必须原样返回', () => {
  // 这就是真实事故的输入：以订单号开头，整体能被 JSON.parse 成数字
  const evt = { content: '18765322976' };
  assert.equal(extractText(evt), '18765322976', '不能因为能 parse 成数字就返回空');
});

test('事件形态：以订单号开头的长文本完整保留', () => {
  const long = '18765322976  赵玉婷   山东电力建设第三工程有限公司；\n华丰创建申请单，用因公护照推送不过来';
  assert.equal(extractText({ content: long }), long.trim());
});

test('历史形态：body.content 是 JSON 字符串时取出 text', () => {
  const item = { body: { content: JSON.stringify({ text: '历史消息内容' }) } };
  assert.equal(extractText(item), '历史消息内容');
});

test('历史形态：富文本按 content 数组拼接', () => {
  const post = { content: [[{ tag: 'text', text: '第一段' }, { tag: 'text', text: '第二段' }]] };
  const item = { body: { content: JSON.stringify(post) } };
  assert.equal(extractText(item), '第一段第二段');
});

test('两种形态都要剥掉 @_user_N 占位符', () => {
  assert.equal(extractText({ content: '@_user_1 帮我看下这个单' }), '帮我看下这个单');
  const item = { body: { content: JSON.stringify({ text: '@_user_1 历史里也有@' }) } };
  assert.equal(extractText(item), '历史里也有@');
});

test('空内容返回空串，不抛错', () => {
  assert.equal(extractText({}), '');
  assert.equal(extractText({ content: '   ' }), '');
});

test('看起来像 JSON 但解析失败时，原文照常返回', () => {
  const broken = '{这不是合法json';
  assert.equal(extractText({ content: broken }), broken);
});
