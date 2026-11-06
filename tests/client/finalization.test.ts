import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentCore, type Message, type StreamEvent, type ToolDefinition } from '@xkang/agent-core';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { reviewAnswer } from '../../server/src/agent/review.ts';

const tool: ToolDefinition = { name: 'company_db_query', description: 'read', parameters: { type: 'object', properties: {} }, execute: async () => ({ status: 'error', message: 'timeout' }) };
const call = (id: string): Message => ({ role: 'assistant', content: '', tool_calls: [{ id, name: tool.name, arguments: {} }] });
function make(step: (n: number, tools: ToolDefinition[], emit: (e: StreamEvent) => void) => Message, review?: any, options?: any) {
  let n = 0;
  const gateway: any = { getCurrentModel: () => 'xkang-managed', switchModel() {}, streamChat: async (_messages: Message[], tools: ToolDefinition[], emit: (e: StreamEvent) => void) => step(++n, tools, emit) };
  const core = new AgentCore({ gateway, registry: new ToolRegistry([tool]), context: { repoPath: '', localCwd: '' }, buildPrompt: () => 'test', review, repairTools: new Set([tool.name, 'read_tool_result']), ...(options || {}) });
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
  const pending = reviewAnswer(model, draft, [], 1, 'r1', () => {}, { timeoutMs: 60000 });
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
test('无复核服务端形态：只读表述不触发"不能声称操作已执行"，写动作声明仍被拦', async () => {
  // 注册表里没有需审批的动作工具（服务端 8 个只读工具）：派生集合为空，语义与历史硬编码一致
  for (const [text, blocked] of [['我已查询订单状态。', false], ['我已核对完毕。', false], ['我已修改了订单。', true], ['我已执行写入。', true]] as const) {
    const { core, count } = make(() => ({ role: 'assistant', content: text }));
    const result = await core.run('查', () => {});
    if (blocked) { assert.match(result, /尚未确认/); assert.equal(count(), 3); }
    else { assert.equal(result, text); assert.equal(count(), 1); }
  }
});
test('无复核本地形态：写动作声称需有成功执行记录，记录存在才放行', async () => {
  const writeTool: ToolDefinition = { name: 'write_file', description: '写文件', requiresApproval: true, parameters: { type: 'object', properties: {} }, execute: async () => ({ status: 'success' }) };
  const runLocal = async (script: 'claim-only' | 'with-record') => {
    let calls = 0;
    const gateway: any = { getCurrentModel: () => 'xkang-managed', switchModel() {}, streamChat: async () => {
      calls++;
      if (script === 'with-record' && calls === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'write_file', arguments: { filePath: 'a.txt', content: 'x' } }] };
      return { role: 'assistant', content: '我已写入文件。' };
    } };
    const core = new AgentCore({ gateway, registry: new ToolRegistry([writeTool]), context: { repoPath: '', localCwd: '' }, buildPrompt: () => 'test' });
    return core.run('写', event => { if (event.type === 'approval_requested') event.resolve(true); });
  };
  assert.equal(await runLocal('claim-only'), '本次没有取得对应的成功执行记录，操作结果尚未确认。');
  assert.equal(await runLocal('with-record'), '我已写入文件。');
});
test('AgentOptions.turnId 优先：传入时 core 消息的 turnId 与公开回合 ID 一致，未传仍生成 t_ 前缀', async () => {
  const { core } = make(() => ({ role: 'assistant', content: '完成' }));
  await core.run('查', () => {});
  assert.ok(core.getMessages().some(m => m.turnId?.startsWith('t_')), '未传时默认生成');
  const explicit = new AgentCore({ gateway: { getCurrentModel: () => 'xkang-managed', switchModel() {}, streamChat: async () => ({ role: 'assistant', content: '完成' }) } as any, registry: new ToolRegistry([]), context: { repoPath: '', localCwd: '' }, buildPrompt: () => 'test', turnId: 'r_public_trace_id' });
  await explicit.run('查', () => {});
  assert.ok(explicit.getMessages().every(m => !m.turnId || m.turnId === 'r_public_trace_id'), '传入时全部消息使用该 turnId');
});

test('服务端预算：初稿用满 50 轮后被复核打回，仍可用独立只读补查额度修订一次', async () => {
  let n = 0, reviews = 0;
  const toolCounts: number[] = [];
  const gateway: any = { getCurrentModel: () => 'xkang-managed', switchModel() {}, streamChat: async (_m: Message[], tools: ToolDefinition[]) => {
    n++; toolCounts.push(tools.length);
    return tools.length ? call(String(n)) : { role: 'assistant', content: '候选结论' };
  } };
  const core = new AgentCore({
    gateway, registry: new ToolRegistry([tool]), context: { repoPath: '', localCwd: '' }, buildPrompt: () => 'test',
    repairTools: new Set([tool.name, 'read_tool_result']),
    // 这条用例测的是"补查额度"，与"轮数上限"是两个策略；轮数上限现在默认关闭，
    // 所以这里显式给 50 轮，保持原来的场景不变。
    budget: { activeMs: 60 * 60 * 1000, extensions: 0, maxTurns: 50, reviewsPerExtension: 1, repairTurnsPerReview: 4 },
    review: async () => { reviews++; return reviews === 1 ? { accepted: false, retry: true, text: '待人工核实', feedback: '补查关键证据' } : { accepted: true, retry: false, text: '修订稿' }; },
  });
  const result = await core.run('核对状态', () => {});
  assert.equal(n, 56, '50 轮工具 + 1 次初稿 + 4 轮只读补查 + 1 次修订稿');
  assert.equal(reviews, 2);
  assert.equal(result, '修订稿');
  assert.equal(toolCounts.slice(0, 50).every(s => s > 0), true, '前 50 轮可用全部工具');
  assert.equal(toolCounts[50], 0, '初稿阶段工具被关闭');
  assert.equal(toolCounts.slice(51, 55).every(s => s > 0), true, '复核打回后仍有 4 轮只读补查额度');
  assert.equal(toolCounts[55], 0, '补查额度用尽后收尾');
});

test('择优发布：两次复核都把草稿改差时，发布已核实断言更多的那一次', async () => {
  const seen: number[] = [];
  const { core } = make((n) => ({ role: 'assistant', content: n === 1 ? '初稿内容' : '修订后内容' }), async (_candidate: Message, _history: Message[], attempt: number) => {
    seen.push(attempt);
    return attempt === 1
      ? { accepted: false, retry: true, text: '部分一', feedback: '补查关键证据', record: { attempt: 1, status: 'needs_revision', validUnitCount: 5 } }
      : { accepted: false, retry: true, text: '部分二', feedback: '仍缺少依据', record: { attempt: 2, status: 'needs_revision', validUnitCount: 1 } };
  });
  assert.equal(await core.run('核对状态', () => {}), '部分一', '第二次修订反而少核实了 4 条时，不能发布第二次');
  assert.deepEqual(seen, [1, 2], '两次复核都要跑完，择优发生在发布时');
});

test('择优发布：后续复核服务异常时不整体作废，保留上一次已核实的内容', async () => {
  const { core } = make((n) => ({ role: 'assistant', content: n === 1 ? '初稿内容' : '修订后内容' }), async (_candidate: Message, _history: Message[], attempt: number) => {
    if (attempt === 3) throw new Error('复核通道不可用');
    return attempt === 1
      ? { accepted: false, retry: true, text: '部分一', feedback: '补查关键证据', record: { attempt: 1, status: 'needs_revision', validUnitCount: 5 } }
      : { accepted: false, retry: true, text: '部分二', feedback: '仍缺少依据', record: { attempt: 2, status: 'needs_revision', validUnitCount: 1 } };
  }, { budget: { activeMs: 60 * 60 * 1000, extensions: 1, turnsPerExtension: 10, reviewsPerExtension: 1, repairTurnsPerReview: 3 } });
  const result = await core.run('核对状态', () => {});
  assert.equal(result, '部分一', '异常发生在第三次复核时，仍要发布第二次之前已核实更多的第一次');
  const last: any = core.getMessages().at(-1);
  assert.equal(last.review?.validUnitCount, 5, '附带的复核记录要与所发布的草稿一致，不能标成复核未完成');
});
