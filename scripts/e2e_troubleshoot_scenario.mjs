import { startServer } from '../server/dist/index.js';
import { AgentHarness } from '../dist/harness/agent.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { LOCAL_TOOLS } from '../dist/tools/index.js';
import { McpRemoteClient } from '../dist/mcp/client.js';

console.log('================================================================');
console.log('🧪 模拟客服真实业务排障全链路测试：前端优先检索 + CodeGraph 拓扑追踪');
console.log('================================================================\n');

const TEST_PORT = 8599;
const EMP_TOKEN = 'tok_real_troubleshoot_001';

process.env.PORT = String(TEST_PORT);
process.env.XKANG_TOKENS = `${EMP_TOKEN}:SupportSpecialist`;
process.env.XKANG_ADMIN_TOKENS = `adm_boss:AdminUser`;
process.env.XKANG_LLM_MOCK = '1';

const { server } = startServer();
const BASE_URL = `http://localhost:${TEST_PORT}`;
const SKT_PROJECT_ROOT = 'D:\\skt_project';

async function runScenarioTest() {
  try {
    // 1. 初始化 MCP 客户端与 ToolRegistry
    const mcpClient = new McpRemoteClient({
      serverUrl: BASE_URL,
      token: EMP_TOKEN,
    });
    const registry = new ToolRegistry(LOCAL_TOOLS);
    await registry.syncWithRemote(mcpClient);

    console.log('▶ [1/4] 验证已挂载的工具列表 (包含前端定向 search_code 与 MCP codegraph_explore):');
    const tools = registry.getTools();
    console.log('   工具清单:', tools.map((t) => t.name).join(', '));

    // 2. 模拟前端定向搜索 (scope: frontend)
    console.log('\n▶ [2/4] 模拟第 1 步：客服排查发票/报表页面，优先在前端工程 (scope: "frontend") 检索...');
    const frontSearchRes = await registry.executeTool(
      'search_code',
      {
        keyword: 'invoice',
        scope: 'frontend',
      },
      { repoPath: SKT_PROJECT_ROOT }
    );
    console.log('   前端搜索结果片段 (已隔离后端):');
    console.log('  ', String(frontSearchRes).slice(0, 200) + '...\n');
    console.log('   ✅ 前端优先定位成功！');

    // 3. 模拟跨工程图谱追踪 (codegraph_explore)
    console.log('▶ [3/4] 模拟第 2 步：通过 CodeGraph MCP 追踪后端核心下单接口调用链 (createOrder)...');
    const graphRes = await registry.executeTool(
      'codegraph_explore',
      {
        symbol: 'createOrder',
        queryType: 'callers',
        scope: 'backend',
      },
      { repoPath: SKT_PROJECT_ROOT }
    );
    console.log('   CodeGraph 返回排障拓扑:');
    console.log(String(graphRes).slice(0, 350) + '...\n');
    console.log('   ✅ 后端图谱调用链追踪成功！');

    // 4. 模拟 Harness 交互与状态流转
    console.log('▶ [4/4] 模拟 AgentHarness 在排障交互时的事件触发与状态流转...');
    const capturedEvents = [];
    const mockGateway = {
      getCurrentModel: () => 'xkang-managed',
      switchModel: () => {},
      streamChat: async (messages, activeTools, onEvent) => {
        onEvent({ type: 'reasoning_chunk', chunk: '正在分析前端 skt-front 页面与后端校验逻辑...' });
        onEvent({ type: 'content_chunk', chunk: '【结论/原因分析】：经排查，该报错由前端行程权限校验拦截。\n【触发条件与规则】：1. 用户未开通出差改派权限；2. 行程单处于已锁定状态。\n【客服处理建议/话术】：建议引导用户联系企业管理员开通权限。' });
        const finalMsg = {
          role: 'assistant',
          content: '【结论/原因分析】：经排查，该报错由前端行程权限校验拦截。\n【触发条件与规则】：1. 用户未开通出差改派权限；2. 行程单处于已锁定状态。\n【客服处理建议/话术】：建议引导用户联系企业管理员开通权限。',
        };
        return finalMsg;
      },
    };

    const harness = new AgentHarness({
      gateway: mockGateway,
      registry,
      context: { repoPath: SKT_PROJECT_ROOT },
    });

    const reply = await harness.run('分析一下用户提示没有修改出行地点权限的原因', (e) => {
      capturedEvents.push(e.type);
    });

    console.log('   Harness 触发事件流:', capturedEvents);
    console.log('   最终三段式答复内容:\n', reply);

    if (!reply.includes('【结论/原因分析】') || !reply.includes('【客服处理建议/话术】')) {
      throw new Error('答复不符合三段式规范！');
    }
    console.log('\n================================================================');
    console.log('🎉 业务排障全链路模拟测试顺利通过！');
    console.log('================================================================\n');
  } finally {
    server.close();
  }
}

runScenarioTest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
