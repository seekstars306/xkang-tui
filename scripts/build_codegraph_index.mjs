import path from 'node:path';
import { CodeGraphService } from '../server/dist/codegraph/service.js';

async function main() {
  const projectRoot = 'D:\\skt_project';
  const dataDir = './server/data/codegraph';

  console.log('======================================================');
  console.log('🚀 开始为 D:\\skt_project 构建全量 CodeGraph 图谱索引...');
  console.log('======================================================\n');

  const service = new CodeGraphService(projectRoot, dataDir);
  const index = await service.rebuildIndex();

  console.log('\n📊 索引统计:');
  console.log(`- 覆盖项目/仓库数: ${index.stats.totalRepos}`);
  console.log(`- 扫描源码文件数: ${index.stats.totalFiles}`);
  console.log(`- 类/方法定义数: ${index.stats.totalDefinitions}`);
  console.log(`- 接口实现关系数: ${index.stats.totalImplementations}`);
  console.log(`- 方法调用链路数: ${index.stats.totalCalls}`);
  console.log(`- 符号引用位置数: ${index.stats.totalReferences}`);

  // Test some sample queries
  console.log('\n🔍 测试抽样查询:');
  
  // 1. Query definitions
  const testSym = 'PaymentService';
  const defRes = service.query(testSym, 'definitions');
  console.log(`[Definitions] 查询 "${testSym}":`, defRes.status, `(匹配 ${defRes.totalMatches} 条)`);
  if (defRes.results.length > 0) {
    console.log('   样例:', JSON.stringify(defRes.results[0]));
  }

  // 2. Query implementations
  const ifaceRes = service.query('BaseService', 'implementations');
  console.log(`[Implementations] 查询 "BaseService":`, ifaceRes.status, `(匹配 ${ifaceRes.totalMatches} 条)`);

  // 3. Query callers
  const callRes = service.query('createOrder', 'callers');
  console.log(`[Callers] 查询 "createOrder":`, callRes.status, `(匹配 ${callRes.totalMatches} 条)`);
}

main().catch(console.error);
