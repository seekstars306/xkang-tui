import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type UsagePurpose = 'investigation' | 'answer_review' | 'grading' | 'other';

/** 每次付费模型调用的记账记录。不得写入任何密钥、令牌或客户信息。 */
export interface UsageLedgerEntry {
  ts: string;
  task: string;
  model: string;
  purpose: UsagePurpose;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  /** 元记录备注（如输入脱敏事件的工具名、命中条数与键名；不含任何值） */
  detail?: string;
}

/** 台账路径：环境变量 USAGE_LEDGER_PATH 可覆盖（测试指向临时目录），默认落在 git 忽略的 tests/eval/reports/exec-v3/ 下 */
export function usageLedgerPath(): string {
  return process.env.USAGE_LEDGER_PATH || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'eval', 'reports', 'exec-v3', 'usage-ledger.jsonl');
}

/** 追加一条记账记录（JSONL，目录不存在时创建） */
export function appendUsageLedger(entry: UsageLedgerEntry, filePath: string = usageLedgerPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** 读回全部记录（文件不存在时返回空数组；坏行跳过，不中断读取） */
export function readUsageLedger(filePath: string = usageLedgerPath()): UsageLedgerEntry[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as UsageLedgerEntry]; } catch { return []; }
  });
}

/** 按任务汇总 token 用量（不含金额：中转没有价格接口，只记 token） */
export function summarizeUsageLedger(entries: readonly UsageLedgerEntry[]): Array<{ task: string; calls: number; inputTokens: number; outputTokens: number; reasoningTokens: number; cachedTokens: number; failures: number }> {
  const byTask = new Map<string, { task: string; calls: number; inputTokens: number; outputTokens: number; reasoningTokens: number; cachedTokens: number; failures: number }>();
  for (const entry of entries) {
    const row = byTask.get(entry.task) || { task: entry.task, calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, failures: 0 };
    row.calls++;
    row.inputTokens += entry.inputTokens || 0;
    row.outputTokens += entry.outputTokens || 0;
    row.reasoningTokens += entry.reasoningTokens || 0;
    row.cachedTokens += entry.cachedTokens || 0;
    if (!entry.ok) row.failures++;
    byTask.set(entry.task, row);
  }
  return [...byTask.values()].sort((a, b) => b.inputTokens - a.inputTokens);
}
