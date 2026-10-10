import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import type { ChatGateway, Message, Registry, StreamEvent, ToolDefinition } from '@xkang/agent-core';
import { AgentStore } from '../../server/src/agent/store.ts';
import { AgentService } from '../../server/src/agent/service.ts';
import { mountAgentRoutes } from '../../server/src/agent/routes.ts';
import { AuditLogger } from '../../server/src/auth.ts';

export const DEMO_ANSWER = { conclusion: '已核对客户资料，当前存在两笔收款记录，退款对应关系仍需核实。', businessData: [
  { label: '姓名', value: '演示客户' }, { label: '联系电话', value: '0013812345678' }, { label: '证件号码', value: '11010119900101001X' },
  { label: '订单号', value: '1530517490084478976' }, { label: '收款金额', value: '81.43 元、81.43 元' }],
  evidenceSummary: ['业务记录显示两次收款，尚未完成退款对应关系核对。'], customerReply: '您好，已核对到两笔收款记录。退款对应情况仍需继续核实，请以核实结果为准。', pendingItems: ['核对退款对应的原收款记录。'] };
class FixtureRegistry implements Registry {
  private tools = new Map<string, ToolDefinition>();
  constructor() {
    this.registerLocal({ name: 'company_db_query', description: 'fixture', parameters: { type: 'object', properties: {} },
      execute: async () => ({ status: 'success', complete: true, database: 'PRIVATE_DATABASE_CANARY', columns: ['private_field_canary'],
        records: ['0013812345678', '11010119900101001X', '1530517490084478976'], source: 'D:/PRIVATE_SOURCE_CANARY/CustomerService.java' }) });
  }
  registerLocal(t: ToolDefinition) { this.tools.set(t.name, t); }
  getTools() { return [...this.tools.values()]; }
  getTool(name: string) { return this.tools.get(name); }
  getRemoteSkills() { return []; }
  async executeTool(name: string, args: Record<string, unknown>) { return this.tools.get(name)!.execute(args, { repoPath: '', localCwd: '' }); }
}
class FixtureModel implements ChatGateway {
  private count = 0;
  getCurrentModel() { return 'xkang-managed' as const; }
  switchModel() {}
  async streamChat(messages: Message[], tools: ToolDefinition[], emit: (event: StreamEvent) => void, options?: { signal?: AbortSignal }): Promise<Message> {
    await new Promise(resolve => setTimeout(resolve, 200));
    if (options?.signal) {
      const packet = JSON.parse(String(messages[1].content)), source = packet.evidence[0];
      if (packet.stage === 'challenge') return { role: 'assistant', content: JSON.stringify({ checkedUnitIds: packet.blocks.map((b: any) => b.id), issues: [] }) };
      return { role: 'assistant', content: JSON.stringify({ privacySafe: true, blocks: packet.blocks.map((block: any) => ({ blockId: block.id, kind: 'fact', assessment: 'supported', references: [{ evidenceId: source.id, quote: '0013812345678' }], reason: '界面测试桩' })), missingEvidence: [] }) };
    }
    emit({ type: 'reasoning_chunk', chunk: 'PRIVATE_REASONING_CANARY' });
    emit({ type: 'content_chunk', chunk: 'PRIVATE_DRAFT_CANARY' });
    if (++this.count === 1) {
      const call = { id: 'c1', name: 'company_db_query', arguments: { sql: 'SELECT * FROM PRIVATE_DATABASE_CANARY.private_table_canary' } };
      emit({ type: 'tool_call_start', toolCall: call });
      return { role: 'assistant', content: '', tool_calls: [call] };
    }
    return { role: 'assistant', content: JSON.stringify(DEMO_ANSWER) };
  }
}
export async function startBusinessFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,timestamp,user,type,tool_name,model,prompt_tokens,completion_tokens,total_tokens,duration_ms,details,success,error)');
  const audit = new AuditLogger(db), store = new AgentStore(db);
  const service = new AgentService(store, {} as any, audit, { getActive: () => 'gemini' } as any, () => new FixtureModel(), () => new FixtureRegistry());
  const app = express(); app.use(express.json());
  app.get('/config/client', (_req, res) => res.json({ businessApiVersion: 1 }));
  mountAgentRoutes(app, service, (req, res, next) => { if (req.headers.authorization !== 'Bearer tok_ui') { res.sendStatus(403); return; } req.user = { token: 'tok_ui', name: '演示客服', subjectId: 'ui' }; next(); }, (_req, res) => { res.sendStatus(403); }, audit);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, token: 'tok_ui',
    stop: async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); } };
}
