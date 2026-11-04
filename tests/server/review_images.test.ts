import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ChatGateway, Message, MessageContentPart } from '@xkang/agent-core';
import { estimateTokens, messageText } from '@xkang/agent-core/context';
import { REVIEW_IMAGE_LIMIT, reviewAnswer, reviewUnits, validateReview } from '../../server/src/agent/review.ts';
import { FallbackReviewGateway } from '../../server/src/agent/review_gateway.ts';
import { BusinessModel } from '../../server/src/agent/model.ts';
import { AuditLogger } from '../../server/src/auth.ts';
import type { PublicDraft } from '../../server/src/agent/publication.ts';

// B1 复核能看到原图；B2 截图转写（read_attachment）成为复核可引用的证据。
/** 带合法 PNG 头的 data URL；fill 不同则 URL 不同 */
const png = (fill: number, sizeKb = 64) => {
  const header = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 4, 0x38]), Buffer.from([0, 0, 9, 0x60])]);
  return `data:image/png;base64,${Buffer.concat([header, Buffer.alloc(sizeKb * 1024, fill)]).toString('base64')}`;
};
const IMG = [png(0x41), png(0x42), png(0x43), png(0x44), png(0x45), png(0x46)];
const imagePart = (url: string): MessageContentPart => ({ type: 'image_url', image_url: { url } });

const TRANSCRIPT = '【附件 1：图片中的文字（模型逐字转写，以原图为准）】\n退票须知\n超过下午1点半则该天不可退';
const seedCall: Message = { role: 'assistant', content: '', turnId: 't1', tool_calls: [{ id: 'call_seed', name: 'read_attachment', arguments: { index: 1 } }] };
const transcript: Message = { role: 'tool', name: 'read_attachment', tool_call_id: 'call_seed', turnId: 't1', content: TRANSCRIPT,
  evidence: { id: 'e_att1', observedAt: '2026-10-27T00:00:00.000Z', arguments: { index: 1 }, outcome: 'success', completeness: 'unknown' } };
const draft: PublicDraft = { conclusion: '截图显示超过下午1点半则该天不可退。', businessData: [], evidenceSummary: [], customerReply: '', pendingItems: [] };
const candidate = (value: PublicDraft = draft, evidenceIds = ['e_att1']): Message => ({ role: 'assistant', turnId: 't1', content: JSON.stringify({ answer: value, evidenceIds }) });
const userWith = (...parts: MessageContentPart[]): Message => ({ role: 'user', turnId: 't1', content: [{ type: 'text', text: '客户说下午两点退不了，截图如下' }, ...parts] });

/** 复核桩：反证不点名；引文阶段对每个语句引用 evidenceId 里的 quote */
function reviewer(quote = '超过下午1点半则该天不可退', evidenceId = 'e_att1') {
  const seen: Message[][] = [];
  const model = { streamChat: async (messages: Message[]) => {
    seen.push(messages);
    const packet = JSON.parse(messageText(messages[1]));
    if (packet.stage === 'challenge') return { role: 'assistant', finishReason: 'stop', content: JSON.stringify({ checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: [] }) };
    return { role: 'assistant', finishReason: 'stop', content: JSON.stringify({ privacySafe: true, blocks: packet.blocks.map((b: any) => ({ blockId: b.id, assessment: 'supported', kind: 'fact', references: [{ evidenceId, quote }], reason: '截图转写原文' })), missingEvidence: [] }) };
  } } as unknown as ChatGateway;
  return { model, seen };
}
const packetOf = (messages: Message[]) => JSON.parse(messageText(messages[1]));
const placeholders = (question: { content: unknown }) => (question.content as Array<{ text: string }>).map(part => part.text).filter(text => text.startsWith('[截图'));

test('B1：历史用户消息带图片时，复核请求 user content 是数组：JSON 文本块在前、原图按顺序随附，文本里没有 base64', async () => {
  const { model, seen } = reviewer();
  const result = await reviewAnswer(model, candidate(), [userWith(imagePart(IMG[0]), imagePart(IMG[1])), seedCall, transcript], 1, 'trace', () => {}, { timeoutMs: 60000 });
  assert.equal(result.accepted, true, '引用截图转写证据的断言通过复核');
  assert.equal(seen.length, 2, '反证与引文两个阶段都要随附原图');
  for (const messages of seen) {
    assert.equal(typeof messages[0].content, 'string');
    const content = messages[1].content;
    assert.ok(Array.isArray(content), '带图时 content 必须是数组');
    assert.equal(content[0].type, 'text');
    assert.deepEqual(content.slice(1), [imagePart(IMG[0]), imagePart(IMG[1])], '随附的就是原图（同一 URL、同一顺序）');
    const text = (content[0] as { text: string }).text;
    assert.doesNotMatch(text, /base64/, 'JSON 文本里不塞 base64');
    assert.ok(!text.includes(IMG[0].slice(-200)));
    const packet = JSON.parse(text);
    assert.deepEqual(placeholders(packet.questions[0]), ['[截图 1：见随附图片 1]', '[截图 2：见随附图片 2]']);
    // 截图转写证据进入复核的证据索引与原文
    assert.ok(packet.index.some((item: any) => item.id === 'e_att1' && item.tool === 'read_attachment'));
    assert.ok(packet.evidence.some((item: any) => item.id === 'e_att1' && item.content === TRANSCRIPT));
  }
  // 预算估算按固定额度计 image_url 块，不把 base64 当文本：2MB 与 1KB 的图估算相同
  const imageOnly = (url: string): Message[] => [{ role: 'user', content: [imagePart(url)] }];
  assert.equal(estimateTokens(imageOnly(png(0x41, 2048))), estimateTokens(imageOnly(png(0x41, 1))));
});

// 由改动前（HEAD dfbb998）的 reviewAnswer 对同一输入实际生成：不带图片时复核请求必须逐字节不变
const GOLDEN_CHALLENGE = "{\"questions\":[{\"role\":\"user\",\"content\":\"核对订单 1530517490084478976 的退款规则\"},{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"补充：只有文字分段\"}]}],\"paragraphs\":[{\"id\":\"conclusion\",\"text\":\"超过下午1点半则该天不可退。\"}],\"blocks\":[{\"id\":\"conclusion#0\",\"paragraphId\":\"conclusion\",\"text\":\"超过下午1点半则该天不可退。\"}],\"index\":[{\"id\":\"e_fixed\",\"tool\":\"company_db_query\",\"observedAt\":\"2026-10-27T00:00:00.000Z\",\"arguments\":{\"sql\":\"SELECT 1\"},\"outcome\":\"success\",\"completeness\":\"complete\",\"returnedChars\":19}],\"evidence\":[{\"id\":\"e_fixed\",\"content\":\"退票规则：超过下午1点半则该天不可退。\"}],\"omittedEvidence\":[],\"stage\":\"challenge\"}";
const GOLDEN_CITATIONS = GOLDEN_CHALLENGE.replace('"stage":"challenge"', '"stage":"citations"');

test('B1：不带图片时 content 仍是字符串，且与改动前逐字节一致', async () => {
  const fixed: Message = { role: 'tool', name: 'company_db_query', tool_call_id: 'c1', turnId: 't1', content: '退票规则：超过下午1点半则该天不可退。',
    evidence: { id: 'e_fixed', observedAt: '2026-10-27T00:00:00.000Z', arguments: { sql: 'SELECT 1' }, outcome: 'success', completeness: 'complete' } };
  const history: Message[] = [
    { role: 'user', content: '核对订单 1530517490084478976 的退款规则', turnId: 't1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'company_db_query', arguments: { sql: 'SELECT 1' } }], turnId: 't1' },
    fixed,
    { role: 'user', content: [{ type: 'text', text: '补充：只有文字分段' }], turnId: 't1' },
  ];
  const plain: PublicDraft = { ...draft, conclusion: '超过下午1点半则该天不可退。' };
  const { model, seen } = reviewer('超过下午1点半则该天不可退', 'e_fixed');
  const result = await reviewAnswer(model, candidate(plain, ['e_fixed']), history, 1, 'trace', () => {}, { timeoutMs: 60000 });
  assert.equal(result.accepted, true);
  assert.deepEqual(seen.map(messages => messages.map(m => typeof m.content)), [['string', 'string'], ['string', 'string']]);
  assert.equal(seen[0][1].content, GOLDEN_CHALLENGE);
  assert.equal(seen[1][1].content, GOLDEN_CITATIONS);
});

test('B1：随附原图有上限；超出时优先最近一次提问的图，随附顺序仍按原文先后，未随附的占位注明', async () => {
  assert.equal(REVIEW_IMAGE_LIMIT, 4);
  // 同一条提问 6 张图：随附前 4 张，第 5、6 张只留占位
  const single = reviewer();
  await reviewAnswer(single.model, candidate(), [userWith(...IMG.map(imagePart)), seedCall, transcript], 1, 'trace', () => {}, { timeoutMs: 60000 });
  const content = single.seen[0][1].content as MessageContentPart[];
  assert.deepEqual(content.slice(1), IMG.slice(0, REVIEW_IMAGE_LIMIT).map(imagePart));
  const marks = placeholders(packetOf(single.seen[0]).questions[0]);
  assert.deepEqual(marks.slice(0, 4), [1, 2, 3, 4].map(n => `[截图 ${n}：见随附图片 ${n}]`));
  assert.ok(marks.slice(4).every(mark => mark.includes('未随附原图') && !mark.includes('base64')), marks.slice(4).join(' | '));

  // 早先提问 3 张、最近一次提问 2 张：最近的 2 张必须随附，剩余名额给早先提问的前 2 张
  const older: Message = { role: 'user', turnId: 't0', content: [{ type: 'text', text: '早先的截图' }, imagePart(IMG[0]), imagePart(IMG[1]), imagePart(IMG[2])] };
  const latest: Message = { role: 'user', turnId: 't1', content: [{ type: 'text', text: '这次的截图' }, imagePart(IMG[3]), imagePart(IMG[4])] };
  const multi = reviewer();
  await reviewAnswer(multi.model, candidate(), [older, latest, seedCall, transcript], 1, 'trace', () => {}, { timeoutMs: 60000 });
  assert.deepEqual((multi.seen[0][1].content as MessageContentPart[]).slice(1), [IMG[0], IMG[1], IMG[3], IMG[4]].map(imagePart));
  const questions = packetOf(multi.seen[0]).questions;
  assert.deepEqual(placeholders(questions[0]).slice(0, 2), ['[截图 1：见随附图片 1]', '[截图 2：见随附图片 2]']);
  assert.match(placeholders(questions[0])[2], /^\[截图 3：.*未随附原图\]$/);
  assert.deepEqual(placeholders(questions[1]), ['[截图 1：见随附图片 3]', '[截图 2：见随附图片 4]']);
});

test('B1：多模态复核消息经 FallbackReviewGateway 与 BusinessModel 原样传到上游请求（L3 失败降级 L2 也带图）', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,timestamp,user,type,tool_name,model,prompt_tokens,completion_tokens,total_tokens,duration_ms,details,success,error)');
  try {
    const audit = new AuditLogger(db);
    const config = { answerReviewTimeoutMs: 60000, modelCallTimeoutMs: 60000 } as any;
    /** 假上游：记录 chat.completions.create 收到的请求体；respond 返回正文或抛错 */
    const upstream = (bodies: any[], respond: (body: any) => string) => () => ({ targetModel: 'fake-model', client: { chat: { completions: { create: async (body: any) => {
      bodies.push(body);
      const reply = respond(body);
      return (async function* () {
        yield { choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] };
        yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      })();
    } } } } as any });
    const l3Bodies: any[] = [], l2Bodies: any[] = [];
    const l3 = new BusinessModel(config, 'gemini', audit, 'alice', undefined, true, upstream(l3Bodies, () => { throw Object.assign(new Error('400 image not supported'), { status: 400 }); })).asReviewTier('l3-model');
    const l2 = new BusinessModel(config, 'gemini', audit, 'alice', undefined, true, upstream(l2Bodies, body => {
      const text = body.messages[1].content.find((part: any) => part.type === 'text').text;
      const packet = JSON.parse(text);
      if (packet.stage === 'challenge') return JSON.stringify({ checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: [] });
      return JSON.stringify({ privacySafe: true, blocks: packet.blocks.map((b: any) => ({ blockId: b.id, assessment: 'supported', kind: 'fact', references: [{ evidenceId: 'e_att1', quote: '超过下午1点半则该天不可退' }], reason: '截图转写原文' })), missingEvidence: [] });
    }));
    const result = await reviewAnswer(new FallbackReviewGateway(l3, l2), candidate(), [userWith(imagePart(IMG[0])), seedCall, transcript], 1, 'trace', () => {}, { timeoutMs: 60000 });
    assert.equal(result.accepted, true);
    assert.equal(l3Bodies.length, 2); assert.equal(l2Bodies.length, 2);
    for (const body of [...l3Bodies, ...l2Bodies]) {
      const user = body.messages.find((m: any) => m.role === 'user');
      assert.ok(Array.isArray(user.content), '上游请求里的复核消息仍是多模态数组');
      assert.deepEqual(user.content.filter((part: any) => part.type === 'image_url'), [imagePart(IMG[0])]);
      assert.doesNotMatch(user.content[0].text, /base64/);
    }
  } finally { db.close(); }
});

test('B2：草稿断言引用 read_attachment 证据里的原文句子不报"引用无效"，引用转写里不存在的句子则报', async () => {
  const history = [userWith(imagePart(IMG[0])), seedCall, transcript];
  const units = reviewUnits(draft);
  const report = (quote: string, kind: 'fact' | 'performed_action' = 'fact') => ({ privacySafe: true, missingEvidence: [],
    blocks: units.map(unit => ({ blockId: unit.id, assessment: 'supported' as const, kind, references: [{ evidenceId: 'e_att1', quote }], reason: '截图转写原文' })) });
  assert.deepEqual(validateReview(report('超过下午1点半则该天不可退'), draft, history), []);
  assert.ok(validateReview(report('超过下午2点则该天不可退'), draft, history).some(issue => issue.includes('引用无效')));
  // read_attachment 属于只读工具：引用它的语句不会被当成"没有动作执行记录"
  assert.ok(!validateReview(report('超过下午1点半则该天不可退', 'performed_action'), draft, history).some(issue => issue.includes('没有动作执行记录')));

  // 完整复核链路：引文不在转写原文里时不能通过
  const { model } = reviewer('超过下午2点则该天不可退');
  const rejected = await reviewAnswer(model, candidate(), history, 1, 'trace', () => {}, { timeoutMs: 60000 });
  assert.equal(rejected.accepted, false);
  assert.ok((rejected.record as any).issues.some((issue: string) => issue.includes('引用无效')));
});
