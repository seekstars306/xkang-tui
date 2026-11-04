import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContent } from '../../server/src/feishu/context.ts';

/**
 * 输入结构的核心约束：**本次问题是主体，历史材料只是补充**。
 *
 * 真实故障：客服问“因公护照推送不过来”，但上下文里混了前一天更显眼的
 * “航变短信发送失败”，模型转而把航变短信当成主问题去查，答非所问。
 * 所以问题原文必须单独成段、出现在材料之前。
 */

function textOf(parts: ReturnType<typeof buildContent>): string {
  const first = parts.find(p => p.type === 'text');
  return first && 'text' in first ? String(first.text) : '';
}

test('问题原文单独成段，且排在历史材料之前', () => {
  const parts = buildContent(
    '[10:00] 客服：昨天的航变短信查一下',
    [],
    '客服在飞书群里提出了下面这个问题，请以它为准排查。',
    '赵玉婷用因公护照推送不过来，用身份证可以',
  );
  const text = textOf(parts);
  const qIdx = text.indexOf('赵玉婷用因公护照');
  const hIdx = text.indexOf('昨天的航变短信');
  assert.ok(qIdx >= 0, '问题原文必须出现');
  assert.ok(hIdx >= 0, '历史材料应保留');
  assert.ok(qIdx < hIdx, '问题原文必须排在历史材料之前，否则模型会答旧问题');
});

test('问题原文有独立小标题，与历史材料区隔', () => {
  const text = textOf(buildContent('历史内容', [], '说明', '本次问题'));
  assert.match(text, /【本次问题原文】/);
  assert.match(text, /【群内历史中与本次问题相关的材料】/);
});

test('没有相关历史时，只输出问题本身，不留空标题', () => {
  const text = textOf(buildContent('', [], '说明', '只有这一个问题'));
  assert.match(text, /【本次问题原文】/);
  assert.doesNotMatch(text, /【群内历史/, '没有历史就不要出现空标题');
});

test('问题原文为空时不留空段落', () => {
  const text = textOf(buildContent('历史', [], '说明', '   '));
  assert.doesNotMatch(text, /【本次问题原文】/, '空问题不应产生空标题');
  assert.match(text, /【群内历史/);
});
