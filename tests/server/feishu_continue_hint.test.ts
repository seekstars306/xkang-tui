import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContinueHint } from '../../server/src/feishu/dispatcher.ts';

/**
 * 没查完时给客服的话。
 *
 * 三件事缺一不可：
 *   ① 说清这次为什么停下（额度用完 / 没跑完），而不是"查不出结论"
 *   ② 说清"问题还没查清"——否则客服会当成最终答案
 *   ③ 说清怎么继续——**直接 @ 说「继续」就够了**，不用引用、不用重新描述
 */

test('正常出结论时不追加任何内容', () => {
  assert.equal(buildContinueHint(null), '');
});

test('额度用完：说明额度、说明未查清', () => {
  const hint = buildContinueHint('budget');
  assert.match(hint, /额度已用完/);
  assert.match(hint, /还没有查清/);
});

test('没跑完（模型超时等）：不能谎称额度用完，但同样要说明未查清', () => {
  const hint = buildContinueHint('incomplete');
  assert.match(hint, /没有跑完/);
  assert.match(hint, /还没有查清/);
  assert.doesNotMatch(hint, /额度已用完/, '不是额度问题就不能这么说');
});

test('两种原因都要讲清继续方式：直接 @ 说「继续」', () => {
  for (const reason of ['budget', 'incomplete'] as const) {
    const hint = buildContinueHint(reason);
    assert.match(hint, /直接 @我/, reason);
    assert.match(hint, /继续/, reason);
    assert.doesNotMatch(hint, /引用本条/, '客服手上一般只有一个问题，不该要求他先引用');
  }
});

test('要告诉客服不用重新描述问题', () => {
  assert.match(buildContinueHint('budget'), /不用重新描述/);
  assert.match(buildContinueHint('incomplete'), /不用重新描述/);
});

test('提示里不能出现"查不出结论"这类消极措辞', () => {
  for (const reason of ['budget', 'incomplete'] as const) {
    assert.doesNotMatch(buildContinueHint(reason), /无法确定|查不出|没有办法/);
  }
});
