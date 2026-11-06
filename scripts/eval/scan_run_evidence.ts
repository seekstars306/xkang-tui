// M1 第一步：对 120 次受控运行的工具结果做确定性扫描（不调模型），输出布尔事实列。
// 事实列是金标准（程序可复现）；归因判断在 build_attribution_sheet.ts 中做，是银标签。
// 用法: node --import tsx scripts/eval/scan_run_evidence.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const RUNS_DIR = path.resolve('tests/eval/reports/server-harness-20261009/acceptance-verified');
const MIRROR = process.env.CODE_REPO_PATH || 'D:\\skt_project';
const OUT_DIR = path.resolve('tests/eval/reports/exec-v3');

export interface RunFacts {
  runId: string;
  variant: string;
  caseId: string;
  round: number;
  toolMessages: number;
  sawExcludedPath: boolean;
  excludedPathHits: string[];
  sawDuplicateBasename: boolean;
  duplicateBasenameHits: string[];
  sawNewOldDir: boolean;
  newOldDirHits: string[];
  sawHistoricalDoc: boolean;
  historicalDocHits: string[];
  sawDirtyMirror: boolean;
  dirtyMirrorHits: string[];
  toolFailures: number;
  reviewStatus: string | null;
  reviewUnavailable: boolean;
  reviewTimeout: boolean;
  reviewFalseActionBlock: boolean;
  reviewIssues: string[];
}

const EXCLUDED_PATH = /prod-config|\.bak(\.|$)|\.old\b|node_modules/;
const NEW_OLD_DIR = /orderNew|invoiceNew|hotelNew|entityOld|[A-Za-z0-9_]+_old\b/;
const HISTORICAL_DOC = /CODE_REVIEW_ISSUES\.md/;
// 2026-10-10 镜像换装前未提交的两个酒店文件（保全副本的 basename，见 mirror-reclone 报告的 preserved-local-changes）
const DIRTY_MIRROR_FILES = ['SktHotelCLOrderServiceImpl.java', 'SktHotelOrderUseServiceImpl.java'];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full); else out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** skt_cxy 与 skt_dpxt_background 的同 basename 集合（2026-10-15 实测 2527 个；旧文档记 296 已修正） */
export function collectDuplicateBasenames(mirror = MIRROR): Set<string> {
  const repos = ['skt-back/skt_cxy', 'skt-back/skt_dpxt_background'].map(rel => path.join(mirror, rel));
  const [a, b] = repos.map(repo => new Set(listFiles(repo).map(file => path.basename(file))));
  return new Set([...b].filter(name => a.has(name)));
}

/** 从工具结果文本中提取出现的文件名 token（路径最后一段） */
function mentionedBasenames(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/[\w.\-]+\.(?:java|vue|tsx?|jsx?|sql|xml|yml|yaml|properties|md|json|png|jks|p12|pfx|pem|key)\b/gi)) names.add(match[0]);
  return names;
}

export function scanRun(runDir: string, duplicateBasenames: ReadonlySet<string>): RunFacts {
  const runId = path.basename(runDir);
  const [variant, caseId, round] = runId.split('-');
  const messages = JSON.parse(fs.readFileSync(path.join(runDir, 'messages.json'), 'utf8')) as any[];
  const facts: RunFacts = {
    runId, variant, caseId, round: Number(round),
    toolMessages: 0,
    sawExcludedPath: false, excludedPathHits: [],
    sawDuplicateBasename: false, duplicateBasenameHits: [],
    sawNewOldDir: false, newOldDirHits: [],
    sawHistoricalDoc: false, historicalDocHits: [],
    sawDirtyMirror: false, dirtyMirrorHits: [],
    toolFailures: 0,
    reviewStatus: null, reviewUnavailable: false, reviewTimeout: false, reviewFalseActionBlock: false,
    reviewIssues: [],
  };
  messages.forEach((message, index) => {
    if (message.role === 'tool') {
      facts.toolMessages++;
      if (message.evidence && message.evidence.outcome !== 'success') facts.toolFailures++;
      const text = String(message.content ?? '');
      const excluded = EXCLUDED_PATH.exec(text);
      if (excluded && !facts.excludedPathHits.includes(excluded[0])) facts.excludedPathHits.push(excluded[0]);
      const newOld = NEW_OLD_DIR.exec(text);
      if (newOld && !facts.newOldDirHits.includes(newOld[0])) facts.newOldDirHits.push(newOld[0]);
      const historical = HISTORICAL_DOC.exec(text);
      if (historical) facts.historicalDocHits.push(`msg[${index}]`);
      for (const name of DIRTY_MIRROR_FILES) if (text.includes(name)) facts.dirtyMirrorHits.push(`msg[${index}]:${name}`);
      if (duplicateBasenames.size) {
        for (const name of mentionedBasenames(text)) if (duplicateBasenames.has(name)) facts.duplicateBasenameHits.push(`msg[${index}]:${name}`);
      }
    }
    if (message.review) {
      facts.reviewStatus = message.review.status ?? null;
      if (message.review.status === 'unavailable') facts.reviewUnavailable = true;
      if (/deadline|超时|timeout/i.test(String(message.review.diagnostic || ''))) facts.reviewTimeout = true;
      if ((message.review.issues || []).some((issue: string) => issue.includes('没有动作执行记录'))) facts.reviewFalseActionBlock = true;
      facts.reviewIssues.push(...(message.review.issues || []).map((issue: string) => `msg[${index}]:${issue}`));
    }
  });
  facts.sawExcludedPath = facts.excludedPathHits.length > 0;
  facts.sawDuplicateBasename = facts.duplicateBasenameHits.length > 0;
  facts.sawNewOldDir = facts.newOldDirHits.length > 0;
  facts.sawHistoricalDoc = facts.historicalDocHits.length > 0;
  facts.sawDirtyMirror = facts.dirtyMirrorHits.length > 0;
  return facts;
}

async function main(): Promise<void> {
  const duplicateBasenames = collectDuplicateBasenames();
  console.log(`同 basename 集合: ${duplicateBasenames.size} 个（skt_cxy vs skt_dpxt_background）`);
  const runDirs = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^(baseline|candidate)-.+-\d+$/.test(e.name) && fs.existsSync(path.join(RUNS_DIR, e.name, 'messages.json')))
    .map(e => e.name).sort();
  const facts = runDirs.map(runId => scanRun(path.join(RUNS_DIR, runId), duplicateBasenames));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const header = ['run_id', 'variant', 'caseId', 'round', 'toolMessages', 'saw_excluded_path', 'saw_duplicate_basename', 'saw_new_old_dir', 'saw_historical_doc', 'saw_dirty_mirror', 'toolFailures', 'reviewStatus', 'reviewUnavailable', 'reviewTimeout', 'reviewFalseActionBlock'].join('\t');
  const rows = facts.map(f => [f.runId, f.variant, f.caseId, f.round, f.toolMessages, f.sawExcludedPath, f.sawDuplicateBasename, f.sawNewOldDir, f.sawHistoricalDoc, f.sawDirtyMirror, f.toolFailures, f.reviewStatus ?? '', f.reviewUnavailable, f.reviewTimeout, f.reviewFalseActionBlock].join('\t'));
  fs.writeFileSync(path.join(OUT_DIR, 'scan-facts.tsv'), [header, ...rows].join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'scan-facts.json'), JSON.stringify(facts, null, 2));
  const count = (predicate: (f: RunFacts) => boolean) => facts.filter(predicate).length;
  console.log(`扫描 ${facts.length} 个运行: 命中排除路径 ${count(f => f.sawExcludedPath)} | 同名文件 ${count(f => f.sawDuplicateBasename)} | 新旧目录 ${count(f => f.sawNewOldDir)} | 历史文档 ${count(f => f.sawHistoricalDoc)} | 当时脏文件 ${count(f => f.sawDirtyMirror)} | 工具失败 ${count(f => f.toolFailures > 0)} | 复核 unavailable ${count(f => f.reviewUnavailable)} | 复核超时 ${count(f => f.reviewTimeout)} | performed_action 误拦 ${count(f => f.reviewFalseActionBlock)}`);
  console.log('产物: tests/eval/reports/exec-v3/scan-facts.tsv / scan-facts.json');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
