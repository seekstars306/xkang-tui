import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ChatGateway, Message, ModelType, Registry, StreamEvent, ToolDefinition } from '@xkang/agent-core';
import { AppDatabase } from '../../server/src/db.ts';
import { FeedbackManager } from '../../server/src/feedback_manager.ts';
import { AgentStore } from '../../server/src/agent/store.ts';
import { AgentService } from '../../server/src/agent/service.ts';
import { AuditLogger } from '../../server/src/auth.ts';

function tempDb(): { db: DatabaseSync; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-fb-'));
  // 用 AppDatabase 建完整 schema（含 R4 新列迁移），写入口径与生产一致；遗留文件只读导入，不碰生产库
  const app = new AppDatabase({ dbPath: path.join(dir, 'xkang.db') });
  return { db: app.db, cleanup: () => { try { app.db.close(); } catch { /* 已关闭 */ } fs.rmSync(dir, { recursive: true, force: true }); } };
}

function managerWith(db: DatabaseSync): FeedbackManager {
  return new FeedbackManager(db);
}

test('R4：反馈绑定 turnId 后同 (session, turn, user) 重复提交幂等', () => {
  const { db, cleanup } = tempDb();
  try {
    const manager = managerWith(db);
    const base = { userName: '客服专员', feedbackType: '排障异常反馈', content: '答案把应收说成实收', sessionId: 's1', turnId: 'r_turn_1' };
    const first = manager.createFeedback(base);
    const second = manager.createFeedback({ ...base, content: '答案把应收说成实收（补充）' });
    assert.equal(first.id, second.id, '重复提交返回同一条记录');
    assert.equal(second.content, first.content, '不覆盖首次内容');
    assert.equal(manager.listFeedbacks().length, 1);
    // 未带 turnId 的旧调用不去重（基线行为）
    manager.createFeedback({ userName: '客服专员', feedbackType: '排障异常反馈', content: '旧式反馈', sessionId: 's1' });
    manager.createFeedback({ userName: '客服专员', feedbackType: '排障异常反馈', content: '旧式反馈 again', sessionId: 's1' });
    assert.equal(manager.listFeedbacks().length, 3);
    // 不同 turnId 不去重
    manager.createFeedback({ ...base, turnId: 'r_turn_2' });
    assert.equal(manager.listFeedbacks().length, 4);
  } finally { cleanup(); }
});

test('R4：turnId/answerId/verdict 落库并可在列表读回', () => {
  const { db, cleanup } = tempDb();
  try {
    const manager = managerWith(db);
    manager.createFeedback({ userName: '客服专员', feedbackType: '排障异常反馈', content: '否决', sessionId: 's1', turnId: 'r_turn_9', answerId: 'r_turn_9', verdict: '否决' });
    const [record] = manager.listFeedbacks();
    assert.equal(record.turnId, 'r_turn_9');
    assert.equal(record.answerId, 'r_turn_9');
    assert.equal(record.verdict, '否决');
  } finally { cleanup(); }
});

test('R4：旧库平滑加列（无 turn_id 的 cs_feedbacks 升级不丢数据）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-fb-migrate-'));
  try {
    const dbPath = path.join(dir, 'xkang.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE cs_feedbacks (id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), user_name TEXT NOT NULL, user_token TEXT, feedback_type TEXT NOT NULL, content TEXT NOT NULL, session_id TEXT, session_title TEXT, context JSON, status TEXT NOT NULL DEFAULT 'pending', resolution_notes TEXT)`);
    legacy.prepare('INSERT INTO cs_feedbacks (id, user_name, feedback_type, content) VALUES (?, ?, ?, ?)').run('fb_old', '客服专员', '排障异常反馈', '历史反馈');
    legacy.close();
    const app = new AppDatabase({ dbPath });
    try {
      const columns = app.db.prepare('PRAGMA table_info(cs_feedbacks)').all().map((c: any) => c.name);
      for (const column of ['turn_id', 'answer_id', 'verdict']) assert.ok(columns.includes(column), `缺少列 ${column}`);
      const manager = new FeedbackManager(app.db);
      const rows = manager.listFeedbacks();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 'fb_old');
      assert.equal(rows[0].content, '历史反馈', '历史数据不丢');
      manager.createFeedback({ userName: '客服专员', feedbackType: '排障异常反馈', content: '新反馈', sessionId: 's1', turnId: 'r_1', verdict: '修改' });
      assert.equal(manager.listFeedbacks().length, 2);
    } finally { app.db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R4：feedbackContext 只取被反馈回合的私有消息并脱敏', async () => {
  const { db, cleanup } = tempDb();
  try {
    const credentialResult = JSON.stringify({ status: 'success', database: 'billing', columns: ['password'], rows: [['hardcoded123']] });
    class TestRegistry implements Registry {
      tools = new Map<string, ToolDefinition>();
      constructor() { this.registerLocal({ name: 'company_db_query', description: 'internal', parameters: { type: 'object', properties: {} }, execute: async () => credentialResult }); }
      registerLocal(tool: ToolDefinition) { this.tools.set(tool.name, tool); }
      getTools() { return [...this.tools.values()]; }
      getTool(name: string) { return this.tools.get(name); }
      getRemoteSkills() { return []; }
      async executeTool(name: string, args: Record<string, unknown>) { return this.tools.get(name)!.execute(args, { repoPath: '', localCwd: '' }); }
    }
    class TwoTurnModel implements ChatGateway {
      calls = 0;
      getCurrentModel(): ModelType { return 'xkang-managed'; }
      switchModel() {}
      async streamChat(_messages: Message[], tools: ToolDefinition[], emit: (e: StreamEvent) => void): Promise<Message> {
        if (++this.calls === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 'call1', name: 'company_db_query', arguments: {} }] };
        return { role: 'assistant', content: '{"conclusion":"第一轮结论","businessData":[],"evidenceSummary":[],"customerReply":"","pendingItems":[]}' };
      }
    }
    const audit = new AuditLogger(db), store = new AgentStore(db);
    const sharedModel = new TwoTurnModel(); // 跨回合共享：第二轮不再触发工具调用
    const service = new AgentService(store, { answerReviewTimeoutMs: 180000, modelCallTimeoutMs: 240000 } as any, audit, { getActive: () => 'gemini' } as any, () => sharedModel, () => new TestRegistry());
    const session = store.create('alice');
    const done = new Promise<void>(resolve => service.start('alice', session.id, '第一轮问题', event => { if (event.type === 'done') resolve(); }));
    await done;
    const firstTurnId = store.load('alice', session.id)!.public.turns[0].id;
    // 第二轮：无工具调用，直接给结论
    const done2 = new Promise<void>(resolve => service.start('alice', session.id, '第二轮问题', event => { if (event.type === 'done') resolve(); }));
    await done2;
    const secondTurnId = store.load('alice', session.id)!.public.turns[1].id;
    assert.notEqual(firstTurnId, secondTurnId);

    const first = service.feedbackContext('alice', session.id, firstTurnId)! as any[];
    const second = service.feedbackContext('alice', session.id, secondTurnId)! as any[];
    assert.ok(first.some(m => m.role === 'user' && String(m.content).includes('第一轮问题')), '第一轮含用户问题');
    assert.ok(first.some(m => m.role === 'tool'), '第一轮含工具结果');
    assert.ok(!first.some(m => String(m.content).includes('第二轮问题')), '第一轮不含第二轮内容');
    assert.ok(second.some(m => String(m.content).includes('第二轮问题')));
    assert.ok(!second.some(m => m.role === 'tool'), '第二轮无工具结果');
    // 脱敏：工具结果里的凭据值不进入反馈上下文
    assert.equal(JSON.stringify(first).includes('hardcoded123'), false);
    assert.ok(JSON.stringify(first).includes('***REDACTED:password***'));
    // 未传 turnId 时取最后一轮；他人会话不可见
    assert.ok((service.feedbackContext('alice', session.id)! as any[]).some(m => String(m.content).includes('第二轮问题')));
    assert.equal(service.feedbackContext('bob', session.id), null);
  } finally { cleanup(); }
});
