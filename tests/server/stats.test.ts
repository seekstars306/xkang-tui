import assert from 'node:assert/strict';
import { test } from 'node:test';
import { binomialTailGE, clopperPearsonLower, clopperPearsonUpper, wilsonInterval } from '../../server/src/stats.ts';

// 锚点值来自 20-phase1-quick.md S5 步骤 1 的锚点表（独立数值积分脚本复算，容差 0.01 个百分点）。
// 150/150 一行是计划表的笔误：单侧 95% 下界的精确值为 98.02%（97.19% 是 105/105 的下界），已记入 STATUS.md 偏差栏。
const LOWER_ANCHORS: Array<[string, number, number, number]> = [
  ['59/60', 59, 60, 0.9234],
  ['58/60', 58, 60, 0.8988],
  ['100/105', 100, 105, 0.9025],
  ['99/105', 99, 105, 0.8903],
  ['142/150', 142, 150, 0.9058],
  ['96/100', 96, 100, 0.9108],
  ['150/150', 150, 150, 0.9802],
];
const UPPER_ANCHORS: Array<[string, number, number, number]> = [
  ['0/150', 0, 150, 0.0198],
  ['0/40', 0, 40, 0.0722],
  ['0/60', 0, 60, 0.0487],
];

test('Clopper-Pearson 单侧下界锚点（门槛“整答正确率下界 ≥ 90%”用）', () => {
  for (const [label, k, n, expected] of LOWER_ANCHORS) {
    const actual = clopperPearsonLower(k, n);
    assert.ok(Math.abs(actual - expected) <= 0.0001, `${label}: 期望 ${expected}，实际 ${actual}`);
  }
});

test('Clopper-Pearson 单侧上界锚点（“0 例严重误导”用）', () => {
  for (const [label, k, n, expected] of UPPER_ANCHORS) {
    const actual = clopperPearsonUpper(k, n);
    assert.ok(Math.abs(actual - expected) <= 0.0001, `${label}: 期望 ${expected}，实际 ${actual}`);
  }
});

test('边界 k=0 与 k=n 有确定值，alpha 可显式传入', () => {
  assert.equal(clopperPearsonLower(0, 100), 0);
  assert.equal(clopperPearsonUpper(100, 100), 1);
  // 闭式解 alpha^(1/n) 与 1-alpha^(1/n)：二分到双精度相邻，允许末位差
  assert.ok(Math.abs(clopperPearsonLower(100, 100) - Math.pow(0.05, 1 / 100)) < 1e-12);
  assert.ok(Math.abs(clopperPearsonUpper(0, 150) - (1 - Math.pow(0.05, 1 / 150))) < 1e-12);
  // alpha=0.01（99% 置信）比 alpha=0.05 更保守：下界更低、上界更高
  const strict = clopperPearsonLower(59, 60, 0.01);
  assert.ok(strict < clopperPearsonLower(59, 60, 0.05));
  assert.ok(Math.abs(strict - 0.894418) <= 0.0001, `59/60 alpha=0.01 下界 ${strict}`);
  assert.ok(clopperPearsonUpper(0, 40, 0.01) > clopperPearsonUpper(0, 40, 0.05));
  assert.ok(Math.abs(clopperPearsonUpper(0, 40, 0.01) - (1 - Math.pow(0.01, 1 / 40))) < 1e-12);
});

test('区间与尾部概率互为逆关系', () => {
  // k=0 的下界按约定为 0（P(X>=0|p)=1 无解），其逆关系不适用，只查上界
  assert.ok(Math.abs(binomialTailGE(150, 1, clopperPearsonUpper(0, 150)) - 0.95) < 1e-9);
  for (const [k, n] of [[1, 40], [5, 60], [58, 60], [99, 105], [142, 150]] as const) {
    const lower = clopperPearsonLower(k, n);
    const upper = clopperPearsonUpper(k, n);
    assert.ok(Math.abs(binomialTailGE(n, k, lower) - 0.05) < 1e-9, `下界尾概率 ${k}/${n}`);
    assert.ok(Math.abs(binomialTailGE(n, k + 1, upper) - 0.95) < 1e-9, `上界尾概率 ${k}/${n}`);
    assert.ok(lower <= upper);
  }
});

test('Wilson 双侧区间', () => {
  const zero40 = wilsonInterval(0, 40);
  assert.equal(zero40.lower, 0);
  assert.ok(Math.abs(zero40.upper - 0.087622) <= 0.0001, `0/40 上界 ${zero40.upper}`);
  const zero150 = wilsonInterval(0, 150);
  assert.ok(Math.abs(zero150.upper - 0.024972) <= 0.0001, `0/150 上界 ${zero150.upper}`);
  const w = wilsonInterval(59, 60);
  assert.ok(Math.abs(w.lower - 0.9114) <= 0.001 && Math.abs(w.upper - 0.9971) <= 0.001, `59/60 区间 ${w.lower}-${w.upper}`);
  const wide = wilsonInterval(5, 20);
  assert.ok(Math.abs(wide.lower - 0.111862) <= 0.001 && Math.abs(wide.upper - 0.468701) <= 0.001 && wide.lower < wide.upper, `5/20 区间 ${wide.lower}-${wide.upper}`);
});

test('binomialTailGE 边界与已知值', () => {
  assert.equal(binomialTailGE(60, 0, 0.3), 1);
  assert.equal(binomialTailGE(60, 61, 0.3), 0);
  assert.equal(binomialTailGE(60, 60, 1), 1);
  assert.equal(binomialTailGE(60, 1, 0), 0);
  assert.equal(binomialTailGE(0, 0, 0.5), 1);
  // P(X>=1) = 1-(1-p)^n；P(X>=n) = p^n
  assert.ok(Math.abs(binomialTailGE(40, 1, 0.1) - (1 - Math.pow(0.9, 40))) < 1e-12);
  assert.ok(Math.abs(binomialTailGE(150, 150, 0.98) - Math.pow(0.98, 150)) < 1e-12);
  // 与直接求和互相印证
  const logGammaBased = binomialTailGE(105, 100, 0.95);
  let direct = 0;
  const logBinom = (n: number, k: number) => {
    let acc = 0;
    for (let i = 1; i <= k; i++) acc += Math.log((n - k + i) / i);
    return acc;
  };
  for (let d = 100; d <= 105; d++) direct += Math.exp(logBinom(105, d) + d * Math.log(0.95) + (105 - d) * Math.log(0.05));
  assert.ok(Math.abs(logGammaBased - direct) < 1e-9, `${logGammaBased} vs ${direct}`);
});

test('非法输入抛错', () => {
  assert.throws(() => clopperPearsonLower(-1, 10), RangeError);
  assert.throws(() => clopperPearsonLower(11, 10), RangeError);
  assert.throws(() => clopperPearsonUpper(-1, 10), RangeError);
  assert.throws(() => clopperPearsonLower(5, 0), RangeError);
  assert.throws(() => clopperPearsonLower(5, 10, 0), RangeError);
  assert.throws(() => clopperPearsonLower(5, 10, 1), RangeError);
  assert.throws(() => clopperPearsonLower(2.5, 10), RangeError);
  assert.throws(() => binomialTailGE(-1, 0, 0.5), RangeError);
  assert.throws(() => binomialTailGE(10, 2.5, 0.5), RangeError);
  assert.throws(() => binomialTailGE(10, 5, 1.5), RangeError);
  assert.throws(() => wilsonInterval(11, 10), RangeError);
});
