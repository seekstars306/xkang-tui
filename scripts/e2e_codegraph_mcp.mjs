import { startServer } from '../server/dist/index.js';
import { McpRemoteClient } from '../dist/mcp/client.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { LOCAL_TOOLS } from '../dist/tools/index.js';

console.log('======================================================');
console.log('🧪 开始进行「CodeGraph MCP 服务端代码图谱检索」端到端测试');
console.log('======================================================\n');

const TEST_PORT = 8499;
const EMP_TOKEN = 'tok_test_codegraph_123';

process.env.PORT = String(TEST_PORT);
process.env.XKANG_TOKENS = `${EMP_TOKEN}:TestEngineer`;
process.env.XKANG_ADMIN_TOKENS = `adm_test:AdminBoss`;
process.env.XKANG_LLM_MOCK = '1';

// 测试实例不能执行定时代码同步（会对 D:\\skt_project 执行 git pull / reset）
process.env.CODE_SYNC_ENABLED = 'false';
const { server } = startServer();
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function runTests() {
  try {
    console.log('▶ [1/3] 客户端通过 MCP 连接服务端并发现 codegraph_explore 工具...');
    const mcpClient = new McpRemoteClient({
      serverUrl: BASE_URL,
      token: EMP_TOKEN,
    });

    const registry = new ToolRegistry(LOCAL_TOOLS);
    const syncRes = await registry.syncWithRemote(mcpClient);
    console.log(`   MCP 连接结果: ${syncRes.connected}, 发现远程工具: ${syncRes.count} 个`);

    const codegraphTool = registry.getTool('codegraph_explore');
    if (!codegraphTool) {
      throw new Error('未发现 codegraph_explore MCP 工具！');
    }
    console.log('   ✅ 成功挂载 codegraph_explore 远程 MCP 工具！');

    console.log('\n▶ [2/3] 通过 MCP 调用 codegraph_explore 查询方法调用链 (Callers)...');
    const callRes = await registry.executeTool(
      'codegraph_explore',
      {
        symbol: 'createOrder',
        queryType: 'callers',
      },
      { repoPath: 'D:\\skt_project' }
    );

    console.log('   MCP 查询返回摘要:\n', String(callRes).slice(0, 300) + '...');

    if (!String(callRes).includes('代码图谱知识库') || !String(callRes).includes('调用方')) {
      throw new Error('CodeGraph 返回格式不符合预期！');
    }
    console.log('   ✅ MCP codegraph_explore 调用成功，精准返回调用链路图谱！');

    console.log('\n▶ [3/3] 测试服务端 REST 接口 /codegraph/api/query ...');
    const apiResp = await fetch(`${BASE_URL}/codegraph/api/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${EMP_TOKEN}`,
      },
      body: JSON.stringify({
        symbol: 'createOrder',
        queryType: 'callers',
      }),
    });

    if (!apiResp.ok) {
      throw new Error(`REST API HTTP ${apiResp.status}`);
    }
    const apiJson = await apiResp.json();
    console.log(`   REST API 返回状态: ${apiJson.status}, 匹配条数: ${apiJson.totalMatches}`);
    console.log('   ✅ CodeGraph REST API 验证通过！');

    console.log('\n======================================================');
    console.log('🎉 CodeGraph MCP 代码检索端到端测试全部顺利通过！');
    console.log('======================================================\n');
  } finally {
    server.close();
  }
  // MCP SSE 长连接会让 server.close() 一直等待，测试通过后显式退出
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
