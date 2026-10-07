import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { CodeGraphService } from './service.js';

const execAsync = promisify(exec);

export interface GitRepoStatus {
  name: string;
  relativePath: string;
  fullPath: string;
  beforeSha: string;
  afterSha?: string;
  updated: boolean;
  error?: string;
}

export interface SyncResult {
  timestamp: string;
  durationMs: number;
  totalRepos: number;
  updatedRepos: number;
  failedRepos: number;
  indexRebuilt: boolean;
  stats?: any;
  details: GitRepoStatus[];
}

export class CodeSyncManager {
  private targetProjectRoot: string;
  private service: CodeGraphService;
  private isRunning = false;
  private lastSyncResult: SyncResult | null = null;

  constructor(service: CodeGraphService, targetProjectRoot = 'D:\\skt_project') {
    this.service = service;
    this.targetProjectRoot = path.resolve(targetProjectRoot);
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
      const { stdout } = await execAsync('git rev-parse HEAD', {
        cwd: repoPath,
        timeout: 10000,
      });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  private async pullRepo(repoPath: string): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. Fetch latest refs from remote (core.protectNTFS=false avoids Windows colon-filename index errors)
      await execAsync('git -c core.protectNTFS=false fetch --all --prune', {
        cwd: repoPath,
        timeout: 45000,
      });

      // 2. Try fast-forward pull
      try {
        await execAsync('git -c core.protectNTFS=false pull --ff-only', {
          cwd: repoPath,
          timeout: 45000,
        });
      } catch {
        // If fast-forward fails (e.g. dirty tree / uncommitted changes in mirror), sync with upstream branch
        try {
          const { stdout: upstreamOut } = await execAsync('git rev-parse --abbrev-ref @{u}', {
            cwd: repoPath,
            timeout: 5000,
          });
          const upstreamBranch = upstreamOut.trim();
          if (upstreamBranch) {
            await execAsync(`git -c core.protectNTFS=false reset --hard ${upstreamBranch}`, {
              cwd: repoPath,
              timeout: 45000,
            });
          } else {
            await execAsync('git -c core.protectNTFS=false reset --hard HEAD', {
              cwd: repoPath,
              timeout: 45000,
            });
          }
        } catch (resetErr: unknown) {
          const msg = resetErr instanceof Error ? resetErr.message : String(resetErr);
          return { success: false, error: msg };
        }
      }

      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
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

      console.log(`[CodeSync] 开始同步代码库: ${this.targetProjectRoot} (发现 ${repoPaths.length} 个子仓库)`);

      for (const fullPath of repoPaths) {
        const relativePath = path.relative(this.targetProjectRoot, fullPath);
        const name = path.basename(fullPath);
        const beforeSha = await this.getHeadSha(fullPath);

        const pullResult = await this.pullRepo(fullPath);
        const afterSha = await this.getHeadSha(fullPath);

        const isChanged = beforeSha !== '' && afterSha !== '' && beforeSha !== afterSha;
        if (isChanged) {
          updatedCount++;
          console.log(`   ✨ 仓库 [${relativePath}] 检测到更新: ${beforeSha.slice(0, 7)} -> ${afterSha.slice(0, 7)}`);
        }

        if (!pullResult.success) {
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
          error: pullResult.error,
        });
      }

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
        indexRebuilt,
        stats,
        details,
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

  public getStatus() {
    return {
      isRunning: this.isRunning,
      targetProjectRoot: this.targetProjectRoot,
      lastSyncTime: this.lastSyncResult?.timestamp || null,
      lastSyncDurationMs: this.lastSyncResult?.durationMs || null,
      lastIndexRebuilt: this.lastSyncResult?.indexRebuilt || false,
      currentStats: this.service.getStats(),
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
