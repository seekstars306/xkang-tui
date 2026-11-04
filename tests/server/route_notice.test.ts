import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeContextNotice } from '../../server/src/agent/intent_router.ts';

/**
 * 附件（图片等非文本内容）不参与预判，因此提示必须对"看不到附件"这件事保持诚实：
 * 不能说成"没有可定位信息"，而要请模型先看附件。
 */
test('带附件且信息不足时，提示要求先看附件而不是直接向用户索要', () => {
  const notice = routeContextNotice(
    { route: 'l2_complex', confidence: 0.8 },
    { sufficient: 'need_more', confidence: 1 },
    true,
  );
  assert.match(notice, /附带了附件/);
  assert.match(notice, /先查看附件/);
  assert.match(notice, /附件中确实没有时/, '只在附件里也没有时才索要');
  assert.doesNotMatch(notice, /该问题可能是业务问题，但输入里没有可定位/);
});

test('不带附件且信息不足时，保持原来的索要最小必要信息', () => {
  const notice = routeContextNotice(
    { route: 'l2_complex', confidence: 0.8 },
    { sufficient: 'need_more', confidence: 1 },
    false,
  );
  assert.match(notice, /输入里没有可定位的单号/);
  assert.doesNotMatch(notice, /附件/);
});

test('ambiguous 带附件时先看附件再决定是否澄清', () => {
  const notice = routeContextNotice({ route: 'ambiguous', confidence: 0.7 }, undefined, true);
  assert.match(notice, /先查看附件内容/);
  assert.match(notice, /附件已足够定位时直接排查/);
});

test('信息充足时，带不带附件都不附加索取指令', () => {
  for (const withAttachment of [true, false]) {
    const notice = routeContextNotice({ route: 'l2_complex', confidence: 1 }, { sufficient: 'ready', confidence: 1 }, withAttachment);
    assert.doesNotMatch(notice, /索取|查看附件/);
  }
});

test('提示统一用「附件」而不是「截图」，因为内容类型不定', () => {
  const notices = [
    routeContextNotice({ route: 'l2_complex', confidence: 1 }, { sufficient: 'need_more', confidence: 1 }, true),
    routeContextNotice({ route: 'ambiguous', confidence: 1 }, undefined, true),
  ];
  for (const n of notices) {
    assert.match(n, /附件/);
    assert.doesNotMatch(n, /截图/);
  }
});
