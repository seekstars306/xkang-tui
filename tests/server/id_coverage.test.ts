import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idCheck, missingIds, questionIds, validateIdCheck } from '../../server/src/agent/id_coverage.ts';
import { DRAFT_1, DRAFT_2, REJECTED, runScenario, withEnv, type DraftText } from '../helpers/review_mode_fixture.ts';

// 问题号码交代检查（ANSWER_ID_CHECK）：客服给出的号码在答案里没有交代时退回一次补查；最后一稿照常发布，绝不兜底。

const ORDER = '1530517490084478976';
const strip = (d: any) => ({ ...d, conclusion: d.conclusion.replaceAll(ORDER, '该'), businessData: d.businessData.filter((x: any) => x.value !== ORDER) });
const NOID_1 = strip(DRAFT_1), NOID_2 = strip(DRAFT_2);
const env = (a: any) => (evidenceId: string) => JSON.stringify({ answer: a, evidenceIds: [evidenceId] });
const lastCallText = (run: any) => run.main.at(-1).messages.map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

test('取号：手机号、订单号算；问题编号、消息编号这类夹在字母数字里的不算；短数字不算', () => {
  assert.deepEqual(questionIds('7814836790003，哥，看一下账单？李旭 15066808805'), ['7814836790003', '15066808805']);
  assert.deepEqual(questionIds('客服在飞书群里提出了下面这个问题（问题编号 c4a2f188）。消息 om_x100b6111234567890abc 金额 2700 元'), []);
  assert.deepEqual(missingIds(['15066808805', '7814836790003'], '票号 7814836790003 已出票'), ['15066808805']);
  assert.equal(idCheck({}), 'off');
  assert.equal(idCheck({ ANSWER_ID_CHECK: ' ON ' }), 'on');
  assert.throws(() => validateIdCheck({ ANSWER_ID_CHECK: 'yes' }), /ANSWER_ID_CHECK 只能是 on 或 off/);
});

test('开启：初稿漏交代问题里的号码 → 退回一次（允许补查），修订稿交代了就发布修订稿', async () => {
  const drafts: DraftText = (evidenceId, round) => (round === 1 ? env(NOID_1)(evidenceId) : env(DRAFT_2)(evidenceId));
  const run = await withEnv({ ANSWER_ID_CHECK: 'on' }, () => runScenario('off', { review: { kind: 'judge', rejected: REJECTED }, drafts }));
  assert.equal(run.reviews.length, 0, '不调用复核模型');
  assert.equal(run.main.length, 3, '查询 + 初稿 + 修订稿');
  assert.match(lastCallText(run), new RegExp('客服在问题里给出了 ' + ORDER));
  assert.equal(run.answer.conclusion, DRAFT_2.conclusion, '发布修订稿');
});

test('开启：修订稿仍漏交代 → 照常发布最后一稿，不兜底', async () => {
  const drafts: DraftText = (evidenceId, round) => env(round === 1 ? NOID_1 : NOID_2)(evidenceId);
  const run = await withEnv({ ANSWER_ID_CHECK: 'on' }, () => runScenario('off', { review: { kind: 'judge', rejected: REJECTED }, drafts }));
  assert.equal(run.main.length, 3);
  assert.equal(run.answer.conclusion, NOID_2.conclusion, '最后一稿照常发布');
  assert.doesNotMatch(run.answer.conclusion, /尚未形成/);
});

test('关闭（缺省）：漏交代也不退回，行为与引入前一致', async () => {
  const drafts: DraftText = (evidenceId) => env(NOID_1)(evidenceId);
  const run = await withEnv({ ANSWER_ID_CHECK: undefined }, () => runScenario('off', { review: { kind: 'judge', rejected: REJECTED }, drafts }));
  assert.equal(run.main.length, 2, '查询 + 初稿，没有修订');
  assert.equal(run.answer.conclusion, NOID_1.conclusion);
});

test('开启：格式坏且漏号码 → 一次退回里同时讲格式和号码', async () => {
  const drafts: DraftText = (evidenceId, round) => (round === 1 ? '## 结论\n该订单共收款两次' : env(DRAFT_2)(evidenceId));
  const run = await withEnv({ ANSWER_ID_CHECK: 'on' }, () => runScenario('off', { review: { kind: 'judge', rejected: REJECTED }, drafts }));
  const text = lastCallText(run);
  assert.match(text, /中文键名/);
  assert.match(text, new RegExp('客服在问题里给出了 ' + ORDER));
  assert.equal(run.answer.conclusion, DRAFT_2.conclusion);
});
