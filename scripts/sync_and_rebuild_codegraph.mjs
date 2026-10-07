#!/usr/bin/env node
import path from 'node:path';
import { getCodeGraphService } from '../server/dist/tools/codegraph.js';
import { CodeSyncManager } from '../server/dist/codegraph/sync_manager.js';

console.log('========================================================================');
console.log('🔄 小康 TUI 代码库 (GitLab) 批量同步与 CodeGraph 拓扑知识图谱热重构');
console.log('========================================================================\n');

const TARGET_DIR = process.env.CODE_REPO_PATH || 'D:\\skt_project';
const force = process.argv.includes('--force') || process.argv.includes('-f');

const service = getCodeGraphService(TARGET_DIR);
const manager = new CodeSyncManager(service, TARGET_DIR);

async function main() {
  console.log(`- 目标代码根目录: ${TARGET_DIR}`);
  console.log(`- 模式: ${force ? '强制全量重构图谱' : '智能增量检测 (仅有新 commit 时重构)'}\n`);

  try {
    const result = await manager.syncAndRebuild(force);
    console.log('\n========================================================================');
    console.log('📊 同步与图谱重构结果摘要:');
    console.log('========================================================================');
    console.log(`- 耗时: ${(result.durationMs / 1000).toFixed(1)} 秒`);
    console.log(`- 扫描代码仓库: ${result.totalRepos} 个`);
    console.log(`- 检测到新变更: ${result.updatedRepos} 个`);
    console.log(`- 同步失败仓库: ${result.failedRepos} 个`);
    console.log(`- 图谱索引已重构: ${result.indexRebuilt ? '✅ 是 (已热重载)' : '⚪ 否 (代码无变动)'}`);
    if (result.stats) {
      console.log(`- 当前索引规模: ${result.stats.totalFiles} 文件, ${result.stats.totalDefinitions} 符号, ${result.stats.totalCallRelations || 0} 调用链`);
    }
    console.log('========================================================================\n');
  } catch (err) {
    console.error('❌ 执行过程中出错:', err.message);
    process.exit(1);
  }
}

main();
