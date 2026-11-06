import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentCore, type AgentOptions, type Message, type MessageContentPart, type Registry, type SeedToolResult, type StreamEvent, type ToolDefinition } from '@xkang/agent-core';
import { messageText } from '@xkang/agent-core/context';

// AgentCore.seedToolResults：截图转写等"非工具来源"的材料在第一次调用模型前写成真实工具结果，获得 evidence 编号。
const TRANSCRIPT = '【附件 1：图片中的文字（模型逐字转写，以原图为准）】\n退票须知\n超过下午1点半则该天不可退';
const readAttachment: ToolDefinition = { name: 'read_attachment', description: '按序号读取附件转写', parameters: { type: 'object', properties: { index: { type: 'number' } } }, execute: async () => TRANSCRIPT };
const dbTool: ToolDefinition = { name: 'company_db_query', description: 'read', parameters: { type: 'object', properties: {} }, execute: async () => ({ status: 'success', rows: [] }) };

function registryOf(tools: ToolDefinition[]): Registry {
  const map = new Map(tools.map(tool => [tool.name, tool]));
  return { getTools: () => [...map.values()], getTool: name => map.get(name), getRemoteSkills: () => [], registerLocal: tool => { map.set(tool.name, tool); },
    executeTool: async (name, args, context) => map.get(name)!.execute(args, context) };
}

/** 记录每次调用模型时收到的消息；script 决定第 n 次调用的回复（默认直接给结论） */
function harness(options: Partial<AgentOptions> = {}, script?: (n: number) => Message) {
  const calls: Message[][] = [];
  const gateway = { getCurrentModel: () => 'xkang-managed' as const, switchModel() {},
    streamChat: async (messages: Message[]) => { calls.push(messages.map(m => ({ ...m }))); return script ? script(calls.length) : { role: 'assistant' as const, content: '结论' }; } };
  const core = new AgentCore({ gateway, registry: registryOf([readAttachment, dbTool]), context: { repoPath: '', localCwd: '' }, buildPrompt: () => 'test', ...options });
  return { core, calls };
}
const imageInput = (): MessageContentPart[] => [{ type: 'text', text: '看截图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];

test('传入预置钩子：第一次调用模型时，用户消息之后紧跟 assistant tool_calls 与带 evidence 编号的工具结果', async () => {
  const hookInputs: unknown[] = [];
  const { core, calls } = harness({ seedToolResults: async input => { hookInputs.push(input); return [{ name: 'read_attachment', arguments: { index: 1 }, text: TRANSCRIPT }]; } });
  const events: StreamEvent[] = [];
  assert.equal(await core.run(imageInput(), event => events.push(event)), '结论');
  assert.deepEqual(hookInputs, [imageInput()], '钩子拿到的是本轮原始输入');

  const first = calls[0];
  assert.deepEqual(first.map(m => m.role), ['system', 'user', 'assistant', 'tool'], '预置结果必须在第一次调用模型之前、紧跟用户消息');
  const [, user, assistant, tool] = first;
  assert.deepEqual(user.content, imageInput());
  assert.equal(assistant.tool_calls?.length, 1);
  const call = assistant.tool_calls![0];
  assert.equal(call.name, 'read_attachment');
  assert.deepEqual(call.arguments, { index: 1 });
  assert.match(call.id, /^call_[0-9a-f]{24}$/);
  assert.equal(tool.name, 'read_attachment');
  assert.equal(tool.tool_call_id, call.id, 'tool 结果与 tool_calls 成对');
  assert.match(tool.evidence?.id || '', /^e_/);
  assert.equal(tool.evidence?.outcome, 'success');
  assert.deepEqual(tool.evidence?.arguments, { index: 1 });
  assert.ok(messageText(tool).includes('超过下午1点半则该天不可退'));
  assert.ok(messageText(tool).endsWith(`[证据编号: ${tool.evidence!.id}]`), '调查模型能看到这条证据的编号');

  // 写进会话历史的就是这条证据（复核据此建证据索引、核对引文）
  const stored = core.getMessages().filter(m => m.role === 'tool' && m.name === 'read_attachment');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].evidence?.id, tool.evidence!.id);
  assert.equal(stored[0].content, TRANSCRIPT);
  // 与普通工具一样发出开始/结果事件，且开始在前
  const started = events.findIndex(e => e.type === 'tool_call_start' && e.toolCall.id === call.id);
  const finished = events.findIndex(e => e.type === 'tool_call_result' && e.toolCallId === call.id);
  assert.ok(started >= 0 && finished > started);
});

test('预置的调用记入重复识别：模型之后用同样参数再读一次时标注为重复读取', async () => {
  const { core } = harness({ seedToolResults: async () => [{ name: 'read_attachment', arguments: { index: 1 }, text: TRANSCRIPT }] },
    n => n === 1 ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_attachment', arguments: { index: 1 } }] } : { role: 'assistant', content: '结论' });
  await core.run(imageInput(), () => {});
  const reread = core.getMessages().find(m => m.role === 'tool' && m.tool_call_id === 'c1');
  assert.match(messageText(reread!), /^【重复调用提示】/);
  assert.ok(messageText(reread!).includes('超过下午1点半则该天不可退'), '重复读取仍返回原文');
});

test('钩子抛错、超时、返回空或未注册的工具：排查照常完成，第一次调用不带任何预置消息', async () => {
  let abortedOnTimeout = false;
  const variants: Array<NonNullable<AgentOptions['seedToolResults']>> = [
    () => { throw new Error('同步抛错'); },
    async () => { throw new Error('异步抛错'); },
    (_input, { signal }) => new Promise<SeedToolResult[]>(() => { signal.addEventListener('abort', () => { abortedOnTimeout = true; }); }),
    async () => [],
    async () => null as unknown as SeedToolResult[],
    // 历史只能引用注册表里真实存在的工具
    async () => [{ name: 'not_registered_tool', arguments: {}, text: 'x' }],
  ];
  for (const [i, seedToolResults] of variants.entries()) {
    const { core, calls } = harness({ seedToolResults, seedTimeoutMs: 30 });
    assert.equal(await core.run(imageInput(), () => {}), '结论', `第 ${i} 种：排查照常完成`);
    assert.deepEqual(calls[0].map(m => m.role), ['system', 'user'], `第 ${i} 种：没有预置消息`);
    assert.equal(core.getMessages().some(m => m.role === 'tool' || Boolean(m.tool_calls?.length)), false, `第 ${i} 种：历史里没有残留的调用`);
  }
  assert.equal(abortedOnTimeout, true, '超时后通过 signal 中止钩子');
});

test('不传钩子：消息序列与引入前一致', async () => {
  const script = (n: number): Message => n === 1 ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'company_db_query', arguments: {} }] } : { role: 'assistant', content: '结论' };
  const { core, calls } = harness({}, script);
  assert.equal(await core.run(imageInput(), () => {}), '结论');
  assert.deepEqual(calls[0].map(m => [m.role, m.content]), [['system', 'test'], ['user', imageInput()]], '第一次调用只有系统提示和用户消息');
  assert.deepEqual(core.getMessages().map(m => [m.role, m.name ?? null, m.tool_calls?.map(c => c.id) ?? null]), [
    ['system', null, null], ['user', null, null], ['assistant', null, ['c1']], ['tool', 'company_db_query', null], ['assistant', null, null],
  ]);
});
