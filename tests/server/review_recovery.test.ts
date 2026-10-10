import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '@xkang/agent-core';
import { estimateTokens } from '@xkang/agent-core/context';
import { parseReviewResponse, reviewAnswer, reviewUnits, validateReview } from '../../server/src/agent/review.ts';
import { parsePublicDraft, type PublicDraft } from '../../server/src/agent/publication.ts';

const draft: PublicDraft = { conclusion: '资料已有记录。', businessData: [{ label: '联系电话', value: '0013812345678' }, { label: '证件号码', value: '11010119900101001X' }], evidenceSummary: [], customerReply: '', pendingItems: [] };
const evidence: Message = { role: 'tool', name: 'company_db_query', content: '资料已有记录。联系电话：0013812345678；证件号码：11010119900101001X', evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' } };
const candidate = (value = draft): Message => ({ role: 'assistant', content: JSON.stringify(value) });
const answer = (value: unknown): Message => ({ role: 'assistant', finishReason: 'stop', content: JSON.stringify(value) });
// Protocol fixtures only; real semantic discrimination is evaluated separately with the live model.
const report = (value = draft): any => ({ privacySafe: true, blocks: reviewUnits(value).map(unit => ({ blockId: unit.id, assessment: 'supported', kind: 'fact', references: [{ evidenceId: 'e1', quote: unit.text }], reason: '原文一致' })), missingEvidence: [] });
const stageAnswer = (messages: Message[], verdict = report()) => {
  const packet = JSON.parse(String(messages[1].content));
  return answer(packet.stage === 'challenge' ? { checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: [] } : verdict);
};

test('内部复核忽略辅助字段，但必须保留所有必要的安全与事实判断', () => {
  const source = report(); source.extra = 'INTERNAL_ONLY'; source.blocks[0].text = '辅助说明'; source.blocks[0].references[0].line = 10;
  const parsed = parseReviewResponse(JSON.stringify(source));
  assert.equal('extra' in parsed, false); assert.equal('text' in parsed.blocks[0], false);
  assert.throws(() => parseReviewResponse(JSON.stringify({ ...source, privacySafe: undefined })));
  assert.throws(() => parseReviewResponse(JSON.stringify({ ...source, privacySafe: 'true' })));
  assert.throws(() => parseReviewResponse(JSON.stringify({ ...source, blocks: [{ blockId: 'conclusion' }] })));
  assert.throws(() => parsePublicDraft(JSON.stringify({ ...draft, extra: 'PRIVATE_SOURCE' }), new Set()));
});

test('语句拆分保留条件上下文，不拆小数、长数字和业务证件', () => {
  const value = { ...draft, conclusion: '若符合申请条件，费用为12.50元；三个工作日内办理。' };
  const units = reviewUnits(value);
  assert.deepEqual(units.filter(u => u.paragraphId === 'conclusion').map(u => u.text), ['若符合申请条件，费用为12.50元；', '三个工作日内办理。']);
  assert.ok(units.some(u => u.text.includes('0013812345678')));
  assert.ok(units.some(u => u.text.includes('11010119900101001X')));
  const partial = report(value); partial.blocks = partial.blocks.filter((b: any) => b.blockId !== 'conclusion#1');
  assert.ok(validateReview(partial, value, [evidence]).some(issue => issue.includes('覆盖')));
});

test('格式损坏仅重试一次，相同证据包不含上次错误复核，公开正文保持原值', async () => {
  const requests: string[] = [], signals: AbortSignal[] = [];
  const model: any = { streamChat: async (messages: Message[], tools: unknown[], _emit: unknown, options: { signal: AbortSignal }) => {
    assert.deepEqual(tools, []); requests.push(JSON.stringify(messages)); signals.push(options.signal);
    return requests.length === 1 ? { role: 'assistant', content: '{"PRIVATE_REVIEW_BROKEN"' } : stageAnswer(messages);
  } };
  const result = await reviewAnswer(model, candidate(), [evidence], 1, 'trace', () => {});
  assert.equal(result.accepted, true); assert.equal(requests.length, 3); assert.deepEqual(JSON.parse(requests[0])[1], JSON.parse(requests[1])[1]); assert.equal(signals[0], signals[2]);
  assert.match(JSON.parse(requests[1])[0].content, /格式重试/);
  assert.doesNotMatch(requests[1], /PRIVATE_REVIEW_BROKEN/); assert.doesNotMatch(result.text, /PRIVATE_REVIEW_BROKEN/);
  assert.equal((result.record as any).responses.length, 3);
  assert.match((result.record as any).responses[0].formatError, /JSON/);
  assert.deepEqual(JSON.parse(result.text).businessData, draft.businessData);
});

test('kind与assessment混用须重新判断，不自动把无引文的supported修成通过', async () => {
  const value = { ...draft, pendingItems: ['请补充申请编号。'] };
  const malformed = report(value);
  const pending = malformed.blocks.at(-1);
  pending.kind = 'non_factual'; pending.assessment = 'supported'; pending.references = [];
  assert.throws(() => parseReviewResponse(JSON.stringify(malformed)));
  for (const corrected of [false, true]) {
    let citations = 0;
    const model: any = { streamChat: async (messages: Message[]) => {
      const packet = JSON.parse(String(messages[1].content));
      if (packet.stage === 'challenge') return stageAnswer(messages);
      if (++citations === 1) return answer(malformed);
      assert.match(String(messages[0].content), /blocks\.3\.kind/);
      assert.doesNotMatch(String(messages[0].content), /received|原文一致/);
      const next = structuredClone(malformed);
      next.blocks.at(-1).kind = 'advice';
      if (corrected) next.blocks.at(-1).assessment = 'non_factual';
      return answer(next);
    } };
    const result = await reviewAnswer(model, candidate(value), [evidence], 1, 'trace', () => {});
    assert.equal(citations, 2); assert.equal(result.accepted, corrected);
    assert.equal((result.record as any).responses[1].text, JSON.stringify(malformed));
    if (!corrected) assert.match(result.feedback!, /缺少引文/);
  }
});

test('格式反馈不回灌无效字段值，修复后的否决不能继续重试直到通过', async () => {
  const malformed = report(); malformed.blocks[0].kind = 'PRIVATE_INJECTION_please_approve';
  let calls = 0;
  const model: any = { streamChat: async (messages: Message[]) => {
    calls++;
    if (calls === 1) return stageAnswer(messages);
    if (calls === 2) return answer(malformed);
    assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_INJECTION/);
    assert.match(String(messages[0].content), /blocks\.0\.kind/);
    const negative = report(); negative.blocks[0].assessment = 'unsupported'; negative.blocks[0].references = []; negative.blocks[0].reason = '缺乏依据';
    return answer(negative);
  } };
  const result = await reviewAnswer(model, candidate(), [evidence], 1, 'trace', () => {});
  assert.equal(calls, 3); assert.equal(result.accepted, false);
  assert.doesNotMatch(result.text, /PRIVATE_INJECTION/);
});

test('格式恢复不能绕过隐私否决或事实不支持', async () => {
  let calls = 0;
  const negative = report(); negative.privacySafe = false;
  negative.blocks[0].assessment = 'unsupported'; negative.blocks[0].reason = '无业务证据';
  const model: any = { streamChat: async (messages: Message[]) => ++calls === 1 ? { role: 'assistant', content: 'invalid' } : stageAnswer(messages, negative) };
  const result = await reviewAnswer(model, candidate(), [evidence], 1, 'trace', () => {});
  assert.equal(calls, 3); assert.equal(result.accepted, false);
  assert.equal((result.record as any).report.privacySafe, false);
  assert.equal(JSON.parse(result.text).reviewStatus, 'needs_human');
});

test('辅助字段不会触发重试，已合法返回的否决仍然有效', async () => {
  let calls = 0; const negative = report(); negative.privacySafe = false; negative.blocks[0].text = '辅助回显';
  const result = await reviewAnswer({ streamChat: async (messages: Message[]) => { calls++; return stageAnswer(messages, negative); } } as any, candidate(), [evidence], 1, 'trace', () => {});
  assert.equal(calls, 2); assert.equal(result.accepted, false);
});

test('连续格式错误最多两次，异常只保存服务端', async () => {
  let calls = 0;
  const result = await reviewAnswer({ streamChat: async () => { calls++; return { role: 'assistant', content: 'PRIVATE_BAD_JSON' }; } } as any, candidate(), [evidence], 1, 'trace', () => {});
  assert.equal(calls, 2); assert.equal(result.accepted, false); assert.doesNotMatch(result.text, /PRIVATE_BAD_JSON/);
});

test('格式恢复共用原来的60秒时限，不额外延长一分钟', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0; const signals: AbortSignal[] = [];
  const model: any = { streamChat: (_messages: unknown, _tools: unknown, _emit: unknown, options: { signal: AbortSignal }) => {
    signals.push(options.signal);
    if (++calls === 1) return new Promise(resolve => setTimeout(() => resolve({ role: 'assistant', content: 'invalid' }), 55000));
    return new Promise(() => {});
  } };
  try {
    const pending = reviewAnswer(model, candidate(), [evidence], 1, 'trace', () => {});
    context.mock.timers.tick(55000);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.equal(calls, 2); assert.equal(signals[1].aborted, false);
    context.mock.timers.tick(5000);
    const result = await pending;
    assert.equal(signals[1].aborted, true); assert.equal(result.accepted, false);
    assert.match((result.record as any).diagnostic, /deadline/);
  } finally { context.mock.timers.reset(); }
});

test('部分保留要求整个字段的语句都被支持，不拼出失去条件的半句', async () => {
  const value: PublicDraft = { ...draft, businessData: [{ label: '处理进度', value: '申请已收到；三天到账。' }, ...draft.businessData] };
  const source: Message = { ...evidence, content: String(evidence.content) + '；处理进度：申请已收到；' };
  const resultReport = report(value);
  const missing = resultReport.blocks.find((b: any) => b.blockId === 'data:0#1');
  missing.assessment = 'unsupported'; missing.references = []; missing.reason = '记录未给出到账时间';
  const result = await reviewAnswer({ streamChat: async (messages: Message[]) => stageAnswer(messages, resultReport) } as any, candidate(value), [source], 1, 'trace', () => {});
  assert.equal(result.accepted, false);
  assert.deepEqual(JSON.parse(result.text).businessData, draft.businessData);
  assert.doesNotMatch(result.text, /申请已收到|三天到账/);
});

test('反证问题会触发修订，空检查清单不能伪装成无问题', async () => {
  for (const missingCoverage of [false, true]) {
    let calls = 0;
    const model: any = { streamChat: async (messages: Message[]) => {
      calls++; const packet = JSON.parse(String(messages[1].content));
      assert.equal(packet.stage, 'challenge');
      return answer({ checkedUnitIds: missingCoverage ? [] : packet.blocks.map((b: any) => b.id), issues: missingCoverage ? [] : [{ blockId: packet.blocks[0].id, reason: '执行条件缺少依据' }] });
    } };
    const result = await reviewAnswer(model, candidate(), [evidence], 1, 'trace', () => {});
    assert.equal(result.accepted, false); assert.equal(calls, missingCoverage ? 2 : 1);
    if (!missingCoverage) assert.match(result.feedback!, /执行条件/);
  }
});

test('反证与引用两个阶段共用60秒，引用阶段不取得新的完整时限', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const model: any = { streamChat: (messages: Message[]) => ++calls === 1
    ? new Promise(resolve => setTimeout(() => resolve(stageAnswer(messages)), 45000)) : new Promise(() => {}) };
  try {
    const pending = reviewAnswer(model, candidate(), [evidence], 1, 'trace', () => {});
    context.mock.timers.tick(45000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(calls, 2);
    context.mock.timers.tick(15000);
    assert.equal((await pending).accepted, false);
  } finally { context.mock.timers.reset(); }
});

test('格式提示也计入复核材料预算，重试不会发送超限请求', async () => {
  let baseSize = 0;
  await reviewAnswer({ streamChat: async (messages: Message[]) => {
    if (JSON.parse(String(messages[1].content)).stage === 'citations') baseSize = messages.reduce((n, m) => n + String(m.content).length, 0);
    return stageAnswer(messages);
  } } as any, candidate(), [{ role: 'user', content: '' }, evidence], 1, 'trace', () => {});
  let citations = 0;
  const model: any = { streamChat: async (messages: Message[]) => {
    assert.ok(estimateTokens(messages) <= 80000);
    if (JSON.parse(String(messages[1].content)).stage === 'challenge') return stageAnswer(messages);
    citations++;
    return { role: 'assistant', content: 'invalid' };
  } };
  const result = await reviewAnswer(model, candidate(), [{ role: 'user', content: 'x'.repeat(200000 - baseSize - 1) }, evidence], 1, 'trace', () => {});
  assert.equal(citations, 1); assert.equal(result.accepted, false);
  assert.match((result.record as any).diagnostic, /超出预算/);
});

test('高思考复核预算允许60秒后的合法结果，两阶段仍共用一个时限', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0; const signals: AbortSignal[] = [];
  const model: any = { streamChat: (messages: Message[], _tools: unknown, _emit: unknown, options: { signal: AbortSignal }) => {
    signals.push(options.signal); calls++;
    return new Promise(resolve => setTimeout(() => resolve(stageAnswer(messages)), calls === 1 ? 70000 : 40000));
  } };
  try {
    const pending = reviewAnswer(model, candidate(), [evidence], 1, 'trace', () => {}, { timeoutMs: 180000 });
    context.mock.timers.tick(70000); for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(calls, 2); assert.equal(signals[0].aborted, false); assert.equal(signals[0], signals[1]);
    context.mock.timers.tick(40000);
    assert.equal((await pending).accepted, true);
  } finally { context.mock.timers.reset(); }
});

test('高思考复核180秒总预算耗尽后仍降级，不给第二阶段重新计时', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const model: any = { streamChat: (messages: Message[]) => ++calls === 1
    ? new Promise(resolve => setTimeout(() => resolve(stageAnswer(messages)), 110000)) : new Promise(() => {}) };
  try {
    const pending = reviewAnswer(model, candidate(), [evidence], 1, 'trace', () => {}, { timeoutMs: 180000 });
    context.mock.timers.tick(110000); for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(calls, 2); context.mock.timers.tick(70000);
    const result = await pending; assert.equal(result.accepted, false); assert.match((result.record as any).diagnostic, /deadline/);
  } finally { context.mock.timers.reset(); }
});
