import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '@xkang/agent-core';
import { estimateTokens, messageText } from '@xkang/agent-core/context';
import { needsDirectedFollowup, reviewAnswer, reviewUnits, validateReview } from '../../server/src/agent/review.ts';
import type { PublicDraft } from '../../server/src/agent/publication.ts';

const draft: PublicDraft = { conclusion: '已为您查询该订单的收款状态。', businessData: [{ label: '联系电话', value: '0013812345678' }, { label: '证件号码', value: '11010119900101001X' }], evidenceSummary: [], customerReply: '', pendingItems: [] };
const evidence: Message = { role: 'tool', name: 'company_db_query', content: '联系电话：0013812345678；证件号码：11010119900101001X；已为您查询该订单的收款状态。已通知财务退回押金。', evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' } };
const candidate = (value = draft): Message => ({ role: 'assistant', content: JSON.stringify(value) });
const answer = (value: unknown): Message => ({ role: 'assistant', finishReason: 'stop', content: JSON.stringify(value) });
const report = (value = draft): any => ({ privacySafe: true, blocks: reviewUnits(value).map(unit => ({ blockId: unit.id, assessment: 'supported', kind: 'fact', references: [{ evidenceId: 'e1', quote: unit.text }], reason: '原文一致' })), missingEvidence: [] });
// 带截图时复核请求的 content 是数组（JSON 文本块 + 随附原图），messageText 只取文本块
const stageAnswer = (messages: Message[], verdict = report()) => {
  const packet = JSON.parse(messageText(messages[1]));
  return answer(packet.stage === 'challenge' ? { checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: [] } : verdict);
};

test('只读查询不再被动作记录误拦；声称写动作仍然拦截，且不再依赖复核模型自填的 kind', () => {
  // 只读查证事实：引文来自只读工具、原句未声称写操作 → 放行
  assert.deepEqual(validateReview(report(), draft, [evidence]), []);
  // 原句声称"已通知财务退回押金"：要求写动作执行记录（服务端必然拦截）
  const writeClaim: PublicDraft = { ...draft, conclusion: '已通知财务退回押金。' };
  const claimed = report(writeClaim);
  claimed.blocks[0].kind = 'performed_action';
  assert.ok(validateReview(claimed, writeClaim, [evidence]).some(issue => issue.includes('没有动作执行记录')));
  // 引文来自既非只读集合也非动作工具的通道：同样拦截。
  // 这类证据既不能证明"做过"，也不能证明"改好"，hasActionRecord 直接返回 false，
  // 但原句没有完成态声明时只有 kind=performed_action 才会记 issue——所以这里把 kind 也置上。
  const unknown = report();
  unknown.blocks[0].kind = 'performed_action';
  assert.ok(validateReview(unknown, draft, [{ ...evidence, name: 'web_search' } as Message]).some(issue => issue.includes('没有动作执行记录')));
  // 现网 2026-10-17：复核把"研发已进行修复"整句标成 kind='fact'，旧逻辑因此跳过动作检查。
  // 445 条断言里 0 条填过 performed_action，说明按 kind 判等这道检查从未生效。
  // 完成态声明改为无条件检查：只读工具能证明"做了什么"，不能证明"已经改好"。
  const repaired: PublicDraft = { ...draft, conclusion: '相关技术问题研发已进行修复。' };
  const asFact = report(repaired);
  asFact.blocks[0].kind = 'fact';
  assert.ok(validateReview(asFact, repaired, [evidence]).some(issue => issue.includes('没有上线证据')));
  // 边界：数据描述里的"已退款 303 元"是有库记录的业务事实，kind=fact 时必须放行（2026-10-20 R6 回放确认）。
  // 它不触发动作检查，只走普通引文核对，所以这里的证据要真的包含这句话。
  const refunded: PublicDraft = { ...draft, conclusion: '退订1晚，已退款303.00元。' };
  // 保留原证据正文（数据块也要能对上），只在末尾追加这句业务事实
  const refundEvidence: Message = { ...evidence, content: `${evidence.content} 退订1晚，已退款303.00元。` };
  assert.deepEqual(validateReview(report(refunded), refunded, [refundEvidence]), []);
});

test('角色称谓在证据里无出处时按"缺少证据"记入复核意见；非事实块与引文自带的情形都不记', () => {
  const roleDraft: PublicDraft = { ...draft, conclusion: '财务已退回押金。' };
  const claimed = report(roleDraft);
  claimed.blocks[0].references = [{ evidenceId: 'e1', quote: '"fpstatus",4' }];
  assert.ok(validateReview(claimed, roleDraft, [evidence]).some(issue => issue.includes('角色称谓缺少证据')));
  // 非事实块（纯建议/资料请求）不参与事实支持判定
  claimed.blocks[0].assessment = 'non_factual'; claimed.blocks[0].kind = 'advice'; claimed.blocks[0].references = [];
  assert.ok(!validateReview(claimed, roleDraft, [evidence]).some(issue => issue.includes('角色称谓缺少证据')));
  // 引文里逐字含该称谓 → 算有出处
  claimed.blocks[0].assessment = 'supported'; claimed.blocks[0].kind = 'fact'; claimed.blocks[0].references = [{ evidenceId: 'e1', quote: '财务已退回押金。' }];
  assert.ok(!validateReview(claimed, roleDraft, [evidence]).some(issue => issue.includes('角色称谓缺少证据')));
});

test('复核材料剥离截图 base64，估算 token 不随图片大小增长', async () => {
  const png = (sizeKb: number) => {
    const header = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(4), Buffer.alloc(4)]);
    return `data:image/png;base64,${Buffer.concat([header, Buffer.alloc(sizeKb * 1024, 0x41)]).toString('base64')}`;
  };
  const seen: number[] = [];
  for (const kb of [50, 2000]) {
    const result = await reviewAnswer({ streamChat: async (messages: Message[]) => {
      if (JSON.parse(messageText(messages[1])).stage === 'citations') seen.push(estimateTokens(messages));
      return stageAnswer(messages);
    } } as any, candidate(), [{ role: 'user', content: [{ type: 'text', text: '看截图' }, { type: 'image_url', image_url: { url: png(kb) } }] }, evidence], 1, 'trace', () => {}, { timeoutMs: 60000 });
    assert.equal(result.accepted, true);
  }
  assert.equal(seen.length, 2);
  assert.ok(seen[1] - seen[0] < 100, `token 消耗应接近常数: ${seen[0]} vs ${seen[1]}`);
});

test('reviewAnswer 不传 timeoutMs 时抛错（不再有静默默认值）', async () => {
  await assert.rejects((reviewAnswer as any)({ streamChat: async () => ({ role: 'assistant', content: 'x' }) }, candidate(), [evidence], 1, 'trace', () => {}), /timeoutMs/);
});

test('格式失败的回送包含字段路径，不回灌模型响应原文', async () => {
  const malformed = report(); malformed.blocks[0].assessment = 'not_a_verdict';
  let calls = 0;
  const model: any = { streamChat: async (messages: Message[]) => {
    calls++;
    if (calls === 1) return stageAnswer(messages);
    if (calls === 2) return answer(malformed);
    assert.match(String(messages[0].content), /blocks\.0\.assessment/);
    assert.doesNotMatch(JSON.stringify(messages), /not_a_verdict/);
    return stageAnswer(messages);
  } };
  const result = await reviewAnswer(model, candidate(), [evidence], 1, 'trace', () => {}, { timeoutMs: 60000 });
  assert.equal(calls, 3); assert.equal(result.accepted, true);
});

test('定向补查的触发条件：只有成因类断言没过核实才为真', () => {
  const units = [{ id: '1', text: '两张发票金额相同。' }, { id: '2', text: '该记录由操作人相隔 12 秒连续提交产生。' }];
  const supported = { privacySafe: true, blocks: [{ blockId: '2', assessment: 'supported', kind: 'fact', references: [], reason: '' }], missingEvidence: [] } as any;
  const uncertain = { privacySafe: true, blocks: [{ blockId: '2', assessment: 'uncertain', kind: 'fact', references: [], reason: '' }], missingEvidence: [] } as any;
  // 没有成因类断言：任何情况下都不补查
  assert.equal(needsDirectedFollowup([units[0]]), false);
  assert.equal(needsDirectedFollowup([units[0]], { report: uncertain }), false);
  // 反证阶段还没有报告：草稿里有成因句就先补查（宁可多查一次，也不让"写成未定位"成为捷径）
  assert.equal(needsDirectedFollowup(units, { disputed: new Set(['1']) }), true);
  // 有报告：成因句未被支持 → 补查；已被支持 → 不补
  assert.equal(needsDirectedFollowup(units, { report: uncertain }), true);
  assert.equal(needsDirectedFollowup(units, { report: supported }), false);
  // 被反证点名：即使报告判 supported 也补查
  assert.equal(needsDirectedFollowup(units, { report: supported, disputed: new Set(['2']) }), true);
});

const causeReason = '只证明了结果的时间与数值，没有说明该机制的日志或代码分支';
const challengeAll = (messages: Message[]) => {
  const packet = JSON.parse(String(messages[1].content));
  return answer({ checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: packet.blocks.map((b: any) => ({ blockId: b.id, reason: causeReason })) });
};

test('定向补查：成因类断言被点名时修订反馈带上通用补查步骤，非成因草稿不带', async () => {
  const causeDraft: PublicDraft = { conclusion: '两张金额相同的发票由操作人相隔 12 秒连续提交产生。', businessData: [], evidenceSummary: [], customerReply: '', pendingItems: [] };
  const causeEvidence: Message = { role: 'tool', name: 'company_db_query', content: causeDraft.conclusion, evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' } };
  const causeResult = await reviewAnswer({ streamChat: async (messages: Message[]) => challengeAll(messages) } as any, candidate(causeDraft), [causeEvidence], 1, 'trace', () => {}, { timeoutMs: 60000 });
  assert.equal(causeResult.accepted, false);
  const feedback = String(causeResult.feedback);
  assert.match(feedback, /【定向补查】/);
  assert.match(feedback, /去重或幂等判断的分支/);
  assert.match(feedback, /循环内还是循环外/);
  assert.match(feedback, /【修订纪律】/, '定向补查不能顶掉原有修订纪律');

  // 同一份证据、草稿里没有成因类断言：只给修订纪律，不塞补查步骤
  const plainResult = await reviewAnswer({ streamChat: async (messages: Message[]) => challengeAll(messages) } as any, candidate(), [evidence], 1, 'trace', () => {}, { timeoutMs: 60000 });
  assert.equal(plainResult.accepted, false);
  const plainFeedback = String(plainResult.feedback);
  assert.match(plainFeedback, /【修订纪律】/);
  assert.doesNotMatch(plainFeedback, /【定向补查】/);
});

test('G3③ 消融开关：ruleLayer:false 时不追加定向补查，修订纪律仍在；显式 true 仍追加', async () => {
  const causeDraft: PublicDraft = { conclusion: '两张金额相同的发票由操作人相隔 12 秒连续提交产生。', businessData: [], evidenceSummary: [], customerReply: '', pendingItems: [] };
  const causeEvidence: Message = { role: 'tool', name: 'company_db_query', content: causeDraft.conclusion, evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' } };
  const run = (ruleLayer?: boolean) => reviewAnswer(
    { streamChat: async (messages: Message[]) => challengeAll(messages) } as any,
    candidate(causeDraft), [causeEvidence], 1, 'trace', () => {}, { timeoutMs: 60000, ...(ruleLayer === undefined ? {} : { ruleLayer }) });
  const off = await run(false);
  const offFeedback = String(off.feedback);
  assert.match(offFeedback, /【修订纪律】/, '关掉开关只该去掉补查步骤，修订纪律必须还在');
  assert.doesNotMatch(offFeedback, /【定向补查】/);
  // 同一输入在开关开启时必须带补查步骤：否则上面的 doesNotMatch 可能是因为「本来就没追加」而假通过
  assert.match(String((await run(true)).feedback), /【定向补查】/);
  // 显式参数缺省时读 env（正式运行路径）：默认开启
  const saved = process.env.RULE_LAYER;
  try {
    assert.match(String((await run()).feedback), /【定向补查】/, '未设 RULE_LAYER 时应为开启');
    process.env.RULE_LAYER = 'off';
    assert.match(String((await run()).feedback), /【修订纪律】/);
    assert.doesNotMatch(String((await run()).feedback), /【定向补查】/, 'RULE_LAYER=off 时应关闭');
  } finally {
    if (saved === undefined) delete process.env.RULE_LAYER; else process.env.RULE_LAYER = saved;
  }
});
