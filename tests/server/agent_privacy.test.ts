import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import type { ChatGateway, Message, ModelType, Registry, StreamEvent, ToolDefinition } from '@xkang/agent-core';
import { AgentStore } from '../../server/src/agent/store.ts';
import { AgentService } from '../../server/src/agent/service.ts';
import { mountAgentRoutes } from '../../server/src/agent/routes.ts';
import { AuditLogger } from '../../server/src/auth.ts';
import { validateReview, evidenceContainsQuote } from '../../server/src/agent/review.ts';
import { browserSession } from '../../src/business_web_server.ts';

const draft = { conclusion: '已核对客户资料。', businessData: [{ label: '联系电话', value: '0013812345678' }, { label: '证件号码', value: '11010119900101001X' }, { label: '订单号', value: '1530517490084478976' }], evidenceSummary: ['业务资料已有记录。'], customerReply: '资料已经核对。', pendingItems: [] };
const privateResult = JSON.stringify({ status: 'success', complete: true, database: 'developer_private_db', columns: ['developer_customer_key'], rows: [['0013812345678', '11010119900101001X', '1530517490084478976']], privateNote: 'INTERNAL_CANARY' });
class TestRegistry implements Registry {
  tools = new Map<string, ToolDefinition>();
  constructor() { this.registerLocal({ name: 'company_db_query', description: 'internal', parameters: { type: 'object', properties: {} }, execute: async () => privateResult }); }
  registerLocal(tool: ToolDefinition) { this.tools.set(tool.name, tool); }
  getTools() { return [...this.tools.values()]; }
  getTool(name: string) { return this.tools.get(name); }
  getRemoteSkills() { return []; }
  async executeTool(name: string, args: Record<string, unknown>) { return this.tools.get(name)!.execute(args, { repoPath: '', localCwd: '' }); }
}
class TestModel implements ChatGateway {
  calls = 0;
  getCurrentModel(): ModelType { return 'xkang-managed'; }
  switchModel() {}
  async streamChat(messages: Message[], tools: ToolDefinition[], emit: (event: StreamEvent) => void, options?: { signal?: AbortSignal }): Promise<Message> {
    if (options?.signal) {
      assert.equal(tools.length, 0);
      const packet = JSON.parse(String(messages[1].content));
      if (packet.stage === 'challenge') return { role: 'assistant', content: JSON.stringify({ checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: [] }) };
      const source = packet.evidence[0];
      return { role: 'assistant', content: JSON.stringify({ privacySafe: true, blocks: packet.blocks.map((b: any) => ({ blockId: b.id, kind: 'fact', assessment: 'supported', references: [{ evidenceId: source.id, quote: '0013812345678' }], reason: '记录一致' })), missingEvidence: [] }) };
    }
    emit({ type: 'reasoning_chunk', chunk: 'PRIVATE_REASONING_CANARY' });
    emit({ type: 'content_chunk', chunk: 'RAW_DRAFT_CANARY' });
    if (++this.calls === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 'call1', name: 'company_db_query', arguments: { sql: 'SELECT * FROM developer_private_db.internal_table' } }] };
    return { role: 'assistant', content: JSON.stringify(draft) };
  }
}
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,timestamp,user,type,tool_name,model,prompt_tokens,completion_tokens,total_tokens,duration_ms,details,success,error)');
  const audit = new AuditLogger(db), store = new AgentStore(db);
  const service = new AgentService(store, {} as any, audit, { getActive: () => 'gemini' } as any, () => new TestModel(), () => new TestRegistry());
  return { db, audit, store, service };
}
test('service emits only public DTOs and preserves all necessary business identifiers', async () => {
  const { db, service, store } = fixture();
  try {
    const session = store.create('alice'), events: any[] = [];
    await new Promise<void>(resolve => service.start('alice', session.id, '核对客户资料', event => { events.push(event); if (event.type === 'done') resolve(); }));
    const snapshot = service.get('alice', session.id)!;
    const wire = JSON.stringify({ events, snapshot, browser: browserSession(snapshot) });
    for (const secret of ['developer_private_db', 'developer_customer_key', 'INTERNAL_CANARY', 'PRIVATE_REASONING_CANARY', 'RAW_DRAFT_CANARY', 'SELECT', 'raw_tool_result', 'reasoning_content']) assert.equal(wire.includes(secret), false, secret);
    for (const value of ['0013812345678', '11010119900101001X', '1530517490084478976']) assert.ok(wire.includes(value));
    assert.equal(snapshot.turns[0].answer?.reviewStatus, 'reviewed');
    assert.equal(events.filter(e => e.type === 'answer').length, 1);
    assert.equal(events.filter(e => e.type === 'done').length, 1);
    assert.ok(JSON.stringify(store.adminRead(session.id)).includes('INTERNAL_CANARY'));
    assert.equal(service.get('bob', session.id), null);
    assert.equal(service.remove('bob', session.id), false);
  } finally { db.close(); }
});

test('业务服务将配置的高思考总预算传入复核，60秒后的合法答案仍可发布', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { db, store, audit } = fixture();
  let reviewStarted!: () => void;
  const started = new Promise<void>(resolve => { reviewStarted = resolve; });
  class SlowReviewModel extends TestModel {
    delayed = false;
    async streamChat(messages: Message[], tools: ToolDefinition[], emit: (event: StreamEvent) => void, options?: { signal?: AbortSignal }): Promise<Message> {
      if (options?.signal && !this.delayed) {
        this.delayed = true; reviewStarted();
        await new Promise(resolve => setTimeout(resolve, 70000));
      }
      return super.streamChat(messages, tools, emit, options);
    }
  }
  const service = new AgentService(store, { answerReviewTimeoutMs: 180000 } as any, audit, { getActive: () => 'gemini' } as any, () => new SlowReviewModel(), () => new TestRegistry());
  try {
    const session = store.create('alice');
    const done = new Promise<void>(resolve => service.start('alice', session.id, '核对资料', event => { if (event.type === 'done') resolve(); }));
    await started; context.mock.timers.tick(70000); await done;
    assert.equal(service.get('alice', session.id)!.turns[0].answer?.reviewStatus, 'reviewed');
  } finally { context.mock.timers.reset(); db.close(); }
});
test('HTTP owner checks and public history cannot be bypassed by body owner fields', async () => {
  const { db, service, audit } = fixture();
  const app = express(); app.use(express.json());
  mountAgentRoutes(app, service, (req, res, next) => { const owner = req.headers.authorization; if (!owner) { res.sendStatus(401); return; } req.user = { token: owner, name: owner, subjectId: owner }; next(); }, (_req, res) => { res.sendStatus(403); }, audit);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const session: any = await (await fetch(url + '/agent/sessions', { method: 'POST', headers: { Authorization: 'alice' } })).json();
    for (const method of ['GET', 'DELETE']) assert.equal((await fetch(url + `/agent/sessions/${session.id}`, { method, headers: { Authorization: 'bob' } })).status, 404);
    const response = await fetch(url + `/agent/sessions/${session.id}/messages`, { method: 'POST', headers: { Authorization: 'alice', 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '核对资料', owner: 'bob' }) });
    const body = await response.text(); assert.ok(body.includes('0013812345678')); assert.ok(!body.includes('INTERNAL_CANARY')); assert.ok(!body.includes('private_db'));
    assert.equal((await fetch(url + `/admin/agent/sessions/${session.id}`, { headers: { Authorization: 'alice' } })).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
});
test('客户端断开后可恢复待回答问题，其他员工不能作答，结束仅持久化一次', async () => {
  const { db, store, audit } = fixture();
  const registry = new TestRegistry();
  registry.registerLocal({ name: 'ask_user_question', description: '业务澄清', parameters: { type: 'object', properties: {} }, execute: async () => '' });
  class QuestionModel extends TestModel {
    asked = false;
    async streamChat(messages: Message[], tools: ToolDefinition[], emit: (event: StreamEvent) => void, options?: { signal?: AbortSignal }): Promise<Message> {
      if (!options?.signal && !this.asked) {
        this.asked = true;
        return { role: 'assistant', content: '', tool_calls: [{ id: 'question1', name: 'ask_user_question', arguments: { questions: [{ question: '请确认要核对的业务范围' }] } }] };
      }
      return super.streamChat(messages, tools, emit, options);
    }
  }
  const service = new AgentService(store, {} as any, audit, { getActive: () => 'gemini' } as any, () => new QuestionModel(), () => registry);
  try {
    const session = store.create('alice');
    let resolveQuestion!: () => void;
    const questionReady = new Promise<void>(resolve => { resolveQuestion = resolve; });
    const disconnect = service.start('alice', session.id, '核对资料', event => { if (event.type === 'question') resolveQuestion(); });
    await questionReady; disconnect();
    const pending = service.get('alice', session.id)!;
    assert.equal(pending.status, 'waiting_question');
    const qid = pending.pendingQuestion!.id;
    assert.equal(service.answerQuestion('bob', session.id, qid, '全部'), false);
    assert.equal(service.answerQuestion('alice', session.id, qid, '全部'), true);
    assert.equal(service.answerQuestion('alice', session.id, qid, '再次提交'), false);
    for (let i = 0; i < 100 && service.get('alice', session.id)!.status !== 'idle'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const final = service.get('alice', session.id)!;
    assert.equal(final.status, 'idle'); assert.equal(final.pendingQuestion, undefined);
    assert.equal(final.turns.length, 1); assert.equal(final.turns[0].answer?.reviewStatus, 'reviewed');
    assert.deepEqual(store.load('alice', session.id)!.public, final);
  } finally { db.close(); }
});
test('review cannot approve absent quotations or omit answer paragraphs', () => {
  const report: any = { privacySafe: true, blocks: [{ blockId: 'conclusion', assessment: 'supported', kind: 'fact', references: [{ evidenceId: 'missing', quote: 'invented' }], reason: '' }], missingEvidence: [] };
  const issues = validateReview(report, draft, []);
  assert.ok(issues.some(x => /覆盖/.test(x))); assert.ok(issues.some(x => /无效/.test(x)));
});
test('JSON转义后的原始字段可作为引文，但不能把改写或归纳当原文', () => {
  const source: Message = { role: 'tool', content: JSON.stringify({ rows: [['供应商返回："申请失败"\n请核实状态']] }) };
  assert.equal(evidenceContainsQuote(source, '供应商返回："申请失败"\n请核实状态'), true);
  assert.equal(evidenceContainsQuote(source, '供应商网络故障导致失败'), false);
});
test('源码工具附加行号不影响连续引文，但不能跨省略范围或改写源文', () => {
  const source: Message = { role: 'tool', name: 'read_file_lines', content: '文件：Example.java\n10: /** 业务金额 */\n11: private BigDecimal amount;\n--\n30: return amount;' };
  assert.equal(evidenceContainsQuote(source, '/** 业务金额 */\nprivate BigDecimal amount;'), true);
  assert.equal(evidenceContainsQuote(source, 'private BigDecimal amount;\nreturn amount;'), false);
  assert.equal(evidenceContainsQuote(source, '/** 已付款金额 */'), false);
  assert.equal(evidenceContainsQuote({ ...source, name: 'company_db_query' }, '/** 业务金额 */\nprivate BigDecimal amount;'), false);
  assert.equal(evidenceContainsQuote({ role: 'tool', name: 'search_code', content: '12- //限制\n13: if (blocked) return;\n--\n20: allow();' }, '//限制\n if (blocked) return;'), true);
});
test('migration is idempotent, private history is not returned, mismatch never overwrites', () => {
  const { db, store, service } = fixture();
  try {
    const source = { messages: [{ role: 'user' as const, content: '电话0013812345678的资料核对' }, { role: 'tool' as const, content: privateResult }, { role: 'assistant' as const, content: 'SELECT * FROM developer_private_db.internal_table' }] };
    const hash = AgentStore.hash(source);
    const a = service.migrate('alice', 'legacy1', hash, source), b = service.migrate('alice', 'legacy1', hash, source);
    assert.equal(a.session.id, b.session.id);
    assert.equal(JSON.stringify(a).includes('developer_private_db'), false);
    assert.ok(JSON.stringify(a).includes('0013812345678'));
    assert.throws(() => service.migrate('alice', 'legacy1', 'bad', source));
    assert.ok(JSON.stringify(store.adminRead(a.session.id)).includes('developer_private_db'));
  } finally { db.close(); }
});
test('迁移保留可明确区分的历史业务信息，完整电话证件仍为未复核状态', () => {
  const { db, service } = fixture();
  try {
    const source = { messages: [{ role: 'user' as const, content: '核对客户资料' }, { role: 'assistant' as const, content: '联系电话：0013812345678；证件号码：11010119900101001X。' }] };
    const result = service.migrate('alice', 'business-only', AgentStore.hash(source), source);
    assert.ok(JSON.stringify(result.session).includes('0013812345678'));
    assert.ok(JSON.stringify(result.session).includes('11010119900101001X'));
    assert.equal(result.session.turns[0].answer?.reviewStatus, 'unreviewed');
  } finally { db.close(); }
});
