import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * 问题内容的来源：被引用那条 与 本次 @ 那条 **都可能带内容**，不是二选一。
 *
 * 三种真实用法：
 *   A. 引用原问题 + 只发 @bot            → 内容在引用条
 *   B. 直接 @bot + 写一段问题            → 内容在 @ 条
 *   C. 引用上下文 + 本次再补充说明        → 两条都有内容，都要带上
 *
 * 之前两次都错在把它当二选一：只取 trigger 会让 A 变成空主体，
 * 只取引用条会让 B 丢失问题。
 */

interface Msg { messageId: string; text: string; resourceKeys: string[]; createTimeMs: number }

function pickPrimary(trigger: Msg, origin: Msg | undefined): { parts: Msg[]; text: string } {
  const parts = [origin, trigger]
    .filter((m): m is Msg => Boolean(m))
    .filter((m, i, arr) => arr.findIndex(x => x.messageId === m.messageId) === i)
    .filter(m => m.text.trim().length > 0 || m.resourceKeys.length > 0)
    .sort((a, b) => a.createTimeMs - b.createTimeMs);
  const text = parts.map(m => m.text.trim()).filter(Boolean).join('\n\n');
  return { parts, text };
}

const T = Date.UTC(2026, 9, 27, 2, 37, 24);
const origin: Msg = { messageId: 'om_origin', text: '18765322976 赵玉婷 华丰创建申请单，用因公护照推送不过来', resourceKeys: [], createTimeMs: T - 8000 };
const emptyTrigger: Msg = { messageId: 'om_trigger', text: '', resourceKeys: [], createTimeMs: T };
const textTrigger: Msg = { messageId: 'om_trigger2', text: '发票开不出来', resourceKeys: [], createTimeMs: T };

test('A：引用有问题内容 + 只发 @ → 主体是引用条', () => {
  const { parts, text } = pickPrimary(emptyTrigger, origin);
  assert.deepEqual(parts.map(p => p.messageId), ['om_origin']);
  assert.match(text, /因公护照推送不过来/);
});

test('B：直接 @ 并写问题 → 主体是 @ 条', () => {
  const { parts, text } = pickPrimary(textTrigger, undefined);
  assert.deepEqual(parts.map(p => p.messageId), ['om_trigger2']);
  assert.equal(text, '发票开不出来');
});

test('C：引用上下文 + 本次补充 → 两条都要保留，按时间排序', () => {
  const followUp: Msg = { messageId: 'om_t3', text: '另外客户说下午来催', resourceKeys: [], createTimeMs: T };
  const { parts, text } = pickPrimary(followUp, origin);
  assert.deepEqual(parts.map(p => p.messageId), ['om_origin', 'om_t3'], '引用条在前，补充在后');
  assert.match(text, /因公护照/);
  assert.match(text, /下午来催/);
});

test('引用条和 @ 条是同一人同一条时不会重复', () => {
  const { parts } = pickPrimary(origin, origin);
  assert.equal(parts.length, 1, '同一条不能被算两次');
});

test('两条都为空（纯 @ 无引用）时 parts 为空，由调用方兜底', () => {
  const { parts } = pickPrimary(emptyTrigger, undefined);
  assert.equal(parts.length, 0);
});

test('只有图片的消息也算有内容', () => {
  const imgOrigin: Msg = { messageId: 'om_img', text: '', resourceKeys: ['k1'], createTimeMs: T - 1000 };
  const { parts } = pickPrimary(emptyTrigger, imgOrigin);
  assert.deepEqual(parts.map(p => p.messageId), ['om_img']);
});
