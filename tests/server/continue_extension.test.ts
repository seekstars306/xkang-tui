import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ChatGateway, Message, ModelType, Registry, StreamEvent, ToolDefinition } from '@xkang/agent-core';
import { isReminderMessage, messageText } from '@xkang/agent-core/context';
import { AgentStore } from '../../server/src/agent/store.ts';
import { AgentService } from '../../server/src/agent/service.ts';
import { AuditLogger } from '../../server/src/auth.ts';

/**
 * 续查（人工追加）给的是 15 分钟窗口：服务端 /continue 传给 core 的预算、实际冻结时刻、
 * 模型看到的"人工已追加 N 分钟"提醒三者必须一致。用假模型（只调工具、永不收尾）+ 假时钟跑。
 */

const MIN = 60 * 1000;

class FixtureRegistry implements Registry {
  tools = new Map<string, ToolDefinition>();
  constructor() { this.registerLocal({ name: 'company_db_query', description: 'internal', parameters: { type: 'object', properties: {} }, execute: async () => { await new Promise(resolve => setImmediate(resolve)); return { status: 'success', rows: [['ok']] }; } }); }
  registerLocal(tool: ToolDefinition) { this.tools.set(tool.name, tool); }
  getTools() { return [...this.tools.values()]; }
  getTool(name: string) { return this.tools.get(name); }
  getRemoteSkills() { return []; }
  async executeTool(name: string, args: Record<string, unknown>) { return this.tools.get(name)!.execute(args, { repoPath: '', localCwd: '' }); }
}

/** 永远只调工具：只有活跃窗口用尽才会停（冻结） */
class ToolLoopModel implements ChatGateway {
  calls = 0;
  getCurrentModel(): ModelType { return 'xkang-managed'; }
  switchModel() {}
  async streamChat(_messages: Message[], _tools: ToolDefinition[], _emit: (e: StreamEvent) => void): Promise<Message> {
    return { role: 'assistant', content: '', tool_calls: [{ id: `c${++this.calls}`, name: 'company_db_query', arguments: { n: this.calls } }] };
  }
}

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,timestamp,user,type,tool_name,model,prompt_tokens,completion_tokens,total_tokens,duration_ms,details,success,error)');
  const audit = new AuditLogger(db), store = new AgentStore(db);
  const model = new ToolLoopModel();
  const service = new AgentService(store, { answerReviewTimeoutMs: 60000, modelCallTimeoutMs: 240000, features: { partialPublish: false, timeBudget: true, inputGuard: true, feedbackBinding: false } } as any, audit, { getActive: () => 'gemini' } as any, () => model, () => new FixtureRegistry());
  return { db, store, service };
}
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

/** 首轮跑到 15 分钟冻结 */
async function freeze(context: any, service: AgentService, id: string) {
  const done = new Promise<void>(resolve => service.start('alice', id, '核对资料', event => { if (event.type === 'done') resolve(); }));
  await settle();
  context.mock.timers.tick(15 * MIN);
  await settle();
  await done;
  assert.equal(service.get('alice', id)!.frozen, true, '首轮到点冻结');
}

test('续查追加 15 分钟：预算 15 分钟 / 轮数 30 / 收尾 3 分钟；6 分钟时仍在跑，满 15 分钟才再次冻结；提醒写 15 分钟', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { db, store, service } = fixture();
  try {
    const session = store.create('alice');
    await freeze(context, service, session.id);

    let finished = false;
    const done = new Promise<void>(resolve => service.continue('alice', session.id, event => { if (event.type === 'done') { finished = true; resolve(); } }));
    await settle();
    const core = (service as any).runs.get(session.id)?.core;
    assert.ok(core, '续查已开始');
    const budget = core.options.budget;
    assert.equal(budget.activeMs, 15 * MIN, '续查窗口 15 分钟');
    assert.equal(budget.turnsPerExtension, 30, '轮数按比例 30');
    assert.equal(budget.wrapUpMs, 180000, '收尾与首轮一致：截止前 3 分钟');
    assert.equal(budget.extensions, 1);

    const reminders = core.getMessages().filter(isReminderMessage).map(messageText);
    assert.ok(reminders.some((r: string) => r.includes('人工已追加 15 分钟活跃预算（第 1 次追加）')), '模型看到的提醒写 15 分钟');
    assert.ok(!reminders.some((r: string) => r.includes('人工已追加 5 分钟')));

    // 旧的 5 分钟窗口在这里就冻结了；15 分钟窗口下应该还在跑（也还没进入收尾）
    context.mock.timers.tick(6 * MIN);
    await settle(20);
    assert.equal(finished, false, '续查 6 分钟时仍在运行');
    assert.equal(service.get('alice', session.id)!.status, 'running');

    context.mock.timers.tick(9 * MIN);
    await settle(20);
    await done;
    const state = store.loadRunState('alice', session.id)?.runState;
    assert.equal(state?.frozen, true, '满 15 分钟再次冻结');
    assert.equal(state?.activeMs, 15 * MIN, '落库的窗口是 15 分钟');
    assert.equal(state?.extensions, 1);
    assert.equal(service.get('alice', session.id)!.extensions, 1);
  } finally { context.mock.timers.reset(); db.close(); }
});

test('续查带客服补充：补充作为真实输入进会话（不是提醒），提醒文字跟在后面', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { db, store, service } = fixture();
  try {
    const session = store.create('alice');
    await freeze(context, service, session.id);
    const done = new Promise<void>(resolve => service.continue('alice', session.id, event => { if (event.type === 'done') resolve(); }, [{ type: 'text', text: '【客服补充】客户说昨天已经转账了' }]));
    await settle();
    const messages: Message[] = (service as any).runs.get(session.id).core.getMessages();
    const input = messages.find(m => m.role === 'user' && messageText(m).includes('客户说昨天已经转账了'));
    assert.ok(input, '补充进了会话');
    assert.equal(isReminderMessage(input!), false, '补充不能被当成提醒（压缩时会被丢）');
    assert.ok(messageText(input!).indexOf('客户说昨天已经转账了') < messageText(input!).indexOf('人工已追加 15 分钟'), '补充在前、提醒在后');
    context.mock.timers.tick(15 * MIN);
    await settle(20);
    await done;
  } finally { context.mock.timers.reset(); db.close(); }
});
