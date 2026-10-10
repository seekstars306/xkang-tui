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

export function isCodeSyncEnabled(config?: ServerConfig): boolean {
  const flag = (process.env.CODE_SYNC_ENABLED || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(flag)) return false;
  return (config?.codeSyncIntervalMinutes ?? 10) > 0;
}

export function initCodeSyncScheduler(config: ServerConfig): CodeSyncScheduler | null {
  // 测试/临时实例必须能关闭定时同步：它会对 D:\skt_project 下的仓库执行 git fetch/pull，失败时还会 reset --hard
  if (!isCodeSyncEnabled(config)) {
    console.log('[CodeSyncScheduler] 已按配置关闭定时代码同步 (CODE_SYNC_ENABLED=false 或 CODE_SYNC_INTERVAL_MINUTES=0)');
    return null;
  }
  if (!codeSyncScheduler) {
    const manager = getCodeSyncManager(config);
    const intervalMinutes = config.codeSyncIntervalMinutes || parseInt(process.env.CODE_SYNC_INTERVAL_MINUTES || '10', 10);
    codeSyncScheduler = new CodeSyncScheduler(manager, intervalMinutes);
    codeSyncScheduler.start();
  }
  return codeSyncScheduler;
}

const STATIC_ANALYSIS_CAVEAT =
  '说明: 代码图谱基于静态解析，反射调用、Spring 注入的动态分发、MyBatis XML 中的引用、前端通过 URL 字符串调用的接口等都可能不在图谱里。';

export async function executeCodeGraph(
  args: CodeGraphQueryArgs,
  config: ServerConfig,
  fetchImpl: typeof fetch = fetch,
  service: Pick<CodeGraphService, 'query'> | null = null
): Promise<string> {
  const { symbol, queryType, repo, scope = 'all' } = args;

  // Validate repo against allowlist if specified
  if (repo && config.repoAllowlist.length > 0 && !config.repoAllowlist.includes('*')) {
    if (!config.repoAllowlist.includes(repo)) {
      throw new Error(`Repository "${repo}" is not in the server allowlist.`);
    }
  }

  // 1. Prioritize local high-performance CodeGraph engine
  let localResult: ReturnType<CodeGraphService['query']> | null = null;
  let localError: string | null = null;
  try {
    localResult = (service || getCodeGraphService()).query(symbol, queryType, repo, scope);
    if (localResult.status === 'completed' && localResult.results.length > 0) {
      return formatGraphResultToMarkdown(localResult);
    }
  } catch (err) {
    localError = err instanceof Error ? err.message : String(err);
    console.warn('[CodeGraph execute error]:', err);
  }

  // 2. Try company remote CodeGraph HTTP service
  if (config.codeGraphEndpoint) {
    try {
      const response = await fetchImpl(`${config.codeGraphEndpoint}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, queryType, repo: repo || 'default', scope }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const json: any = await response.json();
        if (json && Array.isArray(json.results) && json.results.length > 0) {
          return formatGraphResultToMarkdown({ ...json, symbol, queryType, scope });
        }
      }
    } catch {
      // Remote unreachable
    }
  }

  // 3. 明确区分"图谱里没有"与"查询失败"，两者都不能被当作"代码中不存在调用关系"
  if (localResult && localResult.status === 'not_found') {
    return [
      `${localResult.message}`,
      STATIC_ANALYSIS_CAVEAT,
      '因此"图谱中没有"不代表代码里不存在该关系，请用 search_code 搜索符号名交叉验证后再下结论。',
    ].join('\n');
  }
  const reason = localError || localResult?.message || '图谱服务不可用';
  return `【CodeGraph 查询失败】未能完成对 "${symbol}" 的 ${queryType} 查询（原因: ${reason}）。这次查询没有得到任何结论，请改用 search_code 检索该符号。`;
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
