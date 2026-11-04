// V2：部署版本三档判定（决策 D2）。
//   已核准（approved）：部署清单有该仓库条目、commit === HEAD、artifactSha256 非空；
//   推定（presumed）：非已核准，但工作区干净且 HEAD 恰好等于最新 P* 标签（/^P\d/，T 前缀不算）；
//   未知（unknown）：其余全部（含脏工作区、HEAD 越过最新 P 标签、只有 T 标签、无标签）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export type TrustLevel = 'approved' | 'presumed' | 'unknown';

/** 图谱数据目录解析顺序与 server/src/tools/codegraph.ts 保持一致（供 version-trust.json 落盘/读取） */
export function resolveGraphDataDir(): string {
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

export interface RepoState {
  relativePath: string;
  headSha: string;
  dirty: boolean;
  /** 最近标签（git describe --tags --abbrev=0；无标签为空串） */
  nearestTag: string;
  /** HEAD 是否恰好等于该最近标签 */
  headEqualsTag: boolean;
}

export interface ManifestEntryLite {
  repo: string;
  commit: string;
  artifactSha256: string;
}

export interface TrustVerdict {
  level: TrustLevel;
  reason: string;
}

/** P* 标签才算"发布标签"；T1.0.0 之类不算 */
export function isReleaseTag(tag: string): boolean {
  return /^P\d/.test(tag);
}

export function evaluateRepoTrust(repo: RepoState, manifestEntry?: ManifestEntryLite): TrustVerdict {
  if (manifestEntry && manifestEntry.commit && manifestEntry.commit === repo.headSha && manifestEntry.artifactSha256) {
    return { level: 'approved', reason: `部署清单登记 commit ${repo.headSha.slice(0, 8)} 与 HEAD 一致且有制品标识` };
  }
  if (manifestEntry && manifestEntry.commit && manifestEntry.commit !== repo.headSha) {
    return { level: 'unknown', reason: `部署清单 commit ${manifestEntry.commit.slice(0, 8)} 与镜像 HEAD ${repo.headSha.slice(0, 8)} 不一致` };
  }
  if (!repo.dirty && repo.headEqualsTag && isReleaseTag(repo.nearestTag)) {
    return { level: 'presumed', reason: `工作区干净且 HEAD 恰好等于发布标签 ${repo.nearestTag}` };
  }
  if (repo.dirty) return { level: 'unknown', reason: '工作区有未提交改动，无法确认与线上一致' };
  if (!repo.nearestTag) return { level: 'unknown', reason: '仓库没有任何标签' };
  if (!repo.headEqualsTag) return { level: 'unknown', reason: `HEAD 已越过最新标签 ${repo.nearestTag}` };
  return { level: 'unknown', reason: `最新标签 ${repo.nearestTag} 不是 P* 发布标签` };
}

export interface TrustReport {
  createdAt: string;
  mirrorRoot: string;
  manifestLoaded: boolean;
  summary: { approved: number; presumed: number; unknown: number };
  repos: Array<RepoState & { verdict: TrustVerdict }>;
}

/** 批量判定；manifest 按 repo 路径匹配（清单缺该仓库即无条目） */
export function evaluateAll(repos: readonly RepoState[], manifest?: readonly ManifestEntryLite[], options: { mirrorRoot?: string } = {}): TrustReport {
  const byRepo = new Map((manifest || []).map(entry => [entry.repo.replace(/\\/g, '/'), entry]));
  const evaluated = repos.map(repo => ({ ...repo, verdict: evaluateRepoTrust(repo, byRepo.get(repo.relativePath.replace(/\\/g, '/'))) }));
  const count = (level: TrustLevel) => evaluated.filter(r => r.verdict.level === level).length;
  return {
    createdAt: new Date().toISOString(),
    mirrorRoot: options.mirrorRoot || '',
    manifestLoaded: Boolean(manifest?.length),
    summary: { approved: count('approved'), presumed: count('presumed'), unknown: count('unknown') },
    repos: evaluated,
  };
}

/** 只读采集镜像仓库状态（git 一律 --no-optional-locks；不 fetch、不写任何文件） */
export function collectRepoStates(mirrorRoot: string): RepoState[] {
  const git = (repo: string, args: string[]) => {
    try { return execFileSync('git', ['-C', repo, '--no-optional-locks', ...args], { encoding: 'utf-8', windowsHide: true, timeout: 20000 }).trim(); } catch { return ''; }
  };
  const discover = (dir: string, depth = 0): string[] => {
    if (depth > 3 || !fs.existsSync(dir)) return [];
    if (fs.existsSync(path.join(dir, '.git'))) return [dir];
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const sub = path.join(dir, entry.name);
      found.push(...(fs.existsSync(path.join(sub, '.git')) ? [sub] : discover(sub, depth + 1)));
    }
    return found;
  };
  return discover(path.resolve(mirrorRoot)).sort().map(full => {
    const headSha = git(full, ['rev-parse', 'HEAD']);
    const nearestTag = git(full, ['describe', '--tags', '--abbrev=0']);
    const tagSha = nearestTag ? git(full, ['rev-parse', `${nearestTag}^{commit}`]) : '';
    const status = git(full, ['status', '--porcelain']);
    return {
      relativePath: path.relative(path.resolve(mirrorRoot), full).replace(/\\/g, '/'),
      headSha,
      dirty: status.length > 0,
      nearestTag,
      headEqualsTag: Boolean(nearestTag) && headSha === tagSha,
    };
  });
}

/** version-trust.json 路径：环境变量可覆盖（测试/核验指向临时文件），默认在图谱数据目录 */
export function trustReportPath(): string {
  return process.env.VERSION_TRUST_PATH || path.resolve(resolveGraphDataDir(), 'version-trust.json');
}

let cache: { file: string; mtimeMs: number; report: TrustReport | null } = { file: '', mtimeMs: 0, report: null };

/** 读取判定产物（按 mtime 缓存；文件不存在或损坏时返回 null，调用方静默跳过版本戳） */
export function loadTrustReport(): TrustReport | null {
  const file = trustReportPath();
  try {
    const stat = fs.statSync(file);
    if (cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.report;
    const report = JSON.parse(fs.readFileSync(file, 'utf8')) as TrustReport;
    cache = { file, mtimeMs: stat.mtimeMs, report };
    return report;
  } catch {
    if (cache.file !== file) cache = { file, mtimeMs: 0, report: null };
    return null;
  }
}

/** 写入判定产物到图谱数据目录（与 mirror-health.json、stats.json 同目录） */
export function writeTrustReport(report: TrustReport, file = trustReportPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  cache = { file, mtimeMs: fs.statSync(file).mtimeMs, report };
}

const LEVEL_LABEL: Record<TrustLevel, string> = { approved: '已核准', presumed: '推定', unknown: '未知' };

export interface RepoStamp {
  level: TrustLevel;
  levelLabel: string;
  tag: string;
  shortSha: string;
  dirty: boolean;
  evaluatedAt: string;
}

/** 从相对路径取仓库标识（前两段，如 skt-back/skt_cxy） */
export function repoOfRelPath(relPath: string): string {
  const normalized = relPath.split('\\').join('/');
  return normalized.split('/').slice(0, 2).join('/');
}

/** 取某仓库的版本戳信息；判定产物缺失或没有该仓库时返回 null（调用方静默跳过） */
export function repoStamp(relPath: string): RepoStamp | null {
  const report = loadTrustReport();
  if (!report) return null;
  const repo = report.repos.find(item => item.relativePath === repoOfRelPath(relPath));
  if (!repo) return null;
  return { level: repo.verdict.level, levelLabel: LEVEL_LABEL[repo.verdict.level], tag: repo.nearestTag, shortSha: repo.headSha.slice(0, 7), dirty: repo.dirty, evaluatedAt: report.createdAt };
}

/** 版本行（工具结果头部用）：`【版本】skt-back/skt_cxy @ P1.2.1 (b87627d, 工作区干净) | 档位: 推定 | 判定时刻: …` */
export function formatVersionLine(relPaths: readonly string[]): string | null {
  const stamps = [...new Set(relPaths.map(repoOfRelPath))].map(repo => ({ repo, stamp: repoStamp(repo) })).filter(item => item.stamp);
  if (!stamps.length) return null;
  const parts = stamps.map(item => `${item.repo} @ ${item.stamp!.tag || item.stamp!.shortSha} (${item.stamp!.shortSha}, 工作区${item.stamp!.dirty ? '有未提交改动' : '干净'})`);
  return `【版本】${parts.join(' ; ')} | 档位: ${stamps.map(item => item.stamp!.levelLabel).join('/')} | 判定时刻: ${stamps[0].stamp!.evaluatedAt}`;
}

/** 文件行尾的短版本标识：`@P1.2.1`（无标签时 `@b87627d`）；无判定产物时返回空串 */
export function shortVersionTag(relPath: string): string {
  const stamp = repoStamp(relPath);
  return stamp ? `@${stamp.tag || stamp.shortSha}` : '';
}

let driftCache: { at: number; result: { consistent: boolean; drifted: string[] } | null } = { at: 0, result: null };

/** 快照清单记录的仓库 HEAD 与镜像当前 HEAD 是否一致（60 秒缓存；只读 git，不写任何文件） */
export function mirrorHeadDrift(manifest: { repositories?: Array<{ repo: string; commit: string }> } | null, mirrorRoot: string): { consistent: boolean; drifted: string[] } | null {
  if (!manifest?.repositories?.length || !mirrorRoot) return null;
  const now = Date.now();
  if (driftCache.result && now - driftCache.at < 60_000) return driftCache.result;
  const drifted: string[] = [];
  for (const item of manifest.repositories) {
    try {
      const head = execFileSync('git', ['-C', path.join(mirrorRoot, item.repo), '--no-optional-locks', 'rev-parse', 'HEAD'], { encoding: 'utf-8', windowsHide: true, timeout: 10000 }).trim();
      if (head && head !== item.commit) drifted.push(item.repo);
    } catch { drifted.push(item.repo); }
  }
  const result = { consistent: drifted.length === 0, drifted };
  driftCache = { at: now, result };
  return result;
}

export interface RunPin {
  startedAt: string;
  /** 仓库相对路径 -> 运行起点 HEAD */
  heads: Map<string, string>;
}

/** 运行起点固定：快照各仓库 HEAD（优先从同 mirrorRoot 的已缓存 version-trust.json 读取，避免每轮启动跑 51 个 git 进程；无匹配报告时回退只读 git） */
export function beginRunPin(mirrorRoot: string): RunPin {
  const heads = new Map<string, string>();
  if (!mirrorRoot) return { startedAt: new Date().toISOString(), heads };
  const cached = loadTrustReport();
  if (cached && cached.mirrorRoot && path.resolve(cached.mirrorRoot).toLowerCase() === path.resolve(mirrorRoot).toLowerCase()) {
    for (const repo of cached.repos) if (repo.headSha) heads.set(repo.relativePath, repo.headSha);
    if (heads.size) return { startedAt: new Date().toISOString(), heads };
  }
  for (const state of collectRepoStates(mirrorRoot)) if (state.headSha) heads.set(state.relativePath, state.headSha);
  return { startedAt: new Date().toISOString(), heads };
}

/** 检测某仓库在运行期间是否发生 HEAD 漂移（只读 git） */
export function checkRepoDrift(pin: RunPin, repo: string, mirrorRoot: string): { drifted: boolean; from?: string; to?: string } {
  const from = pin.heads.get(repo);
  if (!from || !mirrorRoot) return { drifted: false };
  let current = '';
  try {
    current = execFileSync('git', ['-C', path.join(mirrorRoot, repo), '--no-optional-locks', 'rev-parse', 'HEAD'], { encoding: 'utf-8', windowsHide: true, timeout: 10000 }).trim();
  } catch { return { drifted: false }; }
  if (!current || current === from) return { drifted: false };
  return { drifted: true, from, to: current };
}

/** 漂移提示行（工具结果头部追加用） */
export function formatDriftLine(repo: string, from: string, to: string): string {
  return `【版本漂移】本次运行期间 ${repo} 已从 ${from.slice(0, 8)} 变为 ${to.slice(0, 8)}，以下结果可能来自不同版本。`;
}

/** 从工具结果文本中提取出现的仓库相对路径（数据核对模式与运行期漂移检测共用） */
export function involvedRepos(texts: readonly string[]): string[] {
  const repos = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/((?:skt-[A-Za-z0-9_.-]+[\\/])+[\w./\\-]+\.(?:java|vue|tsx?|jsx?|sql|xml|yml|yaml|properties))/gi)) {
      repos.add(repoOfRelPath(match[1]));
    }
    for (const match of text.matchAll(/【Git [^】]+】仓库:\s*(skt-[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.-]+)/g)) {
      repos.add(repoOfRelPath(match[1]));
    }
  }
  return [...repos];
}

/** 涉及的仓库里是否存在 unknown 档位（无判定产物时返回 false——不拦截） */
export function hasUnknownInvolvedRepo(texts: readonly string[]): boolean {
  const report = loadTrustReport();
  if (!report) return false;
  const repos = new Set(involvedRepos(texts));
  if (!repos.size) return false;
  return report.repos.some(item => repos.has(item.relativePath) && item.verdict.level === 'unknown');
}
