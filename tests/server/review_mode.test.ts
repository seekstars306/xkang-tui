import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import type { ReviewDecision } from '@xkang/agent-core';
import { loadServerConfig } from '../../server/src/config.ts';
import { reviewMode, validateReviewMode } from '../../server/src/agent/review_mode.ts';
import { advisoryAnswer, draftFields, parseDraft, reviewIssueItems, ADVISORY_ISSUE_LIMIT } from '../../server/src/agent/draft_publication.ts';
import { unavailableAnswer } from '../../server/src/agent/publication.ts';
import { DRAFT_1, DRAFT_2, REJECTED, runScenario, SCENARIOS, withEnv, type DraftText, type ScenarioName, type ScenarioRun } from '../helpers/review_mode_fixture.ts';

// 复核模式开关 REVIEW_MODE（server/src/agent/review_mode.ts）的防倒退测试。
// 全部走真实拼装链路 AgentService.start → AgentCore → reviewAnswer → 最终解析与发布（夹具见 tests/helpers/review_mode_fixture.ts），
// 所以 service 里"advisory 传 publishLastDraft""off 不传 review"任何一处接线被删，这里都会变红。

/**
 * gate 的 golden：由改动前（HEAD 4d733a1）的代码对 SCENARIOS 同一组输入实际生成（REVIEW_MODE 未设置）。
 * 四部分分别是：发给排查模型的全部请求、发给复核模型的全部请求、公开事件、公开答案（随机编号与时间戳已归一，见 digestsOf）。
 * 有意改动提示词、复核或发布逻辑时，在改动前的提交上用同一输入重新生成，不要直接抄改动后的值。
 */
const GOLDEN: Record<ScenarioName, { main: string; reviews: string; events: string; answer: string }> = {
  rejectTwice: {
    main: '21950:288f0f02b96d0bb2182cf38955dab272969bdbe4b890b1ac6fc9a61d4ba16c45',
    reviews: '14175:1fad10e01f1de6df784cb3aa86a37297822ec7062536b059eb597abe72679abc',
    events: '520:5185bff9fff07b6c4e06d56f2ad281c586c34288d8c6b100331ac0ab23e50ecd',
    answer: '338:6aff260a77240ceb131ca274e3e97aff8106fd8cb3a73666fd199f42cd75ebde',
  },
  rejectTwicePartial: {
    main: '21982:6a6a38aef188979836ff1eb48817b7348d644706c93132a22597ef6a2b1394ee',
    reviews: '14175:1fad10e01f1de6df784cb3aa86a37297822ec7062536b059eb597abe72679abc',
    events: '1213:eac7970bd0e6de54965dc7577b4fc3cc5d2bae45747112d57fc6970d2e3ea1e0',
    answer: '1031:cec6bf01af08ae2085e35429728ac09889e2f7e423340a79a72737b812accb6a',
  },
  pass: {
    main: '13529:c322366f59a3db3758e8a0a4785097c5e8ae85ad1502521e47c01a28d575ed31',
    reviews: '6962:d6bfc232bfcb7b69bc6d0ad80dee4d66d10b077891618d836b9a7e6e38580308',
    events: '525:45dfe4c9c538c0f621930df26ff26e94209a7b134558e46f7c3b808d3e732b0c',
    answer: '382:431b5235a5aeaed6e032726604ec4f0f66f3759cc5a96bc0efbf3e42949abf23',
  },
  reviewDown: {
    main: '13529:c322366f59a3db3758e8a0a4785097c5e8ae85ad1502521e47c01a28d575ed31',
    reviews: '2829:98f80ca5f54b8b6bdf593498c5b9bb3547cd6d5ca539ab1c7c7a9d5904145406',
    events: '341:1039dc3d82e2617512f221482a08ce67c53758213b50fb7b7cd65a017f494120',
    answer: '198:5c1f9a4d38c3a2f2f92bbaa90f5be6176ae7bf1d1d8c3da115a8993a91968b6d',
  },
  reviewThrows: {
    main: '13529:c322366f59a3db3758e8a0a4785097c5e8ae85ad1502521e47c01a28d575ed31',
    reviews: '2:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    events: '341:1039dc3d82e2617512f221482a08ce67c53758213b50fb7b7cd65a017f494120',
    answer: '198:5c1f9a4d38c3a2f2f92bbaa90f5be6176ae7bf1d1d8c3da115a8993a91968b6d',
  },
};
const NAMES = Object.keys(SCENARIOS) as ScenarioName[];
const UNAVAILABLE_CONCLUSION = unavailableAnswer('t').conclusion;
/** 事件的形状（不含答案内容）：复核照常跑时，advisory 的进度事件与 gate 一致 */
const eventShape = (run: ScenarioRun) => run.events.map(event => (event.type === 'progress' ? event.phase : event.type));
const draftOf = (run: ScenarioRun) => ({ conclusion: run.answer.conclusion, businessData: run.answer.businessData, evidenceSummary: run.answer.evidenceSummary, customerReply: run.answer.customerReply });
const REASON_SUFFIX = /（(?:证据不足|复核反证阶段提出异议|引文未通过自动核对，需人工确认)）$/;
const INTERNAL_ID = /conclusion|customerReply|data:|evidence:|pending:|#\d|e_[0-9a-f]{8}/;

test('REVIEW_MODE 取值：未设置/空串为 gate，大小写与空格不敏感；写错时运行期按 gate、启动校验直接报错', async () => {
  assert.equal(reviewMode({}), 'gate');
  for (const [value, mode] of [['', 'gate'], [' ', 'gate'], ['gate', 'gate'], ['GATE', 'gate'], ['advisory', 'advisory'], [' Advisory ', 'advisory'], ['off', 'off'], ['OFF\n', 'off']] as const) {
    assert.equal(reviewMode({ REVIEW_MODE: value }), mode, JSON.stringify(value));
    assert.equal(validateReviewMode({ REVIEW_MODE: value }), mode, JSON.stringify(value));
  }
  for (const value of ['advisroy', 'on', 'true', '0', 'none']) {
    assert.equal(reviewMode({ REVIEW_MODE: value }), 'gate', `运行期不在请求中途抛错：${value}`);
    assert.throws(() => validateReviewMode({ REVIEW_MODE: value }), /REVIEW_MODE 只能是 gate、advisory 或 off/);
  }
  // 缺省参数读 process.env（正式运行路径）；loadServerConfig 启动时校验
  await withEnv({ REVIEW_MODE: 'advisory' }, () => { assert.equal(reviewMode(), 'advisory'); loadServerConfig(); });
  await withEnv({ REVIEW_MODE: undefined }, () => assert.equal(reviewMode(), 'gate'));
  await withEnv({ REVIEW_MODE: 'advisroy' }, () => assert.throws(() => loadServerConfig(), /REVIEW_MODE 只能是 gate、advisory 或 off，当前值：advisroy/));
});

test('gate（未设置 REVIEW_MODE 与显式 gate）：五个场景发给两个模型的内容、事件、发布结果与改动前逐字节一致', async () => {
  for (const name of NAMES) {
    for (const mode of [undefined, 'gate', ' GATE ']) {
      const run = await runScenario(mode, SCENARIOS[name]);
      assert.deepEqual(run.digests, GOLDEN[name], `${name} / REVIEW_MODE=${JSON.stringify(mode)}`);
    }
  }
  // 可读的对照：两轮都打回时 gate 发布的正是"结论只剩其余事项仍需核实"的裁剪稿
  const trimmed = await runScenario(undefined, SCENARIOS.rejectTwice);
  assert.equal(trimmed.answer.conclusion, '已取得部分业务信息，其余事项仍需核实。');
  const partial = await runScenario(undefined, SCENARIOS.rejectTwicePartial);
  assert.ok(partial.answer.pendingItems.some(item => REASON_SUFFIX.test(item)), 'gate 部分发布会把句子挪进待确认');
});

test('advisory：复核两轮都打回时发布最后一稿的完整内容（原句都在、不挪进待确认），待确认追加精简后的复核问题', async () => {
  const expected = {
    rejectTwice: ['复核提示（结论第2句）：证据只显示收款两次，未直接说明重复收款的原因。', '复核提示（客服话术）：证据没有退款到账的记录。'],
    // 同一句反证与引文阶段都有问题时只取第一条（反证阶段在前）
    rejectTwicePartial: ['复核提示（结论第2句）：无证据说明重复收款由支付回调导致。', '复核提示（客服话术）：证据没有退款到账的记录。'],
  };
  for (const name of ['rejectTwice', 'rejectTwicePartial'] as const) {
    const run = await runScenario('advisory', SCENARIOS[name]);
    // 复核照常运行、照常打回修订：发给排查模型与复核模型的内容和 gate 逐字节一致，进度事件也一致
    assert.equal(run.digests.main, GOLDEN[name].main, `${name}: 发给排查模型的内容（含修订反馈）应与 gate 一致`);
    assert.equal(run.digests.reviews, GOLDEN[name].reviews, `${name}: 发给复核模型的内容应与 gate 一致`);
    assert.equal(run.reviews.length, 4, '两轮复核、每轮两个阶段都跑了');
    assert.match(JSON.stringify(run.main[2].messages), /以下是复核发现的问题/, '第一轮打回后照常请模型修订');
    assert.deepEqual(eventShape(run), ['checking', 'reviewing', 'revising', 'answer', 'done']);
    // 发布的是最后一稿（修订稿）的完整内容
    assert.deepEqual(draftOf(run), { conclusion: DRAFT_2.conclusion, businessData: DRAFT_2.businessData, evidenceSummary: DRAFT_2.evidenceSummary, customerReply: DRAFT_2.customerReply });
    assert.ok(run.answer.conclusion.includes('重复收款与支付回调被重复处理有关。'), '被复核点名的成因句仍留在结论里');
    assert.notEqual(run.answer.conclusion, DRAFT_1.conclusion, '不是初稿');
    assert.deepEqual(run.answer.pendingItems.slice(0, DRAFT_2.pendingItems.length), DRAFT_2.pendingItems, '草稿自己的待确认原样保留在前');
    const extra = run.answer.pendingItems.slice(DRAFT_2.pendingItems.length);
    assert.deepEqual(extra, expected[name]);
    assert.ok(extra.length >= 1 && extra.length <= ADVISORY_ISSUE_LIMIT);
    for (const item of extra) assert.doesNotMatch(item, INTERNAL_ID, `不带内部编号：${item}`);
    assert.ok(!run.answer.pendingItems.some(item => REASON_SUFFIX.test(item)), '没有把句子挪进待确认');
    assert.equal(run.answer.reviewStatus, 'needs_human');
    assert.equal(run.answer.claims, undefined, '不附逐句裁决');
  }
});

test('advisory：复核通过时与 gate 逐字节一致', async () => {
  const run = await runScenario('advisory', SCENARIOS.pass);
  assert.deepEqual(run.digests, GOLDEN.pass);
  assert.equal(run.answer.reviewStatus, 'reviewed');
});

test('advisory：复核服务不可用（复核模型失败 / 复核函数抛错）时发布草稿的完整内容', async () => {
  for (const name of ['reviewDown', 'reviewThrows'] as const) {
    const run = await runScenario('advisory', SCENARIOS[name]);
    assert.equal(run.digests.main, GOLDEN[name].main, `${name}: 排查过程与 gate 一致`);
    assert.equal(run.digests.reviews, GOLDEN[name].reviews, `${name}: 复核调用与 gate 一致`);
    assert.deepEqual({ ...draftOf(run), pendingItems: run.answer.pendingItems }, { conclusion: DRAFT_1.conclusion, businessData: DRAFT_1.businessData, evidenceSummary: DRAFT_1.evidenceSummary, customerReply: DRAFT_1.customerReply, pendingItems: DRAFT_1.pendingItems }, `${name}: 复核没给出结论，不追加问题`);
    assert.equal(run.answer.reviewStatus, 'needs_human');
  }
});

test('advisory：隐私否决不放宽——最后一轮复核判定含开发内部信息时按 gate 发布', async () => {
  const options = { review: { kind: 'judge' as const, rejected: REJECTED, privacySafe: false } };
  const gate = await runScenario(undefined, options);
  const advisory = await runScenario('advisory', options);
  assert.equal(gate.answer.conclusion, UNAVAILABLE_CONCLUSION);
  assert.deepEqual(advisory.digests, gate.digests);
});

test('advisory：复核理由逐条过发布校验，含内部标识的理由不追加，其余照常追加', async () => {
  const run = await runScenario('advisory', { review: { kind: 'judge', rejected: {
    'conclusion#1': { assessment: 'uncertain', reason: 'refund_amount 只说明金额，不说明原因' },
    'customerReply#0': { assessment: 'unsupported', reason: '证据没有退款到账的记录' },
  } } });
  assert.deepEqual(draftOf(run).conclusion, DRAFT_2.conclusion);
  assert.deepEqual(run.answer.pendingItems.slice(DRAFT_2.pendingItems.length), ['复核提示（客服话术）：证据没有退款到账的记录。']);
  assert.doesNotMatch(JSON.stringify(run.answer), /refund_amount/);
});

/** off 下草稿的几种形态（第一稿即发布） */
const offShapes: Record<string, DraftText> = {
  envelope: evidenceId => JSON.stringify({ answer: DRAFT_1, evidenceIds: [evidenceId] }),
  flat: () => JSON.stringify(DRAFT_1),
  fenced: evidenceId => '```json\n' + JSON.stringify({ answer: DRAFT_1, evidenceIds: [evidenceId] }, null, 2) + '\n```',
  fencedFlatNoLang: () => '```\n' + JSON.stringify(DRAFT_1) + '\n```',
  proseAroundFence: evidenceId => '以下是最终答案：\n```json\n' + JSON.stringify({ answer: DRAFT_1, evidenceIds: [evidenceId] }) + '\n```\n请查收。',
};

test('off：不挂复核、不调用复核模型；包装、平铺、代码块几种形态都按草稿原样发布', async () => {
  for (const [shape, drafts] of Object.entries(offShapes)) {
    // 复核脚本给的是"会打回"：一旦误挂复核，复核调用数与发布结果都会变
    const run = await runScenario('off', { review: { kind: 'judge', rejected: REJECTED }, drafts });
    assert.equal(run.reviews.length, 0, `${shape}: 不得调用复核模型`);
    assert.equal(run.main.length, 2, `${shape}: 一次查询 + 一次出稿`);
    // off 只挂一道发布格式检查（见 service.reviewWiring），内核照常发一次 reviewing 进度事件；不调用复核模型
    assert.deepEqual(eventShape(run), ['checking', 'reviewing', 'answer', 'done'], `${shape}: 只有一次格式检查`);
    assert.deepEqual({ ...draftOf(run), pendingItems: run.answer.pendingItems }, DRAFT_1, `${shape}: 草稿五个字段原样发布`);
    assert.equal(run.answer.reviewStatus, 'needs_human', shape);
    assert.equal(run.answer.claims, undefined, shape);
    assert.doesNotMatch(JSON.stringify(run.answer), /evidenceIds|e_[0-9a-f]{8}/, `${shape}: 内部证据编号不进公开答案`);
  }
});

test('off：解析不了才走现有兜底；发布校验（内部标识、业务字段中文名）照常执行', async () => {
  const fallbackCases: Record<string, DraftText> = {
    prose: () => '订单1530517490084478976共收款两次，已退款81.43元。',
    internalIdentifier: evidenceId => JSON.stringify({ answer: { ...DRAFT_1, evidenceSummary: ['refund_amount 字段显示已退款81.43元。'] }, evidenceIds: [evidenceId] }),
    sourcePath: () => JSON.stringify({ ...DRAFT_1, evidenceSummary: ['RefundService.java:120 处理了重复回调。'] }),
    englishLabel: () => JSON.stringify({ ...DRAFT_1, businessData: [{ label: 'refund', value: '81.43元' }] }),
  };
  for (const [name, drafts] of Object.entries(fallbackCases)) {
    const run = await runScenario('off', { review: { kind: 'judge' }, drafts });
    assert.equal(run.reviews.length, 0, name);
    assert.equal(run.answer.conclusion, UNAVAILABLE_CONCLUSION, `${name}: 走现有兜底`);
    assert.deepEqual(run.answer.pendingItems, unavailableAnswer('t').pendingItems, name);
    assert.doesNotMatch(JSON.stringify(run.answer), /refund_amount|RefundService/, name);
  }
});

test('off：草稿 JSON 写坏时只退回一次格式修正（不审内容、不调用复核模型），修好后发布修正稿', async () => {
  // 2026-10-29 实测形态：字符串字段用 "] 收尾，JSON 解析失败
  const broken = (evidenceId: string) => JSON.stringify({ answer: DRAFT_1, evidenceIds: [evidenceId] }).replace(/"customerReply":"([^"]*)"/, '"customerReply":"$1"]');
  const drafts: DraftText = (evidenceId, round) => (round === 1 ? broken(evidenceId) : JSON.stringify({ answer: DRAFT_1, evidenceIds: [evidenceId] }));
  assert.throws(() => JSON.parse(broken('e1')), '测试前提：第一稿确实不是合法 JSON');
  const run = await runScenario('off', { review: { kind: 'judge', rejected: REJECTED }, drafts });
  assert.equal(run.reviews.length, 0, '不得调用复核模型');
  assert.deepEqual({ ...draftOf(run), pendingItems: run.answer.pendingItems }, DRAFT_1, '发布的是修正后的草稿，内容原样');
  const lastCall = run.main.at(-1)!.messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  assert.match(lastCall, /只改格式/, '格式错误被退回给模型');
  // 退回意见必须讲清结构和键名：2026-10-30 只说"请输出 JSON"时，第二稿改用中文键名仍被作废
  for (const k of ['"conclusion"', '"businessData"', '"evidenceSummary"', '"customerReply"', '"pendingItems"', '中文键名', '代码围栏']) assert.ok(lastCall.includes(k), '退回意见缺少：' + k);
});

test('草稿解析：三种形态取出五个字段，缺省项补空、内部字段丢弃、号码不做数字转换', () => {
  const terms = new Set<string>();
  for (const text of [JSON.stringify({ answer: DRAFT_1, evidenceIds: ['e1'] }), JSON.stringify(DRAFT_1), '```json\n' + JSON.stringify(DRAFT_1) + '\n```', '说明：\n```json\n' + JSON.stringify({ answer: DRAFT_1 }) + '\n```']) {
    assert.deepEqual(parseDraft(text, terms), DRAFT_1);
  }
  assert.deepEqual(draftFields(JSON.stringify({ answer: { conclusion: '只有结论。' }, evidenceIds: [] })), { conclusion: '只有结论。', businessData: [], evidenceSummary: [], customerReply: '', pendingItems: [] });
  assert.deepEqual(parseDraft(JSON.stringify({ ...DRAFT_1, evidenceIds: ['e1'], reviewStatus: 'reviewed', businessData: [{ label: '订单号', value: '1530517490084478976', source: 'e1' }] }), terms).businessData, [{ label: '订单号', value: '1530517490084478976' }]);
  assert.throws(() => parseDraft('{"conclusion":"x","businessData":[{"label":"订单号","value":1530517490084478976}]}', terms), '数字形态的号码不能被改写成字符串放行');
  assert.throws(() => parseDraft(JSON.stringify({ answer: { businessData: [] } }), terms), '没有结论');
  assert.throws(() => draftFields('订单已退款。'), '找不到 JSON 对象');
});

test('复核问题精简：每条一句、最多 5 条、去掉内部编号，只取落到语句的问题与缺失证据', () => {
  const draft = parseDraft(JSON.stringify(DRAFT_2), new Set());
  const decision = (issues: string[], extra: Record<string, unknown> = {}): ReviewDecision => ({ accepted: false, retry: true, text: '', record: { status: 'needs_revision', issues, ...extra } });
  const items = reviewIssueItems(draft, decision([
    'conclusion#1: 与 data:2#0 不一致；另需核对 e_0123abcd-0123-4567-89ab-0123456789ab 的原文',
    'conclusion#1: 引用无效',
    'data:1#0: 引用无效',
    'evidence:0#0: 缺少引文',
    '复核没有完整覆盖正文',
    'customerReply#0: payOrder 未返回到账时间',
    'pending:1#0: 事实没有证据',
    'evidence:1#0: 证据只给出金额',
    '缺少支付渠道的退款回执',
  ], { report: { missingEvidence: ['缺少支付渠道的退款回执'] } }), new Set());
  assert.deepEqual(items, [
    '复核提示（结论第2句）：与 业务信息「退款金额」 不一致。',
    '复核提示（业务信息「收款次数」）：引文未通过自动核对。',
    '复核提示（依据第1条）：证据不足。',
    '复核提示（待确认第2条）：证据不足。',
    '复核提示（依据第2条）：证据只给出金额。',
  ]);
  assert.equal(items.length, ADVISORY_ISSUE_LIMIT);
  // 复核没跑完 / 只回了正文 / 没有决定：不追加
  assert.deepEqual(reviewIssueItems(draft, decision(['conclusion#0: x'], { status: 'unavailable' }), new Set()), []);
  assert.deepEqual(reviewIssueItems(draft, decision(['## 复核报告 conclusion#0 有问题'], { unstructured: true }), new Set()), []);
  assert.deepEqual(reviewIssueItems(draft, undefined, new Set()), []);
  // 超长理由截断，不再加句号；命中私有词表的整条丢弃
  const long = reviewIssueItems(draft, decision([`conclusion#0: ${'很长的理由'.repeat(20)}`, 'evidence:0#0: billing 库里没有该记录']), new Set(['billing']));
  assert.equal(long.length, 1);
  assert.ok(long[0].endsWith('…') && long[0].length <= '复核提示（结论第1句）：'.length + 61);
  // advisory 拼装：草稿原样、问题追加在后、印章 needs_human；没过发布校验的草稿返回 undefined 交回 gate
  const answer = advisoryAnswer(JSON.stringify({ answer: DRAFT_2, evidenceIds: ['e1'] }), decision(['customerReply#0: 证据没有退款到账的记录']), new Set(), 'r_trace')!;
  assert.deepEqual(answer, { ...DRAFT_2, pendingItems: [...DRAFT_2.pendingItems, '复核提示（客服话术）：证据没有退款到账的记录。'], reviewStatus: 'needs_human', traceId: 'r_trace' });
  assert.equal(advisoryAnswer('纯文本草稿', undefined, new Set(), 'r_trace'), undefined);
  assert.equal(advisoryAnswer(JSON.stringify(DRAFT_2), decision([], { report: { privacySafe: false } }), new Set(), 'r_trace'), undefined);
});

// continue()（冻结续查）没有独立场景夹具，这里核对它与 start() 走同一套接线与解析，避免只改了一处
test('service：start 与 continue 都按 REVIEW_MODE 接线复核、按模式解析最终文本', () => {
  const source = fs.readFileSync(new URL('../../server/src/agent/service.ts', import.meta.url), 'utf8');
  assert.equal(source.split('...this.reviewWiring(mode, (candidate, history, attempt) => this.runReview(').length - 1, 2);
  assert.equal(source.split("const parsed = mode === 'off' ? { ...draftFields(result), reviewStatus: 'needs_human' } : JSON.parse(result);").length - 1, 2);
  assert.equal(source.split('const mode = reviewMode();').length - 1, 2);
  assert.doesNotMatch(source, /\breview: \(candidate, history, attempt\) =>/, '不再绕过 reviewWiring 直接传 review');
});
