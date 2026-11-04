import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ChatGateway, Message, MessageContentPart, ModelType, Registry, StreamEvent, ToolDefinition } from '@xkang/agent-core';
import { messageText } from '@xkang/agent-core/context';
import { AgentStore } from '../../server/src/agent/store.ts';
import { AgentService } from '../../server/src/agent/service.ts';
import { AuditLogger } from '../../server/src/auth.ts';
import { ATTACHMENT_IMAGE_LIMIT, attachmentImages, readAttachmentTool, restoreAttachmentTranscripts, transcribeAttachments, type ImageTranscriber } from '../../server/src/agent/attachments.ts';

// B2：输入带截图时，service 用（可注入的）转写函数逐张转写，结果作为 read_attachment 证据写进会话。
const IMG1 = 'data:image/png;base64,' + Buffer.alloc(300, 1).toString('base64');
const IMG2 = 'data:image/png;base64,' + Buffer.alloc(300, 2).toString('base64');
const imageInput = (): MessageContentPart[] => [{ type: 'text', text: '客户说下午两点退不了' }, { type: 'image_url', image_url: { url: IMG1 } }, { type: 'image_url', image_url: { url: IMG2 } }];
const QUOTE = '超过下午1点半则该天不可退';
const ctx = { repoPath: '', localCwd: '' };

class TestRegistry implements Registry {
  tools = new Map<string, ToolDefinition>();
  constructor() { this.registerLocal({ name: 'company_db_query', description: 'internal', parameters: { type: 'object', properties: {} }, execute: async () => ({ status: 'success', complete: true, rows: [] }) }); }
  registerLocal(tool: ToolDefinition) { this.tools.set(tool.name, tool); }
  getTools() { return [...this.tools.values()]; }
  getTool(name: string) { return this.tools.get(name); }
  getRemoteSkills() { return []; }
  async executeTool(name: string, args: Record<string, unknown>) { return this.tools.get(name)!.execute(args, ctx); }
}
/** 调查直接给候选（引用会话里的截图转写证据）；复核引用转写原文，找不到转写证据时判"不确定" */
class ScriptModel implements ChatGateway {
  investigations: Array<{ messages: Message[]; tools: string[] }> = [];
  reviews: Message[][] = [];
  getCurrentModel(): ModelType { return 'xkang-managed'; }
  switchModel() {}
  async streamChat(messages: Message[], tools: ToolDefinition[], _emit: (event: StreamEvent) => void, options?: { signal?: AbortSignal }): Promise<Message> {
    if (options?.signal) {
      this.reviews.push(messages);
      const packet = JSON.parse(messageText(messages[1]));
      if (packet.stage === 'challenge') return { role: 'assistant', content: JSON.stringify({ checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: [] }) };
      const source = packet.index.find((item: any) => item.tool === 'read_attachment');
      return { role: 'assistant', content: JSON.stringify({ privacySafe: true, missingEvidence: [], blocks: packet.blocks.map((b: any) => source
        ? { blockId: b.id, kind: 'fact', assessment: 'supported', references: [{ evidenceId: source.id, quote: QUOTE }], reason: '截图转写原文' }
        : { blockId: b.id, kind: 'fact', assessment: 'uncertain', references: [], reason: '没有截图证据' }) }) };
    }
    this.investigations.push({ messages: messages.map(m => ({ ...m })), tools: tools.map(t => t.name) });
    const evidenceIds = messages.filter(m => m.role === 'tool' && m.name === 'read_attachment').map(m => m.evidence!.id);
    return { role: 'assistant', content: JSON.stringify({ answer: { conclusion: `截图显示${QUOTE}。`, businessData: [], evidenceSummary: [], customerReply: '', pendingItems: [] }, evidenceIds }) };
  }
}
function fixture(transcriberFactory?: (owner: string, runSignal: AbortSignal) => ImageTranscriber, config: Record<string, unknown> = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,timestamp,user,type,tool_name,model,prompt_tokens,completion_tokens,total_tokens,duration_ms,details,success,error)');
  const audit = new AuditLogger(db), store = new AgentStore(db), model = new ScriptModel();
  const service = new AgentService(store, { answerReviewTimeoutMs: 60000, modelCallTimeoutMs: 240000, ...config } as any, audit, { getActive: () => 'gemini' } as any,
    () => model, () => new TestRegistry(), transcriberFactory);
  return { db, audit, store, service, model };
}
const runTurn = (service: AgentService, id: string, input: string | MessageContentPart[]) => new Promise<void>(resolve => service.start('alice', id, input, event => { if (event.type === 'done') resolve(); }));
const attachmentResults = (messages: Message[]) => messages.filter(m => m.role === 'tool' && m.name === 'read_attachment');

test('B2：输入含图片时调用注入的转写函数，结果作为 read_attachment 证据写进会话；单张失败只跳过该图', async () => {
  const calls: Array<{ index: number; url: string }> = [];
  const { db, store, service, model } = fixture(() => async (image, signal) => {
    assert.ok(signal instanceof AbortSignal);
    calls.push({ index: image.index, url: image.url });
    if (image.index === 2) throw new Error('第二张转写失败');
    return `退票须知\n${QUOTE}`;
  });
  try {
    const session = store.create('alice');
    await runTurn(service, session.id, imageInput());
    assert.deepEqual(calls.sort((a, b) => a.index - b.index), [{ index: 1, url: IMG1 }, { index: 2, url: IMG2 }], '每张图各转写一次');

    // 第一次调查调用：用户消息之后紧跟预置的 read_attachment 调用与带证据编号的结果；工具真实注册、可再调用
    const first = model.investigations[0];
    assert.ok(first.tools.includes('read_attachment'));
    assert.deepEqual(first.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool']);
    assert.deepEqual(first.messages[2].tool_calls!.map(c => [c.name, c.arguments]), [['read_attachment', { index: 1 }]], '失败的第二张不写证据');
    const seeded = messageText(first.messages[3]);
    assert.ok(seeded.startsWith(`【附件 1：图片中的文字（模型逐字转写，以原图为准）】\n退票须知\n${QUOTE}`), seeded);
    assert.match(seeded, /\[证据编号: e_[0-9a-f-]+\]$/);

    // 会话持久化的历史里有这条证据
    const saved = attachmentResults(store.load('alice', session.id)!.messages);
    assert.equal(saved.length, 1);
    assert.match(saved[0].evidence!.id, /^e_/);
    assert.equal(saved[0].evidence!.outcome, 'success');
    assert.deepEqual(saved[0].evidence!.arguments, { index: 1 });

    // 复核：证据索引里有这条转写、随附原图，引用转写原文的结论通过复核
    const reviewRequest = model.reviews[0][1];
    assert.ok(Array.isArray(reviewRequest.content));
    assert.deepEqual(reviewRequest.content.filter(part => part.type === 'image_url').map(part => (part as any).image_url.url), [IMG1, IMG2]);
    assert.ok(JSON.parse(messageText(reviewRequest)).index.some((item: any) => item.id === saved[0].evidence!.id && item.tool === 'read_attachment'));
    assert.equal(service.get('alice', session.id)!.turns[0].answer?.reviewStatus, 'reviewed');
  } finally { db.close(); }
});

test('B2：转写全部失败不影响排查：照常调查并给出答案，会话里没有转写证据', async () => {
  let called = 0;
  const { db, store, service, model } = fixture(() => async () => { called++; throw new Error('模型不可用'); });
  try {
    const session = store.create('alice');
    await runTurn(service, session.id, imageInput());
    assert.equal(called, 2);
    assert.ok(model.investigations.length >= 1, '排查照常进行');
    assert.deepEqual(model.investigations[0].messages.map(m => m.role), ['system', 'user']);
    assert.equal(attachmentResults(store.load('alice', session.id)!.messages).length, 0);
    const turn = service.get('alice', session.id)!.turns[0];
    assert.ok(turn.answer, '本轮正常收尾并给出答案');
  } finally { db.close(); }
});

test('B2：没有图片时不转写、不注册 read_attachment，调查请求与以前一致', async () => {
  let called = 0;
  const { db, store, service, model } = fixture(() => async () => { called++; return 'x'; });
  try {
    const session = store.create('alice');
    await runTurn(service, session.id, '核对退款规则');
    assert.equal(called, 0);
    assert.equal(model.investigations[0].tools.includes('read_attachment'), false);
    assert.deepEqual(model.investigations[0].messages.map(m => m.role), ['system', 'user']);
  } finally { db.close(); }
});

test('B2：续查恢复本轮已写入的转写，历史里的 read_attachment 调用仍指向存在的工具', async () => {
  const { db, store, service, model } = fixture(() => async () => { throw new Error('续查不应重新转写'); });
  try {
    const session = store.create('alice');
    const turnId = 'r_frozen_attachment';
    const text = `【附件 1：图片中的文字（模型逐字转写，以原图为准）】\n${QUOTE}`;
    const messages: Message[] = [
      { role: 'user', content: imageInput(), turnId },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_seed', name: 'read_attachment', arguments: { index: 1 } }], turnId },
      { role: 'tool', name: 'read_attachment', tool_call_id: 'call_seed', turnId, content: text, evidence: { id: 'e_att_frozen', observedAt: new Date().toISOString(), arguments: { index: 1 }, outcome: 'success', completeness: 'unknown' } },
    ];
    const now = new Date().toISOString();
    store.save('alice', { id: session.id, title: '截图核对', createdAt: now, lastActiveAt: now, status: 'idle', turns: [{ id: turnId, userText: '客户说下午两点退不了' }], frozen: true, extensions: 0 }, messages);
    store.saveRunState('alice', session.id, { turns: 1, reviewAttempts: 0, extensions: 0, turnsAllowed: 50, reviewAttemptsAllowed: 2, activeMs: 900000, startedAt: Date.now() - 900000, frozen: true, abortedByDeadline: false }, null);
    await new Promise<void>(resolve => assert.ok(service.continue('alice', session.id, event => { if (event.type === 'done') resolve(); })));
    assert.ok(model.investigations[0].tools.includes('read_attachment'));
    assert.equal(service.get('alice', session.id)!.turns[0].answer?.reviewStatus, 'reviewed');
  } finally { db.close(); }
});

test('转写：最多 4 张、并行；单张抛错/超时/空结果只跳过该图；结果可经 read_attachment 按序号读取', async () => {
  const images = Array.from({ length: 6 }, (_, i) => ({ index: i + 1, url: `data:image/png;base64,${i}` }));
  const seen: number[] = [];
  const transcripts = new Map<number, string>();
  const results = await transcribeAttachments(images, async image => {
    seen.push(image.index);
    if (image.index === 2) return new Promise<string>(() => {}); // 既不返回也不理会 signal：靠时限放弃
    if (image.index === 3) throw new Error('boom');
    if (image.index === 4) return '   ';
    return `第 ${image.index} 张的文字`;
  }, transcripts, { timeoutMs: 30 });
  assert.equal(ATTACHMENT_IMAGE_LIMIT, 4);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4]);
  assert.deepEqual(results, [{ name: 'read_attachment', arguments: { index: 1 }, text: '【附件 1：图片中的文字（模型逐字转写，以原图为准）】\n第 1 张的文字' }]);
  const tool = readAttachmentTool(transcripts);
  assert.equal(await tool.execute({ index: 1 }, ctx), results[0].text);
  assert.equal(((await tool.execute({ index: 2 }, ctx)) as { status: string }).status, 'error');

  // 整轮取消（或 core 的总时限）中止时，在途转写立即放弃
  const controller = new AbortController();
  const pending = transcribeAttachments(images.slice(0, 2), () => new Promise<string>(() => {}), new Map(), { signal: controller.signal, timeoutMs: 60000 });
  controller.abort();
  assert.deepEqual(await pending, []);
});

test('转写序号按图片在消息中的顺序；续查只恢复本轮写入的转写', () => {
  assert.deepEqual(attachmentImages('纯文字'), []);
  assert.deepEqual(attachmentImages([{ type: 'image_url', image_url: { url: IMG1 } }, { type: 'text', text: '中间的说明' }, { type: 'image_url', image_url: { url: IMG2, detail: 'high' } }]),
    [{ index: 1, url: IMG1 }, { index: 2, url: IMG2, detail: 'high' }]);
  const evidence = (id: string, index: number, turnId: string, content: string): Message => ({ role: 'tool', name: 'read_attachment', tool_call_id: id, turnId, content, evidence: { id: `e_${id}`, observedAt: '', arguments: { index }, outcome: 'success', completeness: 'unknown' } });
  const restored = restoreAttachmentTranscripts([
    evidence('a', 1, 't1', '【附件 1：图片中的文字（模型逐字转写，以原图为准）】\n本轮'),
    evidence('b', 1, 't1', '【重复调用提示】与已读取的内容重复，请推进排查或收尾。\n【附件 1：…】'),
    evidence('c', 2, 't0', '【附件 2：图片中的文字（模型逐字转写，以原图为准）】\n上一轮'),
  ], 't1');
  assert.deepEqual([...restored.entries()], [[1, '【附件 1：图片中的文字（模型逐字转写，以原图为准）】\n本轮']]);
});

test('生产默认转写走调查模型的纯文本调用：jsonMode=false、不传 signal，上游请求里没有 response_format', async () => {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fake-vision', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(chunk({ content: `退票须知\n${QUOTE}` }, null));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,timestamp,user,type,tool_name,model,prompt_tokens,completion_tokens,total_tokens,duration_ms,details,success,error)');
  const previousFormat = process.env.MODEL_JSON_FORMAT;
  process.env.MODEL_JSON_FORMAT = 'json_schema'; // 最容易踩的配置：一旦带上 response_format 就会要求答案结构
  try {
    const port = (server.address() as AddressInfo).port;
    const config = { answerReviewTimeoutMs: 60000, modelCallTimeoutMs: 60000, geminiApiKey: 'test-key-attachment', geminiBaseUrl: `http://127.0.0.1:${port}/v1`, geminiModel: 'fake-vision' } as any;
    // 不注入模型工厂与转写函数：走生产默认路径（BusinessModel + 真实 OpenAI 客户端，上游换成本地假服务）
    const service = new AgentService(new AgentStore(db), config, new AuditLogger(db), { getActive: () => 'gemini' } as any);
    const transcribe = (service as any).imageTranscriber('alice', 'gemini', new AbortController().signal) as ImageTranscriber;
    assert.equal(await transcribe({ index: 1, url: IMG1 }, AbortSignal.timeout(15000)), `退票须知\n${QUOTE}`);
    assert.equal(bodies.length, 1);
    const body = bodies[0];
    assert.equal('response_format' in body, false, '转写调用不能带 response_format');
    assert.equal(body.tools, undefined);
    assert.equal(body.model, 'fake-vision');
    const user = body.messages.find((m: any) => m.role === 'user');
    assert.deepEqual(user.content[1], { type: 'image_url', image_url: { url: IMG1 } });
    assert.match(user.content[0].text, /逐字转写/);
  } finally {
    if (previousFormat === undefined) delete process.env.MODEL_JSON_FORMAT; else process.env.MODEL_JSON_FORMAT = previousFormat;
    db.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
