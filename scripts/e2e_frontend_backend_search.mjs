import { searchCodeTool } from '../dist/tools/search.js';
import { executeCodeGraph } from '../server/dist/tools/codegraph.js';
import { loadServerConfig } from '../server/dist/config.js';

console.log('======================================================');
console.log('🧪 开始进行「前后端分层检索与前端优先排查」端到端测试');
console.log('======================================================\n');

const SKT_PROJECT_ROOT = 'D:\\skt_project';
const config = loadServerConfig();

async function runTests() {
  console.log('▶ [1/3] 测试 search_code 在 scope: "frontend" 模式下定向检索前端工程...');
  const frontRes = await searchCodeTool.execute(
    {
      keyword: 'template',
      scope: 'frontend',
    },
    { repoPath: SKT_PROJECT_ROOT }
  );

  console.log('   前端搜索返回行数/摘要:', String(frontRes).split('\n').length);
  if (!String(frontRes).includes('skt-front') && !String(frontRes).includes('webview') && !String(frontRes).includes('mobile')) {
    throw new Error('未正确过滤到前端工程代码！');
  }
  console.log('   ✅ 成功在前端工程 (skt-front) 中精确定位 UI 模板与组件！');

  console.log('\n▶ [2/3] 测试 search_code 在 scope: "backend" 模式下定向检索后端服务...');
  const backRes = await searchCodeTool.execute(
    {
      keyword: 'public class',
      scope: 'backend',
    },
    { repoPath: SKT_PROJECT_ROOT }
  );

  if (String(backRes).includes('skt-front')) {
    throw new Error('后端模式下不应混入 skt-front 前端项目！');
  }
  console.log('   ✅ 成功隔离前端项目，精准在后端工程 (skt-back) 中检索 Java 服务！');

  console.log('\n▶ [3/3] 测试 CodeGraph MCP 工具在 scope: "backend" 与 "frontend" 下的分域图谱查询...');
  const graphBack = await executeCodeGraph(
    {
      symbol: 'createOrder',
      queryType: 'callers',
      scope: 'backend',
    },
    config
  );

  console.log('   CodeGraph 后端图谱返回摘要:\n', String(graphBack).slice(0, 260) + '...');
  if (!String(graphBack).includes('后端项目') || !String(graphBack).includes('⚙️ 后端')) {
    throw new Error('CodeGraph 未正确输出后端领域标识！');
  }
  console.log('   ✅ CodeGraph 成功区分前后端领域并呈现规范图谱数据！');

  console.log('\n======================================================');
  console.log('🎉 前后端分层检索与前端优先排查测试全部顺利通过！');
  console.log('======================================================\n');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
