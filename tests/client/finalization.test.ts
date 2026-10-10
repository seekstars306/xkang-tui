import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentCore, type Message, type StreamEvent, type ToolDefinition } from '@xkang/agent-core';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { reviewAnswer } from '../../server/src/agent/review.ts';

const tool: ToolDefinition = { name: 'company_db_query', description: 'read', parameters: { type: 'object', properties: {} }, execute: async () => ({ status: 'error', message: 'timeout' }) };
const call = (id: string): Message => ({ role: 'assistant', content: '', tool_calls: [{ id, name: tool.name, arguments: {} }] });
function make(step: (n: number, tools: ToolDefinition[], emit: (e: StreamEvent) => void) => Message, review?: any) {
  let n = 0;
  const gateway: any = { getCurrentModel: () => 'xkang-managed', switchModel() {}, streamChat: async (_messages: Message[], tools: ToolDefinition[], emit: (e: StreamEvent) => void) => step(++n, tools, emit) };
  const core = new AgentCore({ gateway, registry: new ToolRegistry([tool]), context: { repoPath: '', localCwd: '' }, buildPrompt: () => 'test', review, repairTools: new Set([tool.name, 'read_tool_result']) });
  return { core, count: () => n };
}
test('仅推理、流中断和截断均不能发布候选文字，结束事件恰好一次', async () => {
  for (const kind of ['reasoning', 'interrupt', 'truncated']) {
    const events: StreamEvent[] = [];
    const { core } = make((_n, _tools, emit) => {
      emit({ type: 'content_chunk', chunk: 'PRIVATE_DRAFT' });
      if (kind === 'interrupt') throw new Error('PRIVATE_ERROR_PATH');
      return { role: 'assistant', content: kind === 'truncated' ? 'PRIVATE_DRAFT' : '', reasoning_content: 'PRIVATE_REASONING', ...(kind === 'truncated' ? { finishReason: 'length' } : {}) };
    });
    await core.run('核对状态', e => events.push(e));
    assert.equal(events.filter(e => e.type === 'done').length, 1);
    assert.equal(JSON.stringify(events).includes('PRIVATE_'), false);
    assert.equal(core.getMessages().at(-1)?.role, 'assistant');
  }
});
test('强制总结也要复核，所有查询失败不能从预算出口放行结清断言', async () => {
  let reviewed = 0;
  const events: StreamEvent[] = [];
  const { core, count } = make((n, tools) => tools.length ? call(String(n)) : { role: 'assistant', content: '已结清' }, async () => {
    reviewed++; return { accepted: false, retry: true, text: '待人工核实', feedback: '没有成功的业务证据' };
  });
  assert.equal(await core.run('核对状态', e => events.push(e)), '待人工核实');
  assert.equal(reviewed, 2); assert.equal(count(), 52);
  assert.equal(events.some(e => e.type === 'content_chunk' && e.chunk.includes('已结清')), false);
});
test('补查最多三轮；读工具预算和最终发布次数受控', async () => {
  const enabled: number[] = []; let reviews = 0;
  const { core, count } = make((n, tools) => {
    enabled.push(tools.length);
    return n === 1 || !tools.length ? { role: 'assistant', content: '候选结论' } : call(String(n));
  }, async () => ({ accepted: false, retry: true, text: '仍需核实', feedback: '补查关键证据', record: { attempt: ++reviews } }));
  const events: StreamEvent[] = [];
  assert.equal(await core.run('查', e => events.push(e)), '仍需核实');
  assert.equal(count(), 5); assert.equal(reviews, 2); assert.equal(enabled.at(-1), 0);
  assert.equal(events.filter(e => e.type === 'done').length, 1);
});
test('独立复核超时降级，不释放未复核的候选内容', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const model: any = { streamChat: () => new Promise(() => {}) };
  const draft = { role: 'assistant' as const, content: JSON.stringify({ conclusion: '业务已恢复', businessData: [], evidenceSummary: [], customerReply: '', pendingItems: [] }) };
  const pending = reviewAnswer(model, draft, [], 1, 'r1', () => {});
  context.mock.timers.tick(60000);
  const decision = await pending;
  assert.equal(decision.accepted, false); assert.equal(decision.retry, undefined);
  assert.doesNotMatch(decision.text, /业务已恢复/);
  context.mock.timers.reset();
});
test('本机助手仍须有执行记录，不能凭文字声称命令成功', async () => {
  const { core, count } = make(() => ({ role: 'assistant', content: '我已经执行命令并修改了文件。' }));
  const events: StreamEvent[] = [];
  const result = await core.run('执行操作', event => events.push(event));
  assert.match(result, /尚未确认/); assert.equal(count(), 3);
  assert.equal(events.some(event => event.type === 'content_chunk' && event.chunk.includes('我已经执行')), false);
});
