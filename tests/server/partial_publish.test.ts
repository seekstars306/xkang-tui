import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '@xkang/agent-core';
import { hasUnsupportedActorRole, reviewAnswer, reviewUnits } from '../../server/src/agent/review.ts';
import { PARTIAL_REPLY_SUFFIX, PARTIAL_REPLY_TEMPLATE, type PublicDraft } from '../../server/src/agent/publication.ts';

const draft: PublicDraft = { conclusion: '资料已有记录。', businessData: [{ label: '联系电话', value: '0013812345678' }, { label: '证件号码', value: '11010119900101001X' }], evidenceSummary: [], customerReply: '', pendingItems: [] };
const evidence: Message = { role: 'tool', name: 'company_db_query', content: '资料已有记录。联系电话：0013812345678；证件号码：11010119900101001X', evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' } };
const candidate = (value = draft): Message => ({ role: 'assistant', content: JSON.stringify(value) });
const answer = (value: unknown): Message => ({ role: 'assistant', finishReason: 'stop', content: JSON.stringify(value) });

/** 造假模型：challenge 阶段可按配置点名，citations 阶段可按配置把某块判为 unsupported */
function fakeModel(opts: { challengeIssue?: string; unsupportedBlock?: string; badQuoteBlock?: string } = {}) {
  return {
    streamChat: async (messages: Message[]) => {
      const packet = JSON.parse(String(messages[1].content));
      if (packet.stage === 'challenge') {
        const blocks = packet.blocks.map((b: any) => b.id);
        return answer({ checkedUnitIds: blocks, issues: opts.challengeIssue ? [{ blockId: opts.challengeIssue, reason: '执行条件缺少依据' }] : [] });
      }
      return answer({
        privacySafe: true,
        blocks: packet.blocks.map((b: any) => b.id === opts.unsupportedBlock
          ? { blockId: b.id, assessment: 'unsupported', kind: 'fact', references: [], reason: '缺乏依据' }
          : { blockId: b.id, assessment: 'supported', kind: 'fact', references: [{ evidenceId: 'e1', quote: b.id === opts.badQuoteBlock ? '这段原文并不存在' : b.text }], reason: '原文一致' }),
        missingEvidence: [],
      });
    },
  } as any;
}
const claimsOf = (text: string) => JSON.parse(text).claims as Array<{ text: string; status: string; reason?: string; evidenceRefs?: string[] }> | undefined;

test('R1：两阶段全过——开启部分发布时全部断言 confirmed 并带 evidenceRefs', async () => {
  const result = await reviewAnswer(fakeModel(), candidate(), [evidence], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  assert.equal(result.accepted, true);
  const claims = claimsOf(result.text)!;
  assert.equal(claims.length, reviewUnits(draft).length);
  assert.ok(claims.every(c => c.status === 'confirmed' && c.evidenceRefs?.includes('e1')));
});

test('R1：反证点名某条——该条一律 pending，其余 confirmed（首轮触发修订重试，收尾可部分发布）', async () => {
  const target = reviewUnits(draft)[0].id;
  const result = await reviewAnswer(fakeModel({ challengeIssue: target }), candidate(), [evidence], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  assert.equal(result.accepted, false, '含未通过断言时 accepted=false，保障 M2 检出率与首轮修订机会');
  assert.equal(result.retry, true);
  assert.match(result.feedback || '', new RegExp(target), '反馈包含反证点名原因');
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.reviewStatus, 'needs_human', '部分发布必须标 needs_human：一定存在未通过的断言，标 reviewed 等于谎称整篇已复核');
  const claims = claimsOf(result.text)!;
  const challenged = claims.find(c => c.text === reviewUnits(draft)[0].text)!;
  assert.equal(challenged.status, 'pending');
  assert.equal(challenged.reason, 'challenged', '反证点名的断言带出原因');
  assert.equal(challenged.evidenceRefs, undefined);
  assert.ok(claims.filter(c => c.status === 'confirmed').length >= 1);
  assert.ok(parsed.pendingItems.some((t: string) => t.startsWith(reviewUnits(draft)[0].text)), 'pending 断言转入 pendingItems');
  assert.ok(parsed.pendingItems.some((t: string) => t.includes('（复核反证阶段提出异议）')), 'pendingItems 写明未通过的原因');
});

test('R1：引文某条失败——该条 pending，其余 confirmed（首轮触发修订重试，收尾可部分发布）', async () => {
  const target = reviewUnits(draft)[1].id;
  const result = await reviewAnswer(fakeModel({ unsupportedBlock: target }), candidate(), [evidence], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  assert.equal(result.accepted, false);
  assert.equal(result.retry, true);
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.reviewStatus, 'needs_human');
  const claims = claimsOf(result.text)!;
  const unsupported = claims.find(c => c.text === reviewUnits(draft)[1].text)!;
  assert.equal(unsupported.status, 'pending');
  assert.equal(unsupported.reason, 'unsupported', '判为证据不足的断言标注 unsupported');
  assert.ok(claims.filter(c => c.status === 'confirmed').length >= 1);
  assert.ok(parsed.pendingItems.some((t: string) => t.includes('（证据不足）')));
});

test('R1：两阶段全败——全部断言均未通过，不接受且不产出任何 confirmed', async () => {
  const ids = reviewUnits(draft).map(u => u.id);
  const model = {
    streamChat: async (messages: Message[]) => {
      const packet = JSON.parse(String(messages[1].content));
      if (packet.stage === 'challenge') return answer({ checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: packet.blocks.map((b: any) => ({ blockId: b.id, reason: '均缺少依据' })) });
      return answer({ privacySafe: true, blocks: packet.blocks.map((b: any) => ({ blockId: b.id, assessment: 'unsupported', kind: 'fact', references: [], reason: '缺乏依据' })), missingEvidence: [] });
    },
  } as any;
  const result = await reviewAnswer(model, candidate(), [evidence], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  assert.equal(result.accepted, false);
  const claims = claimsOf(result.text);
  assert.ok(!claims || claims.every(c => c.status !== 'confirmed'));
  assert.equal(ids.length, 3);
});

test('R1：开关关闭时与基线逐字节一致——不附加 claims，反证点名仍走修订重试', async () => {
  const ok = await reviewAnswer(fakeModel(), candidate(), [evidence], 1, 'r1', () => {}, { timeoutMs: 60000 });
  assert.equal(ok.accepted, true);
  assert.equal(claimsOf(ok.text), undefined, '关闭时不带 claims 字段');
  const target = reviewUnits(draft)[0].id;
  const blocked = await reviewAnswer(fakeModel({ challengeIssue: target }), candidate(), [evidence], 1, 'r1', () => {}, { timeoutMs: 60000 });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.retry, true, '关闭时反证点名触发修订（基线行为）');
  assert.equal(claimsOf(blocked.text), undefined);
});

test('R1：证据含 status/conclusion 等列名时，JSON 键名不会误触发私有词拦截而清空部分发布结果（现网回归）', async () => {
  const dbEvidenceWithStatusCol: Message = {
    role: 'tool',
    name: 'company_db_query',
    content: JSON.stringify({
      status: 'success',
      complete: true,
      database: 'skt',
      columns: ['status', 'conclusion', 'confirmed', 'pending'],
      rows: [['资料已有记录。联系电话：0013812345678；证件号码：11010119900101001X']],
    }),
    evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' },
  };
  const target = reviewUnits(draft)[1].id;
  const result = await reviewAnswer(fakeModel({ challengeIssue: target }), candidate(), [dbEvidenceWithStatusCol], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.reviewStatus, 'needs_human', '部分发布的印章就是 needs_human，而非被私有词表打回');
  assert.notEqual(parsed.conclusion, '本次尚未形成可直接采信的业务结论，需要继续核实。', '不得因 JSON 键名 status 命中私有词表整篇降级');
  assert.equal(parsed.conclusion, '资料已有记录。', '已核实的结论保留');
  assert.equal(parsed.businessData.length, 1, '已核实的业务字段保留');
  assert.ok(Array.isArray(parsed.claims) && parsed.claims.some((c: any) => c.status === 'confirmed'));
});


test('R1：引文未通过自动核对——标注 citation_unverified，与"证据不足"分开', async () => {
  const target = reviewUnits(draft)[0].id;
  const result = await reviewAnswer(fakeModel({ badQuoteBlock: target }), candidate(), [evidence], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  assert.equal(result.accepted, false);
  const parsed = JSON.parse(result.text);
  const claim = claimsOf(result.text)!.find(c => c.text === reviewUnits(draft)[0].text)!;
  assert.equal(claim.status, 'pending');
  assert.equal(claim.reason, 'citation_unverified', '引文对不上原文属核对程序未通过，不能与证据不足混为一谈');
  assert.ok(parsed.pendingItems.some((t: string) => t.includes('（引文未通过自动核对，需人工确认）')));
  assert.ok(!parsed.pendingItems.some((t: string) => t.includes('（证据不足）')));
  assert.equal(parsed.reviewStatus, 'needs_human');
});

const replyDraft: PublicDraft = { conclusion: '资料已有记录。', businessData: [], evidenceSummary: [], customerReply: '我们会为您办理退款，预计三日内到账。', pendingItems: [] };
const replyEvidence: Message = { role: 'tool', name: 'company_db_query', content: '资料已有记录。我们会为您办理退款，预计三日内到账。', evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' } };

test('R1：话术整句都没通过核实时改用固定模板，不复用初稿原句', async () => {
  const target = reviewUnits(replyDraft).find(u => u.paragraphId === 'customerReply')!.id;
  const result = await reviewAnswer(fakeModel({ challengeIssue: target }), candidate(replyDraft), [replyEvidence], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.customerReply, PARTIAL_REPLY_TEMPLATE, '话术用模板，绝不拼"只核实了半段"的初稿');
  assert.notEqual(parsed.customerReply, replyDraft.customerReply);
  assert.equal(parsed.conclusion, '资料已有记录。', '已核实的结论照常保留');
  assert.equal(parsed.reviewStatus, 'needs_human');
});

test('R1：客服话术整段通过核实时仍复用初稿原句（不无谓降级）', async () => {
  const target = reviewUnits(replyDraft).find(u => u.paragraphId === 'conclusion')!.id;
  const result = await reviewAnswer(fakeModel({ challengeIssue: target }), candidate(replyDraft), [replyEvidence], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.customerReply, replyDraft.customerReply);
  assert.equal(parsed.reviewStatus, 'needs_human');
});

// 现网回归（2026-10-16 酒店发票会话）：复核把同一行的列名与值用逗号接起来引用，如 "actual_refund_money","-303.0000"，
// 而重建后的行对象是 "actual_refund_money":"-303.0000"，旧逻辑永远匹配不上，导致该会话 100% 断言被判 citation_unverified。
test('R1：复核按逗号拼接同行键值引用时，不再误判为引用无效（现网回归）', async () => {
  const dbDraft: PublicDraft = { conclusion: '该单实际退款金额为 -303.0000，晚数为 1。', businessData: [], evidenceSummary: [], customerReply: '', pendingItems: [] };
  const dbEvidence: Message = {
    role: 'tool',
    name: 'company_db_query',
    content: JSON.stringify({ status: 'success', complete: true, database: 'skt', columns: ['actual_refund_money', 'night_count'], rows: [['-303.0000', 1]] }),
    evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' },
  };
  const model = {
    streamChat: async (messages: Message[]) => {
      const packet = JSON.parse(String(messages[1].content));
      if (packet.stage === 'challenge') return answer({ checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: [] });
      return answer({
        privacySafe: true,
        blocks: packet.blocks.map((b: any) => ({ blockId: b.id, assessment: 'supported', kind: 'fact', references: [{ evidenceId: 'e1', quote: '"actual_refund_money","-303.0000"' }], reason: '同行列名与值' })),
        missingEvidence: [],
      });
    },
  } as any;
  const result = await reviewAnswer(model, candidate(dbDraft), [dbEvidence], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  assert.equal(result.accepted, true, '逗号形式的同行键值引文应被接受，不再整条待核实');
  const claims = claimsOf(result.text)!;
  assert.ok(claims.length > 0 && claims.every(c => c.status === 'confirmed'), '全部断言 confirmed');
});

test('R1：引文跨行拼接仍然判为引用无效（归一化不得放行跨行拼凑）', async () => {
  const dbDraft: PublicDraft = { conclusion: '该单实际退款金额为 -303.0000，晚数为 1。', businessData: [], evidenceSummary: [], customerReply: '', pendingItems: [] };
  const dbEvidence: Message = {
    role: 'tool',
    name: 'company_db_query',
    content: JSON.stringify({ status: 'success', complete: true, database: 'skt', columns: ['actual_refund_money', 'night_count'], rows: [['-303.0000', 1], ['-100.0000', 2]] }),
    evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' },
  };
  const model = {
    streamChat: async (messages: Message[]) => {
      const packet = JSON.parse(String(messages[1].content));
      if (packet.stage === 'challenge') return answer({ checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: [] });
      return answer({
        privacySafe: true,
        blocks: packet.blocks.map((b: any) => ({ blockId: b.id, assessment: 'supported', kind: 'fact', references: [{ evidenceId: 'e1', quote: '"night_count",1,"actual_refund_money","-100.0000"' }], reason: '跨两行拼接' })),
        missingEvidence: [],
      });
    },
  } as any;
  const result = await reviewAnswer(model, candidate(dbDraft), [dbEvidence], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  assert.equal(result.accepted, false, '跨行拼凑的引文不得被归一化放行');
  const claims = claimsOf(result.text);
  assert.ok(!claims || claims.every(c => c.status !== 'confirmed'));
});

test('R1：话术整句未通过改用模板后，初稿话术原句不再列入待核实清单（现网回归）', async () => {
  const target = reviewUnits(replyDraft).find(u => u.paragraphId === 'customerReply')!.id;
  const result = await reviewAnswer(fakeModel({ challengeIssue: target }), candidate(replyDraft), [replyEvidence], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.customerReply, PARTIAL_REPLY_TEMPLATE);
  assert.ok(!parsed.pendingItems.some((t: string) => t.startsWith(replyDraft.customerReply)), '客户没收到的话术不该出现在待核实清单里');
});

// 现网回归（2026-10-16 酒店发票会话）：证据字段只有 kpr/开票人、fpstatus/发票状态，模型却写成"财务已…完成红冲"，
// 把没有依据的业务角色当成动作主体。引文本身对得上原文，所以旧的"引用无效"检查抓不到。
test('R1：角色称谓在证据里无出处时该条 pending，同批其他断言不受牵连', async () => {
  const roleDraft: PublicDraft = { conclusion: '财务已于2026年10月15日对该发票完成红冲。', businessData: [{ label: '开票人', value: '王甲' }], evidenceSummary: [], customerReply: '', pendingItems: [] };
  const roleEvidence: Message = {
    role: 'tool',
    name: 'company_db_query',
    content: JSON.stringify({ status: 'success', complete: true, database: 'skt', columns: ['kpr', 'fpstatus'], rows: [['王甲', 4]] }),
    evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' },
  };
  const model = {
    streamChat: async (messages: Message[]) => {
      const packet = JSON.parse(String(messages[1].content));
      if (packet.stage === 'challenge') return answer({ checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: [] });
      return answer({
        privacySafe: true,
        blocks: packet.blocks.map((b: any) => ({ blockId: b.id, assessment: 'supported', kind: 'fact', references: [{ evidenceId: 'e1', quote: b.text.includes('财务') ? '"fpstatus",4' : '"kpr","王甲"' }], reason: '原文一致' })),
        missingEvidence: [],
      });
    },
  } as any;
  const result = await reviewAnswer(model, candidate(roleDraft), [roleEvidence], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  assert.equal(result.accepted, false, '角色称谓无出处时不得整篇接受');
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.reviewStatus, 'needs_human');
  const claims = claimsOf(result.text)!;
  const roleClaim = claims.find(c => c.text.includes('财务'))!;
  assert.equal(roleClaim.status, 'pending');
  assert.equal(roleClaim.reason, 'citation_unverified', '走既有核对口径，不新增 reason 码');
  assert.equal(roleClaim.evidenceRefs, undefined);
  const factClaim = claims.find(c => c.text.includes('开票人'))!;
  assert.equal(factClaim.status, 'confirmed', '字段本义称谓与同批其他断言不受牵连');
  assert.deepEqual(factClaim.evidenceRefs, ['e1']);
  assert.ok(parsed.pendingItems.some((t: string) => t.includes('（引文未通过自动核对，需人工确认）')));
});

test('R1：角色称谓能在本单元引文里逐字找到时不降级（不误拦）', async () => {
  const roleDraft: PublicDraft = { conclusion: '财务已确认该发票状态为红冲。', businessData: [], evidenceSummary: [], customerReply: '', pendingItems: [] };
  const roleEvidence: Message = { role: 'tool', name: 'company_db_query', content: '财务已确认该发票状态为红冲。', evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' } };
  const result = await reviewAnswer(fakeModel(), candidate(roleDraft), [roleEvidence], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  assert.equal(result.accepted, true);
  const claims = claimsOf(result.text)!;
  assert.ok(claims.length > 0 && claims.every(c => c.status === 'confirmed'));
});

test('R1：角色称谓检查直测——字段本义放行，列注释不算支撑', () => {
  assert.equal(hasUnsupportedActorRole('开票人为王甲，创建人为李乙。', [{ quote: '"kpr","王甲"' }]), false, '开票人/创建人属字段本义，不在名单内');
  assert.equal(hasUnsupportedActorRole('财务已退回押金。', [{ quote: '"fpstatus",4' }]), true);
  assert.equal(hasUnsupportedActorRole('财务已退回押金。', [{ quote: '"fpstatus","4","comment":"财务订单推送状态"' }]), true, '注释解释字段语义，不构成对该单元所引取值的支撑');
  assert.equal(hasUnsupportedActorRole('财务已退回押金。', [{ quote: '财务已退回押金。' }]), false);
  assert.equal(hasUnsupportedActorRole('经办人已提交。', [{ quote: '"a",1' }, { quote: '经办人：张丙' }]), false, '任一引文含该称谓即放行');
  assert.equal(hasUnsupportedActorRole('该发票状态为红冲。', [{ quote: '"fpstatus",4' }]), false, '状态词不在本规则范围');
});

// 现网回归（2026-10-16 酒店发票会话）：话术里已核实的那一句被同段兄弟句牵连，整段换成模板，
// 客户拿到的话术里一条已核实结论都没剩下。改为逐句复用：通过核实的句子保留原句，被点名的句子丢弃并加收尾。
const partialReplyDraft: PublicDraft = { conclusion: '该订单属于部分退单。', businessData: [], evidenceSummary: [], customerReply: '该订单属于提前离店的部分退单，实际消费三晚。操作人相隔12秒连续提交了两张发票。', pendingItems: [] };

test('R5：话术只有部分句子通过核实时，保留已核实句、丢弃未核实句并加收尾（不再整段换模板）', async () => {
  const replyUnits = reviewUnits(partialReplyDraft).filter(u => u.paragraphId === 'customerReply');
  assert.equal(replyUnits.length, 2, '话术切成两句才能逐句裁决');
  const replyEvidence: Message = { role: 'tool', name: 'company_db_query', content: `${partialReplyDraft.conclusion}
${partialReplyDraft.customerReply}`, evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' } };
  const result = await reviewAnswer(fakeModel({ challengeIssue: replyUnits[1].id }), candidate(partialReplyDraft), [replyEvidence], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.customerReply, `${replyUnits[0].text}${PARTIAL_REPLY_SUFFIX}`, '保留已核实句并追加"其余事项仍在核实"');
  assert.ok(!parsed.customerReply.includes('操作人'), '被点名的句子绝不进话术');
  assert.ok(!parsed.pendingItems.some((t: string) => t.startsWith(replyUnits[1].text)), '客户没收到的那句不进待核实清单');
  assert.equal(parsed.conclusion, partialReplyDraft.conclusion, '已核实的结论整段保留');
  assert.equal(parsed.reviewStatus, 'needs_human');
});

// (a) 禁止编造成因走的是修订通道：反馈文本必须带上修订纪律，模型才有机会把成因句自己收回。
test('R5：修订反馈带修订纪律（不编造成因、断言拆句、不得用时间间隔反推）', async () => {
  const target = reviewUnits(draft)[0].id;
  const result = await reviewAnswer(fakeModel({ challengeIssue: target }), candidate(), [evidence], 1, 'r1', () => {}, { timeoutMs: 60000, partialPublish: true });
  assert.match(result.feedback || '', /【修订纪律】/, '反馈必须带纪律块');
  assert.match(result.feedback || '', /成因尚未定位/);
  assert.match(result.feedback || '', /不得用时间间隔/, '时间间隔只说明现象，不得反推成因');
  assert.match(result.feedback || '', new RegExp(target), '纪律块不得顶掉原始问题清单');
});
