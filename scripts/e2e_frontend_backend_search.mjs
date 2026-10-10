import { executeSearchCode } from '../server/dist/tools/code_search.js';
import { executeCodeGraph } from '../server/dist/tools/codegraph.js';
import { loadServerConfig } from '../server/dist/config.js';

console.log('======================================================');
console.log('🧪 开始进行「前后端分层检索与前端优先排查」端到端测试');
console.log('======================================================\n');

const SKT_PROJECT_ROOT = 'D:\\skt_project';
const config = loadServerConfig();
const searchConfig = { ...config, codeRepoPath: SKT_PROJECT_ROOT };

function listedFiles(out) {
  return String(out)
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2));
}

async function runTests() {
  console.log('▶ [1/3] 测试 search_code 在 scope: "frontend" 模式下定向检索前端工程...');
  const frontRes = await executeSearchCode({ keyword: 'template', scope: 'frontend', output_mode: 'files_with_matches' }, searchConfig);
  const frontFiles = listedFiles(frontRes);
  if (frontFiles.length === 0 || !frontFiles.every((f) => f.startsWith('skt-front/'))) {
    throw new Error('前端检索没有结果或混入了非前端文件！\n' + String(frontRes).slice(0, 500));
  }
  console.log(`   ✅ 前端检索命中 ${frontFiles.length} 个文件，全部位于 skt-front`);

  console.log('\n▶ [2/3] 测试 search_code 在 scope: "backend" 模式下定向检索后端服务...');
  const backRes = await executeSearchCode({ keyword: 'public class', scope: 'backend', output_mode: 'files_with_matches' }, searchConfig);
  const backFiles = listedFiles(backRes);
  if (backFiles.length === 0 || backFiles.some((f) => f.startsWith('skt-front/'))) {
    throw new Error('后端检索没有结果或混入了 skt-front 前端文件！');
  }
  console.log(`   ✅ 后端检索命中 ${backFiles.length}+ 个文件，未混入前端工程`);

  console.log('\n▶ [3/3] 测试 CodeGraph MCP 工具在 scope: "backend" 下的分域图谱查询...');
  const graphBack = await executeCodeGraph({ symbol: 'createOrder', queryType: 'callers', scope: 'backend' }, config);
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
