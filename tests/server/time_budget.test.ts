import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ChatGateway, Message, ModelType, Registry, StreamEvent, ToolDefinition } from '@xkang/agent-core';
import { AgentCore, type RunState } from '@xkang/agent-core';
import { isReminderMessage, messageText } from '@xkang/agent-core/context';
import { AgentStore } from '../../server/src/agent/store.ts';
import { AgentService } from '../../server/src/agent/service.ts';
import { AuditLogger } from '../../server/src/auth.ts';
import { reviewAnswer } from '../../server/src/agent/review.ts';

const tool: ToolDefinition = { name: 'company_db_query', description: 'read', parameters: { type: 'object', properties: {} }, execute: async () => ({ status: 'success' }) };
const toolCall = (id: string): Message => ({ role: 'assistant', content: '', tool_calls: [{ id, name: tool.name, arguments: {} }] });
function coreWith(gateway: ChatGateway, states: RunState[], budget: any) {
  return new AgentCore({ gateway, registry: { getTools: () => [tool], getTool: (n: string) => (n === tool.name ? tool : undefined), getRemoteSkills: () => [], registerLocal() {}, executeTool: async (n: string, args: any) => tool.execute(args, { repoPath: '', localCwd: '' }) } as any, context: { repoPath: '', localCwd: '' }, buildPrompt: () => 'test', budget, onStateChange: state => states.push(state) });
}

test('R2：活跃窗口用尽后在安全点冻结并通知状态', async () => {
  const states: RunState[] = [];
  let calls = 0;
  const gateway: any = { getCurrentModel: () => 'xkang-managed', switchModel() {}, streamChat: async () => (++calls === 1 ? toolCall('c1') : { role: 'assistant', content: '结论' }) };
  const core = coreWith(gateway, states, { activeMs: 1, extensions: 0, turnsPerExtension: 10, reviewsPerExtension: 1 });
  const result = await core.run('查', () => {});
  assert.equal(states.at(-1)?.frozen, true);
  assert.match(result, /尚未得出可靠结论/); // 尚无复核通过的答案时冻结为兜底文本
  assert.ok(calls <= 2, '冻结后不再发起新的模型调用');
});

// 2026-10-27 决策：调用量不再封顶，只按时间限。
// 现网一次工单常要几十轮才把日志/代码取全，撞轮数上限时证据往往正好差最后一段
// （真实回复："此前查询窗口结果达到返回上限未取全"），所以轮数不该是那个闸门。
test('R2：复核次数仍按追加公式封顶（2 → 最多 10）', async () => {
  for (const [extensions, reviews] of [[0, 2], [3, 5], [20, 10]] as const) {
    const states: RunState[] = [];
    const gateway: any = { getCurrentModel: () => 'xkang-managed', switchModel() {}, streamChat: async () => toolCall('c1') };
    // activeMs 取 0 保证第一轮就冻结：这样状态通知一定发生过，不会和毫秒级计时抢跑
    const core = coreWith(gateway, states, { activeMs: 0, extensions, reviewsPerExtension: 1 });
    await core.run('查', () => {});
    assert.ok(states.length > 0, '冻结时应当推送过运行状态');
    assert.equal(states.at(-1)?.reviewAttemptsAllowed, reviews, `extensions=${extensions} reviewAttemptsAllowed`);
  }
});

/** 连续给 toolCalls 次工具调用，之后正常输出结论；顺便记录每次调用拿到的工具数 */
function loopingGateway(toolCalls: number) {
  const counts: number[] = [];
  let n = 0;
  const gateway: any = { getCurrentModel: () => 'xkang-managed', switchModel() {}, streamChat: async (_m: unknown, tools: unknown[]) => {
    counts.push(tools.length); n++;
    return n <= toolCalls ? toolCall('c' + n) : { role: 'assistant', content: '结论' };
  } };
  return { gateway, counts };
}
const reminderTexts = (core: AgentCore) => core.getMessages().filter(isReminderMessage).map(messageText);

test('R2：传了运行预算后 60 轮工具调用仍然照常可用（只按时间限，不再按轮数掐断）', async () => {
  const { gateway, counts } = loopingGateway(60);
  const core = coreWith(gateway, [], { activeMs: 600000, reviewsPerExtension: 1 });
  await core.run('查', () => {});
  assert.equal(counts.length, 61, '60 轮工具 + 1 次收尾');
  assert.equal(counts.every(c => c > 0), true, '前 60 轮都不能被禁用工具');
  assert.equal(reminderTexts(core).some(r => /工具调用次数已经用完/.test(r)), false);
});

test('R2：显式配置 maxTurns 时才恢复轮数上限', async () => {
  const { gateway, counts } = loopingGateway(60);
  const core = coreWith(gateway, [], { activeMs: 600000, maxTurns: 7 });
  await core.run('查', () => {});
  assert.equal(counts[7], 0, '第 8 次调用不再提供工具');
  assert.equal(reminderTexts(core).some(r => /工具调用次数已经用完/.test(r)), true);
});

test('R2：被截止时间取消的复核不消耗配额，记为 aborted_by_deadline', async () => {
  const states: RunState[] = [];
  const draft = { role: 'assistant', content: '{"conclusion":"结论","businessData":[],"evidenceSummary":[],"customerReply":"","pendingItems":[]}' };
  const gateway: any = { getCurrentModel: () => 'xkang-managed', switchModel() {}, streamChat: async () => draft };
  const core = coreWith(gateway, states, { activeMs: 60000, extensions: 0, turnsPerExtension: 10, reviewsPerExtension: 1 });
  (core as any).options.review = async () => { throw new Error('Review deadline exceeded'); };
  await core.run('查', () => {});
  assert.equal(states.at(-1)?.reviewAttempts, 0, '截止取消（抛异常）不计入复核次数');
  assert.equal(states.at(-1)?.abortedByDeadline, true);

  // 真实 reviewAnswer 内部捕获 deadline 并写入 record.diagnostic 返回，同样不得计入复核次数
  const states2: RunState[] = [];
  const core2 = coreWith(gateway, states2, { activeMs: 60000, extensions: 0, turnsPerExtension: 10, reviewsPerExtension: 1 });
  (core2 as any).options.review = async () => ({ accepted: false, text: '兜底', record: { status: 'unavailable', diagnostic: 'Review deadline exceeded' } });
  await core2.run('查', () => {});
  assert.equal(states2.at(-1)?.reviewAttempts, 0, '截止取消（record.diagnostic）不计入复核次数');
  assert.equal(states2.at(-1)?.abortedByDeadline, true);
});

// ---- 服务端：冻结持久化、get 保护、续查、线缆 status ----
class FixtureRegistry implements Registry {
  tools = new Map<string, ToolDefinition>();
  constructor() { this.registerLocal({ name: 'company_db_query', description: 'internal', parameters: { type: 'object', properties: {} }, execute: async () => { await new Promise(resolve => setImmediate(resolve)); return { status: 'success', database: 'billing', columns: ['phone'], rows: [['0013812345678']] }; } }); }
  registerLocal(tool: ToolDefinition) { this.tools.set(tool.name, tool); }
  getTools() { return [...this.tools.values()]; }
  getTool(name: string) { return this.tools.get(name); }
  getRemoteSkills() { return []; }
  async executeTool(name: string, args: Record<string, unknown>) { return this.tools.get(name)!.execute(args, { repoPath: '', localCwd: '' }); }
}
/** 第一轮只调工具（永不给候选，逼出冻结）；continue 之后给候选并通过复核 */
class FreezeModel implements ChatGateway {
  calls = 0;
  frozen = false;
  getCurrentModel(): ModelType { return 'xkang-managed'; }
  switchModel() {}
  async streamChat(messages: Message[], tools: ToolDefinition[], emit: (e: StreamEvent) => void, options?: { signal?: AbortSignal }): Promise<Message> {
    if (options?.signal) {
      const packet = JSON.parse(String(messages[1].content));
      if (packet.stage === 'challenge') return { role: 'assistant', content: JSON.stringify({ checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: [] }) };
      // 15 分钟 tick 会在途工具调用判为超时（not_executed），引文必须指向真正成功的证据
      const source = packet.index.find((i: any) => i.outcome === 'success');
      return { role: 'assistant', content: JSON.stringify({ privacySafe: true, blocks: packet.blocks.map((b: any) => ({ blockId: b.id, kind: 'fact', assessment: 'supported', references: [{ evidenceId: source.id, quote: '0013812345678' }], reason: '记录一致' })), missingEvidence: [] }) };
    }
    if (!this.frozen) return toolCall(`c${++this.calls}`);
    return { role: 'assistant', content: JSON.stringify({ conclusion: '已核实联系电话。', businessData: [{ label: '联系电话', value: '0013812345678' }], evidenceSummary: [], customerReply: '', pendingItems: [] }) };
  }
}
function freezeFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,timestamp,user,type,tool_name,model,prompt_tokens,completion_tokens,total_tokens,duration_ms,details,success,error)');
  const audit = new AuditLogger(db), store = new AgentStore(db);
  const model = new FreezeModel();
  const service = new AgentService(store, { answerReviewTimeoutMs: 60000, modelCallTimeoutMs: 240000, features: { partialPublish: false, timeBudget: true, inputGuard: true, feedbackBinding: false } } as any, audit, { getActive: () => 'gemini' } as any, () => model, () => new FixtureRegistry());
  return { db, store, service, model };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('R2：15 分钟到点冻结——已核实内容保留、run_state 落库、get 不擦除、status 仍三值', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { db, store, service, model } = freezeFixture();
  try {
    const session = store.create('alice');
    const done = new Promise<void>(resolve => service.start('alice', session.id, '核对资料', event => { if (event.type === 'done') resolve(); }));
    for (let i = 0; i < 10; i++) await settle();
    context.mock.timers.tick(15 * 60 * 1000);
    for (let i = 0; i < 10; i++) await settle();
    await done;
    const snapshot = service.get('alice', session.id)!;
    assert.equal(snapshot.frozen, true, '冻结标记保留');
    assert.equal(snapshot.extensions, 0);
    assert.equal(snapshot.status, 'idle', '线缆 status 仍为 idle');
    assert.ok(['idle', 'running', 'waiting_question'].includes(snapshot.status), 'status 只有三个合法值');
    assert.equal(store.loadRunState('alice', session.id)?.runState.frozen, true, 'run_state 已落库');
    assert.equal(service.get('alice', session.id)!.frozen, true, '再次 get 不擦除');
    assert.ok(snapshot.turns[0].answer, '已核实内容（答案）仍在');
  } finally { context.mock.timers.reset(); db.close(); }
});

test('R2：continue 追加 15 分钟——恢复运行、extensions+1、完成后清除冻结', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { db, store, service, model } = freezeFixture();
  try {
    const session = store.create('alice');
    const done = new Promise<void>(resolve => service.start('alice', session.id, '核对资料', event => { if (event.type === 'done') resolve(); }));
    for (let i = 0; i < 10; i++) await settle();
    context.mock.timers.tick(15 * 60 * 1000);
    for (let i = 0; i < 10; i++) await settle();
    await done;
    model.frozen = true;
    const done2 = new Promise<void>(resolve => service.continue('alice', session.id, event => { if (event.type === 'done') resolve(); }));
    for (let i = 0; i < 20; i++) await settle();
    await done2;
    const snapshot = service.get('alice', session.id)!;
    assert.equal(snapshot.frozen, undefined, '完成后冻结标记清除');
    assert.equal(store.loadRunState('alice', session.id), null, 'run_state 已清理');
    assert.equal(snapshot.turns[0].answer?.reviewStatus, 'reviewed', '续查后给出已复核答案');
    assert.equal(service.continue('bob', session.id, () => {}), false, '他人会话不可续查');
  } finally { context.mock.timers.reset(); db.close(); }
});
