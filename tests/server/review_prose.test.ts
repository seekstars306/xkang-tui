import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '@xkang/agent-core';
import { extractJsonObject, reviewAnswer, reviewUnits } from '../../server/src/agent/review.ts';
import type { PublicDraft } from '../../server/src/agent/publication.ts';

const draft: PublicDraft = { conclusion: '资料已有记录。', businessData: [{ label: '联系电话', value: '0013812345678' }, { label: '证件号码', value: '11010119900101001X' }], evidenceSummary: [], customerReply: '', pendingItems: [] };
const evidence: Message = { role: 'tool', name: 'company_db_query', content: '资料已有记录。联系电话：0013812345678；证件号码：11010119900101001X', evidence: { id: 'e1', observedAt: '', arguments: {}, outcome: 'success', completeness: 'complete' } };
const candidate = (value: unknown = draft): Message => ({ role: 'assistant', content: typeof value === 'string' ? value : JSON.stringify(value) });
const answer = (value: unknown): Message => ({ role: 'assistant', finishReason: 'stop', content: JSON.stringify(value) });
// 正文形态的复核回复：content 就是正文本身，不能再被 stringify 一次（那会把换行变成 \n 转义）
const proseAnswer = (text: string): Message => ({ role: 'assistant', finishReason: 'stop', content: text });
const report = (value = draft): any => ({ privacySafe: true, blocks: reviewUnits(value).map(unit => ({ blockId: unit.id, assessment: 'supported', kind: 'fact', references: [{ evidenceId: 'e1', quote: unit.text }], reason: '原文一致' })), missingEvidence: [] });
const challengeOf = (messages: Message[]) => { const packet = JSON.parse(String(messages[1].content)); return { checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: [] }; };

// L3（claude 系）把复核报告写成 Markdown：协议 JSON 可能包在代码块里，也可能只附在正文之后。
test('从 Markdown 复核报告里定位协议 JSON，纯正文则不返回片段', () => {
  assert.equal(extractJsonObject('结论：\n\n```json\n{"a":1}\n```\n以上。'), '{"a":1}');
  assert.equal(extractJsonObject('## 结论\n检查完毕，未发现问题。\n\n{"a":{"b":2}}'), '{"a":{"b":2}}');
  // 字符串里的括号和转义引号不能打断配对
  assert.equal(extractJsonObject('引文为 "}{" 与 \\" 时仍应配平'), null);
  assert.equal(extractJsonObject('{"quote":"}{ \\" ok"}'), '{"quote":"}{ \\" ok"}');
  assert.equal(extractJsonObject('## 结论\n未发现反证问题，正文即可。'), null);
});

test('复核模型只回正文时按修订处理，不发"复核不可用"，草稿带未复核标注带走', async () => {
  const prose = '## 结论\n第 1 条无法由现有证据支持，缺少推送日志。';
  const model: any = { streamChat: async () => proseAnswer(prose) };
  const result = await reviewAnswer(model, candidate(), [evidence], 1, 'trace', () => {}, { timeoutMs: 60000 });
  const record: any = result.record;
  assert.equal(record.status, 'needs_revision');
  assert.notEqual(record.status, 'unavailable');
  assert.equal(result.accepted, false);
  assert.equal(result.retry, true);
  assert.equal(record.validUnitCount, 0);
  assert.match(record.diagnostic, /正文/);
  // 分层网关靠这个标记立刻降级，不能把它当成"结论被打回"
  assert.equal(record.unstructured, true);
  assert.match(result.feedback!, /缺少推送日志/);
  // 正文里的协议解释不当作已核实结论；草稿原样带走，并明确标注未复核
  assert.equal(record.report, undefined);
  const carried = JSON.parse(result.text);
  assert.equal(carried.reviewStatus, 'needs_human');
  assert.equal(carried.conclusion, draft.conclusion);
  assert.deepEqual(carried.businessData, draft.businessData);
});

test('草稿本身就不是协议 JSON 时，未复核正文绝不带出去', async () => {
  const model: any = { streamChat: async () => proseAnswer('## 结论\n未发现反证问题。') };
  const result = await reviewAnswer(model, candidate('## 结论\n酒店推送日志里查到了记录。'), [evidence], 1, 'trace', () => {}, { timeoutMs: 60000 });
  const record: any = result.record;
  assert.equal(record.status, 'needs_revision');
  assert.doesNotMatch(result.text, /酒店推送日志里查到了记录/);
  assert.equal(JSON.parse(result.text).conclusion, '本次尚未形成可直接采信的业务结论，需要继续核实。');
});

test('协议 JSON 被正文包住时正常完成复核，并记录为正文提取', async () => {
  const model: any = { streamChat: async (messages: Message[]) => {
    const packet = JSON.parse(String(messages[1].content));
    const body = packet.stage === 'challenge' ? challengeOf(messages) : report();
    return proseAnswer(`## 复核报告\n逐条核对如下。\n\n` + '\u0060'.repeat(3) + `json\n${JSON.stringify(body)}\n` + '\u0060'.repeat(3) + '\n以上为本次复核结论。');
  } };
  const result = await reviewAnswer(model, candidate(), [evidence], 1, 'trace', () => {}, { timeoutMs: 60000 });
  const record: any = result.record;
  assert.equal(result.accepted, true);
  assert.equal(record.responses.length, 2);
  assert.ok(record.responses.every((saved: any) => saved.salvaged === true));
  assert.ok(record.responses.every((saved: any) => saved.formatError === undefined));
});
