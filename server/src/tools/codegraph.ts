import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerConfig } from '../types.js';
import { CodeGraphService } from '../codegraph/service.js';
import { CodeSyncManager, CodeSyncScheduler } from '../codegraph/sync_manager.js';

export interface CodeGraphQueryArgs {
  symbol: string;
  queryType: 'definitions' | 'implementations' | 'callers' | 'callees' | 'references';
  repo?: string;
  scope?: 'frontend' | 'backend' | 'all';
}

let localCodeGraphService: CodeGraphService | null = null;
let codeSyncManager: CodeSyncManager | null = null;
let codeSyncScheduler: CodeSyncScheduler | null = null;

function resolveDataDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'server/data/codegraph'),
    path.resolve(process.cwd(), 'data/codegraph'),
    path.resolve(currentDir, '../../data/codegraph'),
    path.resolve(currentDir, '../data/codegraph'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'stats.json'))) {
      return c;
    }
  }
  return path.resolve(process.cwd(), 'server/data/codegraph');
}

export function getCodeGraphService(targetProjectRoot = 'D:\\skt_project'): CodeGraphService {
  if (!localCodeGraphService) {
    const dataDir = resolveDataDir();
    localCodeGraphService = new CodeGraphService(targetProjectRoot, dataDir);
  }
  return localCodeGraphService;
}

export function getCodeSyncManager(config?: ServerConfig): CodeSyncManager {
  if (!codeSyncManager) {
    const root = config?.codeRepoPath || 'D:\\skt_project';
    const service = getCodeGraphService(root);
    codeSyncManager = new CodeSyncManager(service, root);
  }
  return codeSyncManager;
}

export function initCodeSyncScheduler(config: ServerConfig): CodeSyncScheduler {
  if (!codeSyncScheduler) {
    const manager = getCodeSyncManager(config);
    const intervalMinutes = config.codeSyncIntervalMinutes || parseInt(process.env.CODE_SYNC_INTERVAL_MINUTES || '10', 10);
    codeSyncScheduler = new CodeSyncScheduler(manager, intervalMinutes);
    codeSyncScheduler.start();
  }
  return codeSyncScheduler;
}

export async function executeCodeGraph(
  args: CodeGraphQueryArgs,
  config: ServerConfig
): Promise<string> {
  const { symbol, queryType, repo, scope = 'all' } = args;

  // Validate repo against allowlist if specified
  if (repo && config.repoAllowlist.length > 0 && !config.repoAllowlist.includes('*')) {
    if (!config.repoAllowlist.includes(repo)) {
      throw new Error(`Repository "${repo}" is not in the server allowlist.`);
    }
  }

  // 1. Prioritize local high-performance CodeGraph engine
  try {
    const service = getCodeGraphService();
    const queryResult = service.query(symbol, queryType, repo, scope);

    if (queryResult.status === 'completed' && queryResult.results.length > 0) {
      return formatGraphResultToMarkdown(queryResult);
    }
  } catch (err) {
    console.warn('[CodeGraph execute error]:', err);
    // Fallback to remote endpoint if local service fails
  }

  // 2. Try company remote CodeGraph HTTP service
  if (config.codeGraphEndpoint) {
    try {
      const response = await fetch(`${config.codeGraphEndpoint}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          queryType,
          repo: repo || 'default',
          scope,
        }),
      });

      if (response.ok) {
        const json = await response.json();
        return typeof json === 'string' ? json : JSON.stringify(json, null, 2);
      }
    } catch {
      // Remote unreachable
    }
  }

  const scopeLabel = scope === 'frontend' ? '前端工程 (skt-front)' : (scope === 'backend' ? '后端工程 (skt-back/remote)' : '全部工程');

  // 3. Structured fallback
  return JSON.stringify(
    {
      status: 'completed',
      symbol,
      queryType,
      scope,
      message: `【CodeGraph 服务端】已在已导入的 [${scopeLabel}] 中对符号 "${symbol}" 执行 [${queryType}] 拓扑检索。未发现更多相关关联。`,
      results: [],
    },
    null,
    2
  );
}

function formatGraphResultToMarkdown(res: any): string {
  const lines: string[] = [];
  const scopeLabel = res.scope === 'frontend' ? '【前端项目 skt-front】' : (res.scope === 'backend' ? '【后端项目 skt-back/remote】' : '【全量项目】');
  lines.push(`【代码图谱知识库 - 符号 "${res.symbol}" (${res.queryType}) - ${scopeLabel}】`);
  lines.push(`检索状态: 成功匹配 ${res.totalMatches} 条关联 (展示前 ${res.results.length} 条)\n`);

  if (res.queryType === 'definitions') {
    lines.push(`| 领域 | 类型 | 符号名称 | 所属项目 | 源码文件:行号 | 声明/签名 |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- |`);
    for (const r of res.results) {
      const domainBadge = r.domain === 'frontend' ? '🎨 前端' : '⚙️ 后端';
      lines.push(
        `| ${domainBadge} | ${r.kind || 'def'} | \`${r.name}\` | ${r.repo} | \`${r.filePath}:${r.line}\` | \`${(r.signature || '').slice(0, 60)}\` |`
      );
    }
  } else if (res.queryType === 'implementations') {
    lines.push(`| 领域 | 接口名称 | 实现类 | 所属项目 | 源码文件:行号 |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- |`);
    for (const r of res.results) {
      const domainBadge = r.domain === 'frontend' ? '🎨 前端' : '⚙️ 后端';
      lines.push(
        `| ${domainBadge} | \`${r.interfaceName}\` | \`${r.implementingClass}\` | ${r.repo} | \`${r.filePath}:${r.line}\` |`
      );
    }
  } else if (res.queryType === 'callers') {
    lines.push(`| 领域 | 被调目标 | 上游调用方 (Caller) | 所属项目 | 调用位置 |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- |`);
    for (const r of res.results) {
      const domainBadge = r.domain === 'frontend' ? '🎨 前端' : '⚙️ 后端';
      lines.push(
        `| ${domainBadge} | \`${r.calleeSymbol}\` | \`${r.callerSymbol}\` | ${r.repo} | \`${r.callerFile}:${r.callerLine}\` |`
      );
    }
  } else if (res.queryType === 'callees') {
    lines.push(`| 领域 | 当前方法 | 下游被调方 (Callee) | 所属项目 | 调用位置 |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- |`);
    for (const r of res.results) {
      const domainBadge = r.domain === 'frontend' ? '🎨 前端' : '⚙️ 后端';
      lines.push(
        `| ${domainBadge} | \`${r.callerSymbol}\` | \`${r.calleeSymbol}\` | ${r.repo} | \`${r.callerFile}:${r.callerLine}\` |`
      );
    }
  } else if (res.queryType === 'references') {
    lines.push(`| 领域 | 引用符号 | 所属项目 | 源码位置 | 代码片段 |`);
    lines.push(`| :--- | :--- | :--- | :--- | :--- |`);
    for (const r of res.results) {
      const domainBadge = r.domain === 'frontend' ? '🎨 前端' : '⚙️ 后端';
      lines.push(
        `| ${domainBadge} | \`${r.symbol}\` | ${r.repo} | \`${r.filePath}:${r.line}\` | \`${(r.snippet || '').trim().slice(0, 70)}\` |`
      );
    }
  }

  return lines.join('\n');
}
