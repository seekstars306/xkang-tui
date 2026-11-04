// V1：部署清单校验器。校验 schema、artifactSha256 格式、commit 在镜像对应子仓库中可解析，
// 并检查服务名覆盖 list_log_apps 实测返回的 9 个服务（缺口即"版本未知"）。
// 用法: node --import tsx scripts/eval/validate_deployment_manifest.ts [manifest.json] [--strict]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';

const MIRROR = process.env.CODE_REPO_PATH || (() => { const env = dotenv.parse(fs.readFileSync('server/.env')); return env.CODE_REPO_PATH || 'D:\\skt_project'; })();
/** list_log_apps 在 cxy 命名空间的实测返回（2026-10-14，T0.5 核对） */
const EXPECTED_SERVICES = ['cxy-web', 'cxy-booking', 'cxy-hotel', 'cxy-ibe', 'cxy-sms', 'cxy-mq-n', 'cxy-mq-time', 'cxy-remote-aircz', 'cxy-web-timer'];
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

export interface ManifestEntry {
  service: string;
  repo: string;
  environment: string;
  artifact: string;
  artifactSha256: string;
  commit: string;
  tag?: string;
  effectiveAt: string;
}
export interface DeploymentManifest {
  generatedAt: string;
  approvedBy: string;
  entries: ManifestEntry[];
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  entry: string;
  message: string;
}

export function validateManifest(manifest: DeploymentManifest, options: { mirror?: string; requireResolvable?: boolean } = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!manifest || typeof manifest !== 'object') return [{ level: 'error', entry: '(manifest)', message: '不是合法 JSON 对象' }];
  if (!manifest.generatedAt) issues.push({ level: 'warning', entry: '(manifest)', message: '缺少 generatedAt' });
  if (!manifest.approvedBy || manifest.approvedBy.startsWith('<')) issues.push({ level: 'warning', entry: '(manifest)', message: 'approvedBy 未填写真实姓名' });
  if (!Array.isArray(manifest.entries) || !manifest.entries.length) { issues.push({ level: 'error', entry: '(manifest)', message: 'entries 为空或不是数组' }); return issues; }

  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    const label = entry?.service || '(未命名服务)';
    if (seen.has(entry.service)) issues.push({ level: 'error', entry: label, message: '服务条目重复' });
    seen.add(entry.service);
    for (const field of ['service', 'repo', 'environment', 'artifact', 'artifactSha256', 'commit', 'effectiveAt'] as const) {
      if (!entry[field] || typeof entry[field] !== 'string') issues.push({ level: 'error', entry: label, message: `缺少字段 ${field}` });
    }
    if (entry.artifactSha256 && !SHA256_RE.test(entry.artifactSha256)) issues.push({ level: 'error', entry: label, message: `artifactSha256 不是 64 位十六进制: ${entry.artifactSha256.slice(0, 12)}…` });
    if (entry.commit && !COMMIT_RE.test(entry.commit)) issues.push({ level: 'error', entry: label, message: `commit 不是 7-40 位十六进制: ${entry.commit.slice(0, 12)}…` });
    if (entry.environment && entry.environment !== 'prod') issues.push({ level: 'warning', entry: label, message: `environment 为 ${entry.environment}（生产判定只认 prod）` });

    const repoDir = path.join(options.mirror || MIRROR, entry.repo || '');
    if (entry.repo && !fs.existsSync(path.join(repoDir, '.git'))) {
      issues.push({ level: options.requireResolvable ? 'error' : 'warning', entry: label, message: `repo 在镜像中不存在或不是 git 仓库: ${entry.repo}` });
      continue;
    }
    if (entry.commit && options.requireResolvable) {
      try {
        execFileSync('git', ['-C', repoDir, '--no-optional-locks', 'rev-parse', '--verify', `${entry.commit}^{commit}`], { encoding: 'utf-8', windowsHide: true, timeout: 15000 });
      } catch {
        issues.push({ level: 'error', entry: label, message: `commit 在 ${entry.repo} 中无法解析（rev-parse --verify 失败）` });
      }
    }
  }

  for (const service of EXPECTED_SERVICES) {
    if (!seen.has(service)) issues.push({ level: 'warning', entry: service, message: 'list_log_apps 实测存在的服务没有部署清单条目——该服务只能判"版本未知"' });
  }
  for (const service of seen) {
    if (!EXPECTED_SERVICES.includes(service)) issues.push({ level: 'warning', entry: service, message: '清单包含 list_log_apps 实测返回之外的服务名，请核对' });
  }
  return issues;
}

function main(): void {
  const strict = process.argv.includes('--strict');
  const target = process.argv.find(arg => !arg.startsWith('--') && arg.endsWith('.json')) || 'docs/exec-plan-v3/deployment-manifest.example.json';
  const manifest = JSON.parse(fs.readFileSync(target, 'utf8')) as DeploymentManifest;
  const issues = validateManifest(manifest, { requireResolvable: strict });
  const errors = issues.filter(i => i.level === 'error');
  const warnings = issues.filter(i => i.level === 'warning');
  for (const issue of issues) console.log(`[${issue.level === 'error' ? '错误' : '提醒'}] ${issue.entry}: ${issue.message}`);
  console.log(`校验 ${path.basename(target)}: ${manifest.entries?.length ?? 0} 条条目，错误 ${errors.length}，提醒 ${warnings.length}${strict ? '（--strict：commit 必须可在镜像解析）' : ''}`);
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('validate_deployment_manifest.ts')) main();
