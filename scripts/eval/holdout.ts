// 留出集冻结与核对（P1 测量地基）。留出集必须在任何调优之前冻结，冻结后不得增删；
// 确需变更走 --refreeze 并写明理由，旧清单留档 .prev。预登记判定线随清单一并落盘，冻结后任何改动都会在 diff 里显形。
// 工单目录被 .gitignore 的 `data/` 规则忽略（tests/eval/data/**），工单原文只落在这里，不进 git、不进对话。
// 用法：
//   node --import tsx scripts/eval/holdout.ts --init
//   node --import tsx scripts/eval/holdout.ts --freeze [--seed=20261016]
//   node --import tsx scripts/eval/holdout.ts --refreeze --reason="..."
//   node --import tsx scripts/eval/holdout.ts --verify
//   node --import tsx scripts/eval/holdout.ts --stats
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TICKET_DIR = path.resolve('tests/eval/data/tickets');
export const MANIFEST_FILE = 'holdout-manifest.json';
export const README_FILE = 'README.md';
export const DEFAULT_SEED = 20261016;

export const REQUIRED_FIELDS = [
  'ticket_id',
  'business_line',
  'question_type',
  'core_demand',
  'event_time',
  'snapshot_time',
  'services',
  'answerable',
  'background',
  'attachments',
  'deidentified',
  'question',
] as const;
export const QUESTION_TYPES = ['current_rule', 'historical_event', 'specific_order'] as const;

/** 预登记判定线：改这里等于改判定线。冻结之后必须同时更新清单并写明理由。 */
export const PREREGISTERED_THRESHOLDS = {
  source: ['docs/exec-plan-v3/00-README.md §5', 'plan-gemini-high-v2.md:115', 'docs/exec-plan-v3/60-phase5-pilot.md'],
  pilot: { deliveredConclusions: 60, deliveredAccuracy: 0.9, severe: 0 },
  release: { holdoutTickets: 150, minTickets: 100, coverageLower: 0.7, deliveredAccuracyCpLower: 0.9, severe: 0, withinBudgetRatio: 0.95 },
  frozenOrder: { seed: DEFAULT_SEED, method: 'sha256(ticket_id) 定序后用 mulberry32(seed) 洗牌；冻结后顺序与逐文件 sha256 一起写进清单' },
  notes: '所有阈值只在留出集上计算；开发集结果不得用于宣称准确率提升。',
} as const;

export const TICKET_README = `# 留出集工单目录（git 忽略）

本目录存放 P1 工单集。\`tests/eval/data/**\` 被 \`.gitignore\` 的 \`data/\` 规则忽略：
**工单原文、单号、客户信息只能落在这里**，不得写进任何被 git 跟踪的文件、\`STATUS.md\`、报告或对话。

## 每题一个 JSON

文件名必须等于 \`ticket_id\`：\`<ticket_id>.json\`。

| 字段 | 含义 |
|---|---|
| ticket_id | 题号（文件名同此值） |
| business_line | 业务线（机票/酒店/火车票/打车/其他…） |
| question_type | \`current_rule\`（现行规则） / \`historical_event\`（历史事件） / \`specific_order\`（具体订单） |
| core_demand | 客服的核心诉求（不是提问表面话术） |
| event_time | 业务事件发生时间（下单/提交/开票/扣款） |
| snapshot_time | 本次排查拿到的数据快照时间 |
| services | 涉及的线上服务名单 |
| answerable | 现有数据能否回答（不能回答时，正确输出就是诚实降级） |
| background | 工单背景 |
| attachments | 附件清单（截图文件名等；图片本体另存，不写进本文件） |
| deidentified | 是否已脱敏 |
| question | 客服提问原文 |

可选：\`ground_truth\`（开发核对过的要点草稿）、\`code_version\`（事件发生时的代码版本，历史事件题必填）。

## 冻结流程

1. 把工单放进本目录（\`--init\` 已建好说明）；
2. \`node --import tsx scripts/eval/holdout.ts --freeze\`：校验字段 → 固定种子洗牌 → 逐文件 sha256 → 写 \`holdout-manifest.json\`；
3. 冻结后只允许 \`--verify\`（核对漂移/新增/缺失）与 \`--stats\`；
4. 确需增删：\`--refreeze --reason="..."\`，旧清单留档为 \`holdout-manifest.json.prev\`，理由进清单。

判定线（预登记，见脚本 \`PREREGISTERED_THRESHOLDS\`）：试点 ≥60 个已交付结论、点估计 ≥90%、严重误导 0；
上线 150 单（最低 100）、覆盖率下限 ≥70%、交付答案正确率单侧 95% CP 下限 ≥90%、严重误导 0、≥95% 在预算内完成。
`;

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LoadedTicket {
  file: string;
  raw: string;
  ticket: any;
}

export function ensureTicketDir(dir = DEFAULT_TICKET_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  const readmePath = path.join(dir, README_FILE);
  if (!fs.existsSync(readmePath)) fs.writeFileSync(readmePath, TICKET_README, 'utf8');
}

export function loadTickets(dir = DEFAULT_TICKET_DIR): LoadedTicket[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.json') && name !== MANIFEST_FILE && !name.endsWith('.prev'))
    .sort()
    .map(name => {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      let ticket: any = null;
      try {
        ticket = JSON.parse(raw);
      } catch {
        ticket = null;
      }
      return { file: name, raw, ticket };
    });
}

export function validateTicket(ticket: any, fileName?: string): string[] {
  const errors: string[] = [];
  if (!ticket || typeof ticket !== 'object') {
    errors.push('内容不是 JSON 对象');
    return errors;
  }
  for (const field of REQUIRED_FIELDS) {
    const value = ticket[field];
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) errors.push(`缺少字段 ${field}`);
  }
  if (typeof ticket.answerable !== 'boolean') errors.push('字段 answerable 必须是布尔值');
  if (typeof ticket.deidentified !== 'boolean') errors.push('字段 deidentified 必须是布尔值');
  if (!QUESTION_TYPES.includes(ticket.question_type)) errors.push(`字段 question_type 必须是 ${QUESTION_TYPES.join(' / ')} 之一`);
  for (const field of ['services', 'attachments'] as const) {
    if (ticket[field] !== undefined && !Array.isArray(ticket[field])) errors.push(`字段 ${field} 应为数组`);
  }
  if (typeof ticket.question === 'string' && ticket.question.trim().length < 8) errors.push('字段 question 太短，应放客服提问原文');
  if (fileName && typeof ticket.ticket_id === 'string' && ticket.ticket_id && path.basename(fileName, '.json') !== ticket.ticket_id) {
    errors.push(`文件名应与 ticket_id 一致（应为 ${ticket.ticket_id}.json）`);
  }
  return errors;
}

export function collectErrors(tickets: LoadedTicket[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const item of tickets) {
    for (const error of validateTicket(item.ticket, item.file)) errors.push(`${item.file}: ${error}`);
    const id = typeof item.ticket?.ticket_id === 'string' ? item.ticket.ticket_id : '';
    if (id && seen.has(id)) errors.push(`${item.file}: ticket_id 重复（${id}）`);
    if (id) seen.add(id);
  }
  return errors;
}

export interface HoldoutOrderEntry {
  ticket_id: string;
  file: string;
  sha256: string;
}
export interface HoldoutManifest {
  frozenAt: string;
  seed: number;
  ticketCount: number;
  order: HoldoutOrderEntry[];
  manifestHash: string;
  thresholds: typeof PREREGISTERED_THRESHOLDS;
  reason?: string;
  ticketDir: string;
}

export function freezeHoldout(options: { dir?: string; seed?: number; reason?: string; force?: boolean; now?: Date } = {}): HoldoutManifest {
  const dir = options.dir || DEFAULT_TICKET_DIR;
  const tickets = loadTickets(dir);
  if (!tickets.length) throw new Error(`留出集为空：先把工单 JSON 放进 ${dir}（字段与流程见 ${README_FILE}）`);
  const errors = collectErrors(tickets);
  if (errors.length) throw new Error(`留出集校验未通过：\n- ${errors.join('\n- ')}`);

  const manifestPath = path.join(dir, MANIFEST_FILE);
  const existed = fs.existsSync(manifestPath);
  const reason = (options.reason || '').trim();
  if (existed && !options.force) {
    throw new Error(`清单已存在（${manifestPath}）：留出集冻结后不得增删。确需变更请用 --refreeze --reason="..."`);
  }
  if (existed && options.force) {
    if (reason.length < 8) throw new Error('--refreeze 必须给出不少于 8 个字的理由（理由会写进清单）');
    fs.copyFileSync(manifestPath, `${manifestPath}.prev`);
  }

  const seed = options.seed ?? DEFAULT_SEED;
  const rng = mulberry32(seed);
  const ordered = tickets
    .slice()
    .sort((a, b) => sha256(String(a.ticket?.ticket_id)).localeCompare(sha256(String(b.ticket?.ticket_id))));
  for (let i = ordered.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  }
  const order: HoldoutOrderEntry[] = ordered.map(item => ({
    ticket_id: String(item.ticket.ticket_id),
    file: item.file,
    sha256: sha256(item.raw),
  }));
  const manifest: HoldoutManifest = {
    frozenAt: (options.now || new Date()).toISOString(),
    seed,
    ticketCount: order.length,
    order,
    manifestHash: sha256(JSON.stringify(order)),
    thresholds: PREREGISTERED_THRESHOLDS,
    ...(reason ? { reason } : {}),
    ticketDir: dir,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export interface VerifyResult {
  ok: boolean;
  manifest: HoldoutManifest;
  drifted: string[];
  added: string[];
  missing: string[];
  errors: string[];
}

export function verifyHoldout(options: { dir?: string } = {}): VerifyResult {
  const dir = options.dir || DEFAULT_TICKET_DIR;
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) throw new Error(`没找到清单 ${manifestPath}：先运行 --freeze`);
  const manifest: HoldoutManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const tickets = loadTickets(dir);
  const recorded = new Map(manifest.order.map(entry => [entry.ticket_id, entry]));
  const present = new Set<string>();
  const drifted: string[] = [];
  const added: string[] = [];
  for (const item of tickets) {
    const id = String(item.ticket?.ticket_id ?? '');
    present.add(id);
    const entry = recorded.get(id);
    if (!entry) added.push(id || item.file);
    else if (entry.sha256 !== sha256(item.raw)) drifted.push(id);
  }
  const missing = manifest.order.filter(entry => !present.has(entry.ticket_id)).map(entry => entry.ticket_id);
  const errors = collectErrors(tickets);
  return { ok: !drifted.length && !added.length && !missing.length && !errors.length, manifest, drifted, added, missing, errors };
}

export interface HoldoutStats {
  total: number;
  answerable: number;
  unanswerable: number;
  byLine: Record<string, number>;
  byType: Record<string, number>;
  withoutGroundTruth: number;
}

export function holdoutStats(tickets: LoadedTicket[]): HoldoutStats {
  const byLine: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let answerable = 0;
  let withoutGroundTruth = 0;
  for (const item of tickets) {
    const line = String(item.ticket?.business_line || '其他');
    const type = String(item.ticket?.question_type || '未标');
    byLine[line] = (byLine[line] || 0) + 1;
    byType[type] = (byType[type] || 0) + 1;
    if (item.ticket?.answerable === true) answerable++;
    if (!String(item.ticket?.ground_truth || '').trim()) withoutGroundTruth++;
  }
  return { total: tickets.length, answerable, unanswerable: tickets.length - answerable, byLine, byType, withoutGroundTruth };
}

const isMain = (() => {
  try {
    return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
  } catch {
    return false;
  }
})();

if (isMain) {
  const flagValue = (name: string): string | undefined => {
    const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const mode = ['--init', '--freeze', '--refreeze', '--verify', '--stats'].find(flag => process.argv.includes(flag));
  try {
    if (mode === '--init') {
      ensureTicketDir();
      console.log(`目录已就绪：${DEFAULT_TICKET_DIR}（说明 ${README_FILE}）`);
    } else if (mode === '--freeze' || mode === '--refreeze') {
      const seedArg = flagValue('seed');
      const manifest = freezeHoldout({
        seed: seedArg ? Number(seedArg) : undefined,
        reason: flagValue('reason'),
        force: mode === '--refreeze',
      });
      console.log(`已冻结 ${manifest.ticketCount} 单；seed=${manifest.seed}；manifestHash=${manifest.manifestHash.slice(0, 16)}…`);
      if (manifest.ticketCount < PREREGISTERED_THRESHOLDS.release.minTickets) {
        console.log(`提示：上线口径要 ${PREREGISTERED_THRESHOLDS.release.holdoutTickets} 单（最低 ${PREREGISTERED_THRESHOLDS.release.minTickets}），当前 ${manifest.ticketCount} 单；后续追加必须走 --refreeze --reason="..."`);
      }
    } else if (mode === '--verify') {
      const result = verifyHoldout();
      console.log(
        JSON.stringify(
          { ok: result.ok, ticketCount: result.manifest.ticketCount, drifted: result.drifted, added: result.added, missing: result.missing, errors: result.errors },
          null,
          2,
        ),
      );
      if (!result.ok) process.exitCode = 1;
    } else if (mode === '--stats') {
      console.log(JSON.stringify(holdoutStats(loadTickets()), null, 2));
    } else {
      console.log('用法：--init | --freeze [--seed=N] | --refreeze --reason="..." | --verify | --stats');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
