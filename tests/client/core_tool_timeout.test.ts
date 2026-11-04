import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentCore, type Message, type ToolDefinition } from '@xkang/agent-core';
import { ToolRegistry } from '../../src/tools/registry.ts';

const hanging: ToolDefinition = { name: 'hanging_tool', description: 'never resolves', parameters: { type: 'object', properties: {} }, execute: () => new Promise(() => {}) };
const failing: ToolDefinition = { name: 'failing_tool', description: 'always throws', parameters: { type: 'object', properties: {} }, execute: async () => { throw new Error('BOOM'); } };

function runWith(tool: ToolDefinition) {
  let n = 0;
  const gateway: any = {
    getCurrentModel: () => 'xkang-managed',
    switchModel() {},
    streamChat: async (_messages: Message[], tools: ToolDefinition[]) =>
      ++n === 1 && tools.length ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: tool.name, arguments: {} }] } : { role: 'assistant', content: '收尾' },
  };
  const core = new AgentCore({ gateway, registry: new ToolRegistry([tool]), context: { repoPath: '', localCwd: '' }, buildPrompt: () => 'test', toolTimeoutMs: 30 });
  return core;
}

test('工具等待超时记为 not_executed，不是 failed（结果未确认，不得当执行失败推断）', async () => {
  const core = runWith(hanging);
  await core.run('查', () => {});
  const toolMessage = core.getMessages().find(m => m.role === 'tool' && m.name === hanging.name);
  assert.equal(toolMessage?.evidence?.outcome, 'not_executed');
  assert.match(String(toolMessage?.content), /超时/);
});

test('工具抛普通异常不误记为 not_executed（守护用例，钉住不回归）', async () => {
  const core = runWith(failing);
  await core.run('查', () => {});
  const toolMessage = core.getMessages().find(m => m.role === 'tool' && m.name === failing.name);
  assert.notEqual(toolMessage?.evidence?.outcome, 'not_executed');
  assert.equal(toolMessage?.evidence?.outcome, 'failed');
  assert.match(String(toolMessage?.content), /BOOM/);
});
