import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { CodeGraphService } from './service.js';
import { evaluateAll, writeTrustReport, type ManifestEntryLite, type RepoState } from './version_trust.js';

/** 可注入的 git 命令执行器（测试用来记录"到底执行过哪些命令"） */
export type RunCommand = (command: string, options: { cwd: string; timeout: number }) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

/**
 * 默认执行器：直接 execFile，不走 shell。
 *
 * 以前用 promisify(exec(command))——child_process.exec 一律经 shell 执行，
 * Windows 上就是 cmd.exe /d /s /c "git ..."。服务端没有控制台时（被接棒服务/ relauncher
 * 拉起就是这种情况），Windows 给每个 cmd 新开一个控制台：一次代码同步 18 个仓库 ×
 * 六七条 git 命令，屏幕上就是一百多个窗口连闪。
 *
 * 顺带修掉一个隐藏问题：cmd.exe 会把 ^ 当转义符，
 * 'git rev-parse P1.0.9^{commit}' 传进去实际变成 P1.0.9{commit}，
 * 标签比对一直是错的；不过 shell 之后参数按字面传递，不会再被吃。
 */
const defaultRunCommand: RunCommand = (command, options) => {
  const [file, ...args] = command.trim().split(/\s+/);
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: options.cwd, timeout: options.timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
};

/** 图谱数据目录：与 stats.json 同目录（解析顺序与 server/src/tools/codegraph.ts 保持一致，供 mirror-health.json 落盘） */
function resolveGraphDataDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'server/data/codegraph'),
    path.resolve(process.cwd(), 'data/codegraph'),
    path.resolve(moduleDir, '../../data/codegraph'),
    path.resolve(moduleDir, '../data/codegraph'),
  ];
  for (const candidate of candidates) if (fs.existsSync(path.join(candidate, 'stats.json'))) return candidate;
  return candidates[0];
}

export interface GitRepoStatus {
  name: string;
  relativePath: string;
  fullPath: string;
  beforeSha: string;
  afterSha?: string;
  updated: boolean;
  branch?: string;
  dirty?: boolean;
  dirtyFiles?: string[];
  pullResult?: 'ok' | 'skipped' | 'failed';
  error?: string;
}

export interface MirrorHealth {
  timestamp: string;
  healthy: boolean;
  repos: Array<{ relativePath: string; branch: string; headSha: string; dirty: boolean; dirtyFiles: string[]; pullResult: string; error: string | null }>;
  skippedRepos: string[];
  staleRepos: string[];
}

export interface SyncResult {
  timestamp: string;
  durationMs: number;
  totalRepos: number;
  updatedRepos: number;
  failedRepos: number;
  skippedRepos: number;
  indexRebuilt: boolean;
  stats?: any;
  details: GitRepoStatus[];
  skipped: GitRepoStatus[];
}

export class CodeSyncManager {
  private targetProjectRoot: string;
  private service: CodeGraphService;
  private runCommand: RunCommand;
  private dataDir: string;
  private isRunning = false;
  private lastSyncResult: SyncResult | null = null;
  private lastMirrorHealth: MirrorHealth | null = null;

  /**
   * @param dataDir 图谱数据目录（mirror-health.json 落盘处）；默认按与 CodeGraphService 相同的顺序解析
   */
  constructor(service: CodeGraphService, targetProjectRoot = 'D:\\skt_project', runCommand: RunCommand = defaultRunCommand, dataDir: string = resolveGraphDataDir()) {
    this.service = service;
    this.targetProjectRoot = path.resolve(targetProjectRoot);
    this.runCommand = runCommand;
    this.dataDir = path.resolve(dataDir);
  }

  /**
   * Discovers all git repositories inside targetProjectRoot (up to 3 levels deep)
   */
  private discoverGitRepos(dir: string, depth = 0, maxDepth = 3): string[] {
    if (depth > maxDepth || !fs.existsSync(dir)) return [];
    const repos: string[] = [];

    try {
      if (fs.existsSync(path.join(dir, '.git'))) {
        return [dir];
      }

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const subDir = path.join(dir, entry.name);
          if (fs.existsSync(path.join(subDir, '.git'))) {
            repos.push(subDir);
          } else {
            repos.push(...this.discoverGitRepos(subDir, depth + 1, maxDepth));
          }
        }
      }
    } catch {}

    return repos;
  }

  private async getHeadSha(repoPath: string): Promise<string> {
    try {
      const { stdout } = await this.runCommand('git rev-parse HEAD', { cwd: repoPath, timeout: 10000 });
      return String(stdout).trim();
    } catch {
      return '';
    }
  }

  private async getBranch(repoPath: string): Promise<string> {
    try {
      const { stdout } = await this.runCommand('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, timeout: 10000 });
      return String(stdout).trim();
    } catch {
      return '';
    }
  }

  private async getTagState(repoPath: string, headSha: string): Promise<{ nearestTag: string; headEqualsTag: boolean }> {
    if (!headSha) return { nearestTag: '', headEqualsTag: false };
    try {
      const { stdout } = await this.runCommand('git --no-optional-locks describe --tags --abbrev=0', { cwd: repoPath, timeout: 10000 });
      const nearestTag = String(stdout).trim();
      if (!nearestTag) return { nearestTag: '', headEqualsTag: false };
      const { stdout: tagOut } = await this.runCommand(`git --no-optional-locks rev-parse ${nearestTag}^{commit}`, { cwd: repoPath, timeout: 10000 });
      return { nearestTag, headEqualsTag: String(tagOut).trim() === headSha };
    } catch {
      return { nearestTag: '', headEqualsTag: false };
    }
  }

  /**
   * 安全拉取：先 fetch（不动工作区），再判断工作区是否干净；
   * 有未提交改动就跳过拉取并原样保留，干净时才 pull --ff-only。
   * 任何情况下都不执行 reset / checkout --force / clean——硬重置会抹掉镜像里的未提交改动。
   */
  private async pullRepo(repoPath: string): Promise<{ success: boolean; skipped?: boolean; reason?: string; dirtyFiles?: string[]; error?: string }> {
    try {
      // 1. Fetch latest refs from remote (core.protectNTFS=false avoids Windows colon-filename index errors)
      await this.runCommand('git -c core.protectNTFS=false fetch --all --prune', { cwd: repoPath, timeout: 45000 });

      // 2. Dirty working tree: skip the pull entirely, never touch the tree
      // --no-optional-locks：status 会刷新索引，避免与 IDE/其它 git 进程抢锁（镜像只读规则）
      const { stdout: statusOut } = await this.runCommand('git --no-optional-locks status --porcelain', { cwd: repoPath, timeout: 15000 });
      // porcelain 行格式为 "XY <路径>"：剥掉 2 位状态码和随后的空格，只保留相对路径（不改写内容）
      const dirtyFiles = String(statusOut).split('\n').map(line => line.replace(/\r$/, '')).filter(Boolean).map(line => line.replace(/^.. /, '').trim());
      if (dirtyFiles.length) return { success: true, skipped: true, reason: '工作区有未提交改动', dirtyFiles };

      // 3. Fast-forward pull only; a failure is reported as-is, with no "repair"
      await this.runCommand('git -c core.protectNTFS=false pull --ff-only', { cwd: repoPath, timeout: 45000 });
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  /** 汇总本次同步的镜像健康状态并落盘 mirror-health.json 与 version-trust.json（只写相对路径，不写远端 URL） */
  private async writeMirrorHealth(details: GitRepoStatus[]): Promise<MirrorHealth> {
    const skippedRepos = details.filter(repo => repo.pullResult === 'skipped').map(repo => repo.relativePath);
    const staleRepos = details.filter(repo => repo.pullResult === 'failed').map(repo => repo.relativePath);
    const health: MirrorHealth = {
      timestamp: new Date().toISOString(),
      healthy: skippedRepos.length === 0 && staleRepos.length === 0,
      repos: details.map(repo => ({ relativePath: repo.relativePath, branch: repo.branch || '', headSha: repo.afterSha || repo.beforeSha, dirty: Boolean(repo.dirty), dirtyFiles: repo.dirtyFiles || [], pullResult: repo.pullResult || 'ok', error: repo.error ?? null })),
      skippedRepos,
      staleRepos,
    };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(path.join(this.dataDir, 'mirror-health.json'), JSON.stringify(health, null, 2), 'utf-8');
      const states: RepoState[] = [];
      for (const repo of details) {
        const headSha = repo.afterSha || repo.beforeSha;
        const tag = await this.getTagState(repo.fullPath, headSha);
        states.push({
          relativePath: repo.relativePath.replace(/\\/g, '/'),
          headSha,
          dirty: Boolean(repo.dirty),
          nearestTag: tag.nearestTag,
          headEqualsTag: tag.headEqualsTag,
        });
      }
      const manifestFile = process.env.DEPLOYMENT_MANIFEST_PATH || path.join(this.dataDir, 'deployment-manifest.json');
      let manifest: ManifestEntryLite[] | undefined;
      if (fs.existsSync(manifestFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
          if (Array.isArray(parsed?.entries)) manifest = parsed.entries;
        } catch { /* 清单不可读时按无清单判定 */ }
      }
      const trustReport = evaluateAll(states, manifest, { mirrorRoot: this.targetProjectRoot });
      writeTrustReport(trustReport, path.join(this.dataDir, 'version-trust.json'));
    } catch (err) {
      console.warn('[CodeSync] 写入 mirror-health.json / version-trust.json 失败:', err);
    }
    this.lastMirrorHealth = health;
    return health;
  }

  /**
   * Performs code synchronization across all discovered repos.
   * If changes are detected (or forceRebuild is true), rebuilds the CodeGraph index.
   */
  public async syncAndRebuild(forceRebuild = false): Promise<SyncResult> {
    if (this.isRunning) {
      throw new Error('代码同步与 CodeGraph 构建任务正在进行中，请勿重复触发。');
    }

    this.isRunning = true;
    try {
      const startTime = Date.now();
      const repoPaths = this.discoverGitRepos(this.targetProjectRoot);
      const details: GitRepoStatus[] = [];

      let updatedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;

      console.log(`[CodeSync] 开始同步代码库: ${this.targetProjectRoot} (发现 ${repoPaths.length} 个子仓库)`);

      for (const fullPath of repoPaths) {
        const relativePath = path.relative(this.targetProjectRoot, fullPath);
        const name = path.basename(fullPath);
        const beforeSha = await this.getHeadSha(fullPath);
        const branch = await this.getBranch(fullPath);

        const pullResult = await this.pullRepo(fullPath);
        const afterSha = await this.getHeadSha(fullPath);

        const isChanged = beforeSha !== '' && afterSha !== '' && beforeSha !== afterSha;
        if (isChanged) {
          updatedCount++;
          console.log(`   ✨ 仓库 [${relativePath}] 检测到更新: ${beforeSha.slice(0, 7)} -> ${afterSha.slice(0, 7)}`);
        }

        if (pullResult.skipped) {
          skippedCount++;
          console.warn(`   ⏭ 仓库 [${relativePath}] 工作区有未提交改动，已跳过拉取（不做任何重置）: ${(pullResult.dirtyFiles || []).slice(0, 5).join(', ')}`);
        } else if (!pullResult.success) {
          failedCount++;
          console.warn(`   ⚠ 仓库 [${relativePath}] 同步失败: ${pullResult.error}`);
        }

        details.push({
          name,
          relativePath,
          fullPath,
          beforeSha,
          afterSha,
          updated: isChanged,
          branch,
          dirty: Boolean(pullResult.skipped),
          dirtyFiles: pullResult.dirtyFiles,
          pullResult: pullResult.skipped ? 'skipped' : pullResult.success ? 'ok' : 'failed',
          error: pullResult.error,
        });
      }

      await this.writeMirrorHealth(details);

      let indexRebuilt = false;
      let stats: any = null;

      // Trigger rebuild if code changed or explicitly requested
      if (updatedCount > 0 || forceRebuild || !this.service.getStats()) {
        console.log(`[CodeSync] 检测到代码更新或初始化要求，正在重构 CodeGraph 拓扑图谱...`);
        try {
          const newIndex = await this.service.rebuildIndex();
          indexRebuilt = true;
          stats = newIndex.stats;
          console.log(`[CodeSync] ✅ CodeGraph 图谱热重载完成！(源码文件: ${stats.totalFiles}, 符号定义: ${stats.totalDefinitions}, 调用链: ${stats.totalCallRelations || 0})`);
        } catch (err: unknown) {
          console.error(`[CodeSync] ❌ CodeGraph 重构失败:`, err);
        }
      } else {
        console.log(`[CodeSync] 所有仓库代码已是最新，无需重新构建 CodeGraph 图谱。`);
        stats = this.service.getStats();
      }

      const durationMs = Date.now() - startTime;
      const result: SyncResult = {
        timestamp: new Date().toISOString(),
        durationMs,
        totalRepos: repoPaths.length,
        updatedRepos: updatedCount,
        failedRepos: failedCount,
        skippedRepos: skippedCount,
        indexRebuilt,
        stats,
        details,
        skipped: details.filter(repo => repo.pullResult === 'skipped'),
      };

      this.lastSyncResult = result;
      return result;
    } finally {
      this.isRunning = false;
    }
  }

  public getLastResult(): SyncResult | null {
    return this.lastSyncResult;
  }

  /** 最近一次同步的镜像健康状态（mirror-health.json 内容） */
  public getMirrorHealth(): MirrorHealth | null {
    return this.lastMirrorHealth;
  }

  public getStatus() {
    return {
      isRunning: this.isRunning,
      targetProjectRoot: this.targetProjectRoot,
      lastSyncTime: this.lastSyncResult?.timestamp || null,
      lastSyncDurationMs: this.lastSyncResult?.durationMs || null,
      lastIndexRebuilt: this.lastSyncResult?.indexRebuilt || false,
      currentStats: this.service.getStats(),
      lastMirrorHealth: this.lastMirrorHealth,
    };
  }
}

/**
 * Background periodic scheduler
 */
export class CodeSyncScheduler {
  private manager: CodeSyncManager;
  private intervalMinutes: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(manager: CodeSyncManager, intervalMinutes = 10) {
    this.manager = manager;
    this.intervalMinutes = Math.max(intervalMinutes, 1); // minimum 1 min
  }

  public start(): void {
    if (this.timer) return;

    const intervalMs = this.intervalMinutes * 60 * 1000;
    console.log(`[CodeSyncScheduler] 定时同步调度器已启动: 每 ${this.intervalMinutes} 分钟自动拉取代码并热更新 CodeGraph`);

    // 服务端启动时即刻在后台执行首次拉取与检查（非阻塞）
    setImmediate(() => {
      console.log(`[CodeSyncScheduler] 服务端启动完成，即刻触发首次代码同步与 CodeGraph 校验...`);
      this.manager.syncAndRebuild(false).catch((err) => {
        console.warn(`[CodeSyncScheduler] 首次启动代码同步失败 (不影响主服务运行):`, err?.message || err);
      });
    });

    // Recurring schedule
    this.timer = setInterval(() => {
      console.log(`[CodeSyncScheduler] 触发定时增量代码同步与 CodeGraph 校验...`);
      this.manager.syncAndRebuild(false).catch((err) => {
        console.warn(`[CodeSyncScheduler] 自动同步执行失败:`, err?.message || err);
      });
    }, intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log(`[CodeSyncScheduler] 定时同步调度器已暂停。`);
    }
  }
}
