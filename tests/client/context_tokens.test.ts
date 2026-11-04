import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, ToolDefinition } from '@xkang/agent-core';
import { AgentCore } from '@xkang/agent-core';

// 跨框架对照要求各框架上下文上限一致：xkang 的压缩阈值可通过 contextTokens 设定（缺省 140000）。
// 这里守住接线：阈值必须真的传到请求投影的压缩里。
const big = 'x'.repeat(15000);
const tool: ToolDefinition = { name: 'company_db_query', description: 'read', parameters: { type: 'object', properties: {} }, execute: async () => big };
async function lastCallChars(contextTokens?: number) {
  let calls = 0; let last = 0;
  const gateway: any = { getCurrentModel: () => 'm', switchModel() {}, streamChat: async (messages: Message[]) => {
    // 只量真正发给模型的 content（压缩时原文挪进 raw_tool_result 备查，不随请求发送）
    calls++; last = messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0);
    // 20 次查询后给结论：压缩第一步保留最近 16 条工具结果，前 4 条才可被压缩；20 条约 12 万 token，低于默认阈值 14 万
    return calls <= 20 ? { role: 'assistant', content: '', tool_calls: [{ id: 'c' + calls, name: tool.name, arguments: { n: calls } }] } : { role: 'assistant', content: '结论' };
  } };
  const registry: any = { getTools: () => [tool], getTool: (n: string) => (n === tool.name ? tool : undefined), getRemoteSkills: () => [], registerLocal() {}, executeTool: async () => big };
  const core = new AgentCore({ gateway, registry, context: { repoPath: '', localCwd: '' }, buildPrompt: () => 'sys', ...(contextTokens ? { contextTokens } : {}) });
  await core.run('查', () => {});
  return last;
}

test('contextTokens 传到请求投影的压缩：阈值调小时请求变小，不设时与默认一致', async () => {
  const dflt = await lastCallChars();
  const small = await lastCallChars(8000);
  const huge = await lastCallChars(1048576);
  assert.ok(small < dflt, `阈值 8000 时应压缩：${small} < ${dflt}`);
  assert.equal(huge, dflt, '默认阈值下没有压缩的会话，调大阈值后请求不变');
});
