import { AgentCore } from '@xkang/agent-core';
import { parseDraft } from '../../server/src/agent/draft_publication.ts';

// 离线对照：相同的全失败工具结果 + 相同草稿，只改变是否提供通过格式校验的 review 回调。
// 不触网、不读生产库，不模拟“模型能力”，只核对发布路径。
async function run(formatHook) {
  const result = { status: 'error', message: '模拟查询失败' };
  const tool = { name: 'company_db_query', description: 'fixture', parameters: { type: 'object', properties: {} }, execute: async () => result };
  const draft = JSON.stringify({ answer: { conclusion: '该订单已收款。', businessData: [], evidenceSummary: [], customerReply: '该订单已收款。', pendingItems: [] }, evidenceIds: [] });
  let requests = 0;
  const core = new AgentCore({
    gateway: { getCurrentModel: () => 'xkang-managed', switchModel() {}, streamChat: async () => ++requests === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'fixture-query', name: tool.name, arguments: {} }] }
      : { role: 'assistant', content: draft } },
    registry: { getTools: () => [tool], getTool: name => name === tool.name ? tool : undefined, getRemoteSkills: () => [], registerLocal() {}, executeTool: async () => result },
    context: { repoPath: '', localCwd: '' }, buildPrompt: () => 'offline fixture',
    ...(formatHook ? { review: async candidate => { parseDraft(candidate.content, new Set()); return { accepted: true, text: candidate.content }; } } : {}),
  });
  const answer = await core.run('这个订单收款了吗？', () => {});
  return { requests, answer };
}
console.log(JSON.stringify({ withoutReviewHook: await run(false), withFormatOnlyHook: await run(true) }, null, 2));
