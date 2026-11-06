import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ANSWER_GUIDE, answerGuide, businessPrompt, validateAnswerGuide } from '../../server/src/agent/answer_guide.ts';
import { BUSINESS_PROMPT } from '../../server/src/agent/service.ts';
import { runScenario, SCENARIOS, withEnv } from '../helpers/review_mode_fixture.ts';

// 答案写法开关 ANSWER_GUIDE：关闭时提示词逐字节不变；开启时冻结锚点仍在、写法规则真的进了发给模型的 system。

test('ANSWER_GUIDE 取值：未设置/off 为 off，v2 开启，写错时运行期按 off、启动校验报错', () => {
  assert.equal(answerGuide({}), 'off');
  assert.equal(answerGuide({ ANSWER_GUIDE: ' V2 ' }), 'v2');
  assert.equal(answerGuide({ ANSWER_GUIDE: 'v3' }), 'off');
  assert.equal(validateAnswerGuide({ ANSWER_GUIDE: 'off' }), 'off');
  assert.throws(() => validateAnswerGuide({ ANSWER_GUIDE: 'v3' }), /ANSWER_GUIDE 只能是 v2 或 off/);
});

test('关闭时业务提示词与原文逐字节一致', () => {
  assert.equal(businessPrompt(BUSINESS_PROMPT, 'off'), BUSINESS_PROMPT);
});

test('开启时：去掉"结论只概括一两句"，追加写法规则，service.ts 的冻结锚点全部保留', () => {
  const p = businessPrompt(BUSINESS_PROMPT, 'v2');
  assert.ok(!p.includes('结论只概括一两句'));
  assert.ok(p.endsWith(ANSWER_GUIDE));
  const frozen = JSON.parse(fs.readFileSync('tests/eval/frozen-rules.json', 'utf8')).entries.filter((e: any) => e.file === 'server/src/agent/service.ts' && e.anchor);
  assert.ok(frozen.length > 0, '测试前提：service.ts 有冻结锚点');
  for (const e of frozen) assert.ok(p.includes(e.anchor), '冻结锚点被改动：' + e.id);
});

test('接线：开关决定发给排查模型的 system 是否包含写法规则', async () => {
  const systemOf = (run: any) => { const m = run.main[0].messages.find((x: any) => x.role === 'system'); return typeof m.content === 'string' ? m.content : JSON.stringify(m.content); };
  const off = await withEnv({ ANSWER_GUIDE: undefined }, () => runScenario('off', SCENARIOS.pass));
  assert.ok(!systemOf(off).includes('【答案写法】'));
  assert.ok(systemOf(off).includes('结论只概括一两句'));
  const on = await withEnv({ ANSWER_GUIDE: 'v2' }, () => runScenario('off', SCENARIOS.pass));
  assert.ok(systemOf(on).includes('【答案写法】'));
  assert.ok(!systemOf(on).includes('结论只概括一两句'));
});
