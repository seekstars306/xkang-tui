import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideRoute, LOW_CONFIDENCE_FLOOR } from '../../server/src/agent/intent_router.ts';

/** 分流折算规则：ambiguous 走追问；低置信度一律升级 L2（防止 L1 时代的漏判） */
test('l2_complex / l1_simple / ambiguous 原样透传', () => {
  assert.equal(decideRoute({ choice: 'l2_complex', confidence: 0.9 }).route, 'l2_complex');
  assert.equal(decideRoute({ choice: 'l1_simple', confidence: 0.9 }).route, 'l1_simple');
  assert.equal(decideRoute({ choice: 'ambiguous', confidence: 0.9 }).route, 'ambiguous');
});

test('置信度低于下限时一律升级 L2，不把业务问题当闲聊', () => {
  const low = decideRoute({ choice: 'l1_simple', confidence: LOW_CONFIDENCE_FLOOR - 0.01 });
  assert.equal(low.route, 'l2_complex');
  assert.match(String(low.error), /低于/);
});

test('分类结果为空或异常时退回 l2_complex，绝不退化成闲聊', () => {
  assert.equal(decideRoute(undefined).route, 'l2_complex');
  assert.equal(decideRoute({} as never).route, 'l2_complex');
  assert.equal(decideRoute({ choice: 'l1_simple' }).route, 'l2_complex', '缺 confidence 视为 0');
});

test('边界值：恰好等于下限时不升级', () => {
  assert.equal(decideRoute({ choice: 'l1_simple', confidence: LOW_CONFIDENCE_FLOOR }).route, 'l1_simple');
});
