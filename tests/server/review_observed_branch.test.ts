import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import type { ChatGateway, Message } from '@xkang/agent-core';
import { messageText } from '@xkang/agent-core/context';
import { observedBranchEnabled, OBSERVED_BRANCH_REVISION, OBSERVED_BRANCH_RULE } from '../../server/src/agent/observed_branch.ts';
import { REVISION_DISCIPLINE, reviewAnswer, revisionDiscipline } from '../../server/src/agent/review.ts';
import type { PublicDraft } from '../../server/src/agent/publication.ts';

// 复核口径开关 REVIEW_OBSERVED_BRANCH（observed_branch.ts，默认关闭，只用于对照实验）的防倒退测试。
// 守两件事：关闭时发给复核模型的 system 与修订反馈和改动前逐字节一致；开启时两个阶段与修订反馈都真的带上新口径。

/** 长度 + sha256：golden 只记摘要，不在测试里再抄一份提示词原文 */
const digest = (text: string) => `${text.length}:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
// 由改动前（HEAD 676ccb3）的 reviewAnswer 对下面同一组输入实际生成（env 未设、options 不传）。
// 提示词或修订纪律有意改动时，在改动前的提交上用同一输入重新生成，不要直接抄改动后的值。
const GOLDEN: Record<string, string> = {
  challenge: '770:d57a4f561415e064b570a7ad309abaf4b09c1b3eee34f3758e822ced09147b01',
  citations: '2034:ccf064667c9e0d93635fa65255bd41855b231b59a8cab93ff88adb99e2876190',
  revisionDiscipline: '292:e297af67b9faa4a75efda10d721beaa4bea9a77627d342125ce8d36155f21251',
};

// 现网同类案例的最小复现：截图里的文案只在代码某一分支输出，复核却以"无证据证明当时走的是该分支"打回。
const ATTACHMENT = '【附件 1：图片中的文字（模型逐字转写，以原图为准）】\n当前订单不支持在线退款';
const CODE = "118: const banner = order.refundClosed\n119:   ? '当前订单不支持在线退款'\n120:   : '可在线申请退款';";
const CODE_ARGS = { file_path: 'web/src/order/RefundBanner.vue', start: 118, end: 120 };
const tool = (id: string, name: string, content: string, args: Record<string, unknown>, completeness: 'complete' | 'unknown'): Message => ({ role: 'tool', name, tool_call_id: `call_${id}`, turnId: 't1', content,
  evidence: { id, observedAt: '2026-10-29T00:00:00.000Z', arguments: args, outcome: 'success', completeness } });
const history: Message[] = [
  { role: 'user', turnId: 't1', content: '客户截图顶部显示“当前订单不支持在线退款”，请说明为什么会显示这句' },
  { role: 'assistant', turnId: 't1', content: '', tool_calls: [{ id: 'call_e_att1', name: 'read_attachment', arguments: { index: 1 } }, { id: 'call_e_code1', name: 'read_file_lines', arguments: CODE_ARGS }] },
  tool('e_att1', 'read_attachment', ATTACHMENT, { index: 1 }, 'unknown'),
  tool('e_code1', 'read_file_lines', CODE, CODE_ARGS, 'complete'),
];
// 草稿里刻意不放"因为/导致/由于"这类成因标记词：定向补查不追加，反馈结尾只由修订纪律决定，不受 RULE_LAYER 影响
const draft: PublicDraft = { conclusion: '截图顶部显示“当前订单不支持在线退款”。这句文案只在订单已关闭退款的分支里输出。', businessData: [], evidenceSummary: [], customerReply: '', pendingItems: [] };
const candidate: Message = { role: 'assistant', turnId: 't1', content: JSON.stringify({ answer: draft, evidenceIds: ['e_att1', 'e_code1'] }) };
const BRANCH_DOUBT = '无证据证明当时走的是该分支';
const MECHANISM_DOUBT = '代码机制不能证明本次事件发生';
const reply = (value: unknown): Message => ({ role: 'assistant', finishReason: 'stop', content: JSON.stringify(value) });

/** 造假网关：深拷贝记录每次发给复核模型的 messages；反证阶段按 challengeIssues 点名，引文阶段把第 2 句判 uncertain */
function reviewer(challengeIssues: Array<{ blockId: string; reason: string }> = []) {
  const seen: Message[][] = [];
  const model = { streamChat: async (messages: Message[]) => {
    seen.push(structuredClone(messages));
    const packet = JSON.parse(messageText(messages[1]));
    if (packet.stage === 'challenge') return reply({ checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: challengeIssues });
    return reply({ privacySafe: true, missingEvidence: [], blocks: packet.blocks.map((b: any) => b.id === 'conclusion#0'
      ? { blockId: b.id, assessment: 'supported', kind: 'fact', references: [{ evidenceId: 'e_att1', quote: '当前订单不支持在线退款' }], reason: '截图转写原文' }
      : { blockId: b.id, assessment: 'uncertain', kind: 'inference', references: [], reason: BRANCH_DOUBT }) });
  } } as unknown as ChatGateway;
  return { model, seen };
}

/** 两条打回路径：引文阶段判 uncertain（两个阶段都走到）；反证阶段直接点名（只走 challenge，反馈从另一个返回分支出） */
const PATHS = {
  citations: { make: () => reviewer(), stages: ['challenge', 'citations'] },
  challenge: { make: () => reviewer([{ blockId: 'conclusion#1', reason: MECHANISM_DOUBT }]), stages: ['challenge'] },
};
async function run(pathName: keyof typeof PATHS, extra: { observedBranch?: boolean } = {}) {
  const { model, seen } = PATHS[pathName].make();
  const decision = await reviewAnswer(model, candidate, history, 1, 'trace', () => {}, { timeoutMs: 60000, ...extra });
  const stages = seen.map(messages => String(JSON.parse(messageText(messages[1])).stage));
  // 两个阶段都要真的走到，否则下面逐个阶段的比较会空转
  assert.deepEqual(stages, PATHS[pathName].stages, `${pathName}: 复核阶段与预期不符`);
  assert.equal(decision.accepted, false);
  return { stages, systems: seen.map(messages => String(messages[0].content)), feedback: String(decision.feedback), issues: (decision.record as any).issues as string[] };
}
type Run = Awaited<ReturnType<typeof run>>;

/** 测试进程里 env 是全局的：每个用例自己设定 REVIEW_OBSERVED_BRANCH，结束后还原 */
async function withEnv<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.REVIEW_OBSERVED_BRANCH;
  if (value === undefined) delete process.env.REVIEW_OBSERVED_BRANCH; else process.env.REVIEW_OBSERVED_BRANCH = value;
  try { return await fn(); }
  finally { if (saved === undefined) delete process.env.REVIEW_OBSERVED_BRANCH; else process.env.REVIEW_OBSERVED_BRANCH = saved; }
}

function assertOff(result: Run, label: string) {
  result.systems.forEach((system, i) => {
    const stage = result.stages[i];
    assert.ok(!system.includes('【材料原文可确认分支】'), `${label}: 关闭时 ${stage} 阶段 system 不得含新口径`);
    assert.equal(digest(system), GOLDEN[stage], `${label}: 关闭时 ${stage} 阶段 system 必须与改动前逐字节一致`);
  });
  assert.ok(result.feedback.endsWith(`\n${REVISION_DISCIPLINE}`), `${label}: 修订反馈应以原修订纪律结尾`);
  assert.ok(!result.feedback.includes('5. 例外'), `${label}: 关闭时修订反馈不得含第 5 条例外`);
  assert.equal(result.feedback, `${result.issues.join('\n')}\n${REVISION_DISCIPLINE}`, `${label}: 关闭时修订反馈与改动前的拼法逐字节一致`);
}

function assertOn(result: Run, label: string) {
  result.systems.forEach((system, i) => {
    const stage = result.stages[i];
    assert.ok(system.endsWith(`\n${OBSERVED_BRANCH_RULE}`), `${label}: 开启时 ${stage} 阶段 system 应以新口径结尾`);
    // 只在原提示末尾追加：去掉追加部分后必须仍是改动前的原提示
    assert.equal(digest(system.slice(0, -(OBSERVED_BRANCH_RULE.length + 1))), GOLDEN[stage], `${label}: ${stage} 阶段原提示本身不得改动`);
  });
  assert.ok(result.feedback.includes(OBSERVED_BRANCH_REVISION), `${label}: 开启时修订反馈应含第 5 条例外`);
  assert.equal(result.feedback, `${result.issues.join('\n')}\n${REVISION_DISCIPLINE}\n${OBSERVED_BRANCH_REVISION}`, `${label}: 第 5 条应紧接在原修订纪律第 4 条之后`);
}

test('REVIEW_OBSERVED_BRANCH 取值解析：只有 on/1/true（大小写不敏感、去空格）开启，其余（含未设置）一律关闭', async () => {
  for (const value of ['on', '1', 'true', 'ON', 'True', ' on ', '\ttrue\n', ' 1 ']) {
    assert.equal(observedBranchEnabled({ REVIEW_OBSERVED_BRANCH: value }), true, JSON.stringify(value));
  }
  for (const value of ['', ' ', 'off', '0', 'false', 'yes', 'enabled', 'onn', 'o n', '2', 'true1']) {
    assert.equal(observedBranchEnabled({ REVIEW_OBSERVED_BRANCH: value }), false, JSON.stringify(value));
  }
  assert.equal(observedBranchEnabled({}), false, '未设置时关闭');
  assert.equal(observedBranchEnabled({ RULE_LAYER: 'on' }), false, '只认 REVIEW_OBSERVED_BRANCH 这一个 env');
  // 缺省参数读 process.env（正式运行路径）
  await withEnv('on', () => assert.equal(observedBranchEnabled(), true));
  await withEnv(undefined, () => assert.equal(observedBranchEnabled(), false));
});

test('revisionDiscipline：关闭时就是原修订纪律，开启时只在第 4 条之后追加第 5 条例外', () => {
  assert.equal(digest(REVISION_DISCIPLINE), GOLDEN.revisionDiscipline, 'REVISION_DISCIPLINE 本身一个字都不能改');
  assert.equal(revisionDiscipline(false), REVISION_DISCIPLINE);
  assert.equal(revisionDiscipline(true), `${REVISION_DISCIPLINE}\n${OBSERVED_BRANCH_REVISION}`);
  assert.match(REVISION_DISCIPLINE.split('\n').at(-1)!, /^4\. /, '第 5 条接在第 4 条之后，编号才连续');
  assert.ok(OBSERVED_BRANCH_RULE.startsWith('【材料原文可确认分支】'));
  assert.ok(OBSERVED_BRANCH_REVISION.startsWith('5. 例外：材料原文'));
});

test('关闭（env 未设、options 不传）：两个阶段的 system 与改动前逐字节一致，修订反馈以原修订纪律结尾', async () => {
  await withEnv(undefined, async () => {
    assertOff(await run('citations'), '引文阶段打回');
    assertOff(await run('challenge'), '反证阶段打回');
  });
  // 显式 false 优先于 env：对照臂里 env 开着也能逐次关掉（?? 不能写成 ||）
  await withEnv('on', async () => assertOff(await run('citations', { observedBranch: false }), '显式关闭'));
});

test('开启（options.observedBranch=true）：两个阶段的 system 都以新口径结尾，修订反馈含第 5 条例外', async () => {
  await withEnv(undefined, async () => {
    assertOn(await run('citations', { observedBranch: true }), 'options 开启/引文阶段打回');
    assertOn(await run('challenge', { observedBranch: true }), 'options 开启/反证阶段打回');
  });
});

test('开启（env REVIEW_OBSERVED_BRANCH=on，options 不传）：与显式开启效果相同', async () => {
  await withEnv('on', async () => {
    assertOn(await run('citations'), 'env 开启/引文阶段打回');
    assertOn(await run('challenge'), 'env 开启/反证阶段打回');
  });
});

// review_jev.ts 一加载就会经 config.ts 读取 server/.env（还可能带进 REVIEW_OBSERVED_BRANCH），这里不 import 它，只核对源码接线；
// 关闭时输出不变由上面 revisionDiscipline(false) === REVISION_DISCIPLINE 保证。
test('review_jev：两处修订反馈都改走 revisionDiscipline(observedBranchEnabled())，不再直接拼 REVISION_DISCIPLINE', () => {
  const source = fs.readFileSync(new URL('../../server/src/agent/review_jev.ts', import.meta.url), 'utf8');
  assert.equal(source.split("+ '\\n' + revisionDiscipline(observedBranchEnabled())").length - 1, 2);
  assert.doesNotMatch(source, /\bREVISION_DISCIPLINE\b/);
});
