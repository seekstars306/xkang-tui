// 每日客服真实问题实测记录与统计工具（衔接 Phase 5 P1 工单集与 M4 统计口径）。
// 默认文件路径：tests/eval/data/daily-tickets.tsv（被 git 忽略，可安全存放真实单号与客户问题）。
// 用法：
//   1. 查看当前累计统计与置信区间：
//      npx tsx scripts/eval/daily_tickets.ts
//   2. 命令行快速追加一条今日测试记录：
//      npx tsx scripts/eval/daily_tickets.ts --add --line=机票 --type=具体订单排障 --answerable=true --verdict=delivered_correct --question="客服原话" --demand="核心诉求" --truth="研发查实结果" --note="备注"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { binomialTailGE, clopperPearsonLower, clopperPearsonUpper, wilsonInterval } from '../../server/src/stats.ts';

export const DEFAULT_DAILY_TSV = path.resolve('tests/eval/data/daily-tickets.tsv');

export type DailyVerdict =
  | 'delivered_correct' // 已交付且整答全对（结论+数据+范围+话术均对）
  | 'delivered_partial' // 已交付但部分对/有瑕疵（按严格整答口径计入 wrong）
  | 'unresolved_honest' // 诚实待核实（未给错误结论，已查事实全对）
  | 'wrong'             // 结论或数据错误
  | 'severe';           // 严重误导（错资金建议/虚构已执行动作/承诺时效/泄露内部信息）

export interface DailyTicketRow {
  ticketId: string;
  date: string;
  businessLine: string;
  questionType: string;
  answerable: boolean;
  coreDemand: string;
  question: string;
  groundTruth: string;
  verdict: DailyVerdict;
  failureCategory: string;
  notes: string;
}

export const TSV_HEADER = [
  'ticket_id',
  'date',
  'business_line',
  'question_type',
  'answerable',
  'core_demand',
  'question',
  'ground_truth',
  'verdict',
  'failure_category',
  'notes',
].join('\t');

const cleanCell = (value: string) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();

export function ensureDailyTicketSheet(filePath = DEFAULT_DAILY_TSV): void {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${TSV_HEADER}\n`, 'utf8');
}

export function parseDailyTickets(filePath = DEFAULT_DAILY_TSV): DailyTicketRow[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line, idx) => {
    const cols = line.split('\t');
    const rawVerdict = (cols[8] || '').trim() as DailyVerdict;
    const verdict: DailyVerdict = ['delivered_correct', 'delivered_partial', 'unresolved_honest', 'wrong', 'severe'].includes(rawVerdict)
      ? rawVerdict
      : 'wrong';
    return {
      ticketId: (cols[0] || `T${String(idx + 1).padStart(3, '0')}`).trim(),
      date: (cols[1] || '').trim(),
      businessLine: (cols[2] || '其他').trim(),
      questionType: (cols[3] || '具体订单排障').trim(),
      answerable: !['false', '0', '否', '不能'].includes((cols[4] || 'true').trim().toLowerCase()),
      coreDemand: (cols[5] || '').trim(),
      question: (cols[6] || '').trim(),
      groundTruth: (cols[7] || '').trim(),
      verdict,
      failureCategory: (cols[9] || '').trim(),
      notes: (cols[10] || '').trim(),
    };
  });
}

export function appendDailyTicket(row: Omit<DailyTicketRow, 'ticketId'> & { ticketId?: string }, filePath = DEFAULT_DAILY_TSV): DailyTicketRow {
  ensureDailyTicketSheet(filePath);
  const existing = parseDailyTickets(filePath);
  const ticketId = row.ticketId || `D${String(existing.length + 1).padStart(3, '0')}`;
  const full: DailyTicketRow = { ...row, ticketId };
  const line = [
    full.ticketId,
    full.date,
    full.businessLine,
    full.questionType,
    full.answerable ? '能' : '不能',
    full.coreDemand,
    full.question,
    full.groundTruth,
    full.verdict,
    full.failureCategory,
    full.notes,
  ].map(cleanCell).join('\t');
  fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  return full;
}

export interface DailySummary {
  total: number;
  answerableCount: number;
  deliveredCount: number;
  deliveredCorrectCount: number;
  deliveredPartialCount: number;
  unresolvedHonestCount: number;
  wrongCount: number;
  severeCount: number;
  /** 覆盖率（已交付数 / 可回答工单数；若可回答为 0 则按总工单数） */
  coverage: number;
  coverageCpLower: number;
  /** 已交付整答正确率（delivered_correct / deliveredCount） */
  deliveredAccuracy: number;
  accuracyCpLower: number;
  accuracyWilson: { lower: number; upper: number };
  /** 严重误导率及单侧 95% Clopper-Pearson 上界 */
  severeRate: number;
  severeCpUpper: number;
  byLine: Record<string, number>;
  byFailureCategory: Record<string, number>;
}

export function summarizeDailyTickets(rows: readonly DailyTicketRow[]): DailySummary {
  const total = rows.length;
  const answerableCount = rows.filter(r => r.answerable).length;
  const deliveredCorrectCount = rows.filter(r => r.verdict === 'delivered_correct').length;
  const deliveredPartialCount = rows.filter(r => r.verdict === 'delivered_partial').length;
  const unresolvedHonestCount = rows.filter(r => r.verdict === 'unresolved_honest').length;
  const wrongCount = rows.filter(r => r.verdict === 'wrong').length;
  const severeCount = rows.filter(r => r.verdict === 'severe').length;
  // 已交付工单 = 给出了业务结论的工单（全对 + 部分对 + 答错 + 严重误导）
  const deliveredCount = deliveredCorrectCount + deliveredPartialCount + wrongCount + severeCount;
  const covDenom = answerableCount || total;
  const covNum = rows.filter(r => r.answerable && r.verdict !== 'unresolved_honest').length;
  const coverage = covDenom > 0 ? covNum / covDenom : 0;
  const coverageCpLower = covDenom > 0 ? clopperPearsonLower(covNum, covDenom, 0.05) : 0;

  const deliveredAccuracy = deliveredCount > 0 ? deliveredCorrectCount / deliveredCount : 0;
  const accuracyCpLower = deliveredCount > 0 ? clopperPearsonLower(deliveredCorrectCount, deliveredCount, 0.05) : 0;
  const accuracyWilson = deliveredCount > 0
    ? { lower: wilsonInterval(deliveredCorrectCount, deliveredCount, 0.05).lower, upper: wilsonInterval(deliveredCorrectCount, deliveredCount, 0.05).upper }
    : { lower: 0, upper: 0 };

  const severeRate = total > 0 ? severeCount / total : 0;
  const severeCpUpper = total > 0 ? clopperPearsonUpper(severeCount, total, 0.05) : 1;

  const byLine: Record<string, number> = {};
  const byFailureCategory: Record<string, number> = {};
  for (const r of rows) {
    byLine[r.businessLine || '其他'] = (byLine[r.businessLine || '其他'] || 0) + 1;
    if (r.verdict !== 'delivered_correct' && r.verdict !== 'unresolved_honest') {
      const cat = r.failureCategory || '未分类';
      byFailureCategory[cat] = (byFailureCategory[cat] || 0) + 1;
    }
  }

  return {
    total,
    answerableCount,
    deliveredCount,
    deliveredCorrectCount,
    deliveredPartialCount,
    unresolvedHonestCount,
    wrongCount,
    severeCount,
    coverage,
    coverageCpLower,
    deliveredAccuracy,
    accuracyCpLower,
    accuracyWilson,
    severeRate,
    severeCpUpper,
    byLine,
    byFailureCategory,
  };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function getArg(name: string): string | undefined {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = getArg('file') ? path.resolve(getArg('file')!) : DEFAULT_DAILY_TSV;
  ensureDailyTicketSheet(file);
  if (process.argv.includes('--add')) {
    const added = appendDailyTicket({
      date: getArg('date') || new Date().toISOString().slice(0, 10),
      businessLine: getArg('line') || '其他',
      questionType: getArg('type') || '具体订单排障',
      answerable: getArg('answerable') !== 'false' && getArg('answerable') !== '不能',
      coreDemand: getArg('demand') || '',
      question: getArg('question') || '',
      groundTruth: getArg('truth') || '',
      verdict: (getArg('verdict') as DailyVerdict) || 'delivered_correct',
      failureCategory: getArg('category') || '',
      notes: getArg('note') || '',
    }, file);
    console.log(`已记录工单 ${added.ticketId} -> ${file}`);
  }
  const rows = parseDailyTickets(file);
  if (!rows.length) {
    console.log(`记录表已就绪：${file}（当前 0 条记录，可直接用 Excel/文本编辑器按行填写，或用 --add 追加）`);
    process.exit(0);
  }
  const s = summarizeDailyTickets(rows);
  console.log(`=== 每日真实客服工单实测累计报告（共 ${s.total} 单，可回答 ${s.answerableCount} 单）===`);
  console.log(`1. 覆盖率: ${pct(s.coverage)}（单侧 95% CP 下界: ${pct(s.coverageCpLower)}，目标初值 ≥ 70%）`);
  console.log(`2. 交付整答正确率: ${s.deliveredCorrectCount}/${s.deliveredCount} = ${pct(s.deliveredAccuracy)}（单侧 95% CP 下界: ${pct(s.accuracyCpLower)}，Wilson 双侧: [${pct(s.accuracyWilson.lower)}, ${pct(s.accuracyWilson.upper)}]）`);
  console.log(`   - 其中整答全对: ${s.deliveredCorrectCount} | 部分对(有瑕疵): ${s.deliveredPartialCount} | 答错: ${s.wrongCount} | 诚实待核实: ${s.unresolvedHonestCount}`);
  console.log(`3. 严重误导: ${s.severeCount}/${s.total} = ${pct(s.severeRate)}（单侧 95% CP 上界: ${pct(s.severeCpUpper)}，红线要求 = 0）`);
  console.log(`4. 业务线分布: ${JSON.stringify(s.byLine)}`);
  if (Object.keys(s.byFailureCategory).length) {
    console.log(`5. 错因分布: ${JSON.stringify(s.byFailureCategory)}`);
  }
  if (s.total < 60) {
    console.log(`提示: 当前样本量 ${s.total} 单属于摸底阶段，用于校准覆盖率与错因构成（满 30～40 单即可跑 A/B 盲评对照）。`);
  }
}
