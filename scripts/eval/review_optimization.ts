import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Message } from '@xkang/agent-core';
import { reviewAnswer } from '../../server/src/agent/review.ts';
import { BusinessModel } from '../../server/src/agent/model.ts';
import { loadServerEnv } from '../../tests/helpers/isolated_server.ts';
import { BENCHMARK_CASES as allCases } from './review_benchmark_cases.ts';
import { appendUsageLedger } from './usage_ledger.ts';

// CLI: --task=S7|M2|M3（写台账用） --cases=fictional|all --variant=candidate|baseline|both --concurrency=1 --ids=id1,id2
const argOf = (name: string, fallback: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const TASK = argOf('task', 'M2');
const CASES = argOf('cases', 'all');
const VARIANT = argOf('variant', 'both');
const CONCURRENCY = Math.max(1, Number(argOf('concurrency', '1')) || 1);
const IDS = argOf('ids', '').split(',').filter(Boolean);
const PARTIAL_PUBLISH = process.argv.includes('--partial-publish');
const cases = (CASES === 'fictional' ? allCases.filter(c => c.origin === 'fictional') : allCases).filter(c => !IDS.length || IDS.includes(c.id));
const variants = VARIANT === 'both' ? (['baseline', 'candidate'] as const) : ([VARIANT] as const);

const out = path.resolve(process.argv[2] || 'tests/eval/reports/review-optimization-20261009');
if (fs.existsSync(path.join(out, 'manifest.json'))) throw new Error('Use a new output directory; preserve previous evidence');
fs.mkdirSync(out, { recursive: true });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const files = ['server/src/agent/review.ts', 'server/src/agent/publication.ts', 'server/src/agent/service.ts', 'scripts/eval/review_optimization.ts'];
const baselinePath = path.resolve(process.argv.find(a => a.endsWith('review.ts')) || 'tests/eval/reports/server-harness-20261009/acceptance-verified/frozen-source/server/src/agent/review.ts');
// 基线快照的 reviewAnswer 第 7 参仍是可选的（必填是本次改动），按基线签名标注以保留 6 参调用
const legacyReview = (await import(pathToFileURL(baselinePath).href)).reviewAnswer as (
  model: Parameters<typeof reviewAnswer>[0], candidate: Parameters<typeof reviewAnswer>[1], history: Parameters<typeof reviewAnswer>[2],
  attempt: number, traceId: string, emit: Parameters<typeof reviewAnswer>[5], options?: { timeoutMs?: number }
) => ReturnType<typeof reviewAnswer>;
const sourceHashes = Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(file))]));
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ registeredAt: new Date().toISOString(), cases, rounds: 2, sourceHashes, baselinePath, baselineHash: hash(fs.readFileSync(baselinePath)), purpose: '虚构规则受控验证，不代表实际业务完整可用率；期望判断不进入模型输入。' }, null, 2));
for (const file of files) { const to = path.join(out, 'source', file); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(file, to); }
for (const [key, value] of Object.entries(loadServerEnv())) process.env[key] = value;
const { loadServerConfig } = await import('../../server/src/config.ts');
const config = loadServerConfig();
const tasks = cases.flatMap(c => [1, 2].flatMap(round => variants.map(variant => ({ ...c, round, variant }))));
let cursor = 0; const results: any[] = [];
/** 每次模型调用写台账（G3 纪律）：只记 token 与元信息，不记内容；超时中止未结算的调用也记账（用量标记未结算） */
function logLedger(audit: unknown[], requests: Array<{ at: number }>, job: typeof tasks[number], seconds: number): void {
  const write = (entry: any, unsettled: boolean) => {
    try {
      appendUsageLedger({
        ts: entry?.timestamp || new Date().toISOString(),
        task: TASK,
        model: typeof entry?.model === 'string' ? entry.model : 'gemini',
        purpose: entry?.details?.purpose === 'investigation' ? 'investigation' : 'answer_review',
        inputTokens: entry?.tokensUsed?.promptTokens || 0,
        outputTokens: entry?.tokensUsed?.completionTokens || 0,
        reasoningTokens: entry?.tokensUsed?.reasoningTokens || 0,
        cachedTokens: entry?.details?.cachedInputTokens || 0,
        durationMs: entry?.durationMs || (unsettled ? Date.now() - (requests[0]?.at || Date.now()) : seconds * 1000),
        ok: unsettled ? false : entry?.success !== false,
        ...(unsettled ? { error: '超时中止，用量未结算' } : entry?.error ? { error: String(entry.error).slice(0, 200) } : {}),
        detail: `${job.variant}-${job.id}-r${job.round}${unsettled ? '-unsettled' : ''}`,
      });
    } catch { /* 台账失败不影响实验 */ }
  };
  for (const entry of audit) write(entry, false);
  for (let i = audit.length; i < requests.length; i++) write(null, true); // 中止未结算的调用
}
async function run(job: typeof tasks[number]) {
  const audit: unknown[] = [], requests: Array<{ at: number }> = [];
  const model = new BusinessModel(config, 'gemini', { log: (entry: unknown) => audit.push(entry) } as any, 'review-optimization');
  const gateway: any = { streamChat: async (...args: Parameters<BusinessModel['streamChat']>) => {
    requests.push({ at: Date.now() }); return model.streamChat(...args);
  } };
  const history: Message[] = [{ role: 'user', content: job.question }, { role: 'tool', name: 'company_db_query', content: job.source,
    evidence: { id: 'e_fixture', observedAt: '2026-10-09T00:00:00Z', arguments: {}, outcome: 'success', completeness: 'complete' } }];
  const started = Date.now();
  // 用例答案可能是对象（虚构用例）或原始文本字符串（真实案例）：统一为候选消息文本，避免双重编码
  const answerText = typeof job.answer === 'string' ? job.answer : JSON.stringify(job.answer);
  const decision = await (job.variant === 'candidate'
    ? reviewAnswer(gateway, { role: 'assistant', content: answerText }, history, 1, 'r_fixture', () => {}, { timeoutMs: config.answerReviewTimeoutMs, partialPublish: PARTIAL_PUBLISH })
    : legacyReview(gateway, { role: 'assistant', content: answerText }, history, 1, 'r_fixture', () => {}));
  const status = (decision.record as any).status;
  const judgmentCompleted = status === 'passed' || status === 'needs_revision';
  const seconds = Math.round((Date.now() - started) / 1000);
  // R1 部分发布指标：错误断言（expected=false）不得出现 confirmed；正确断言（expected=true）应被确认
  let confirmedClaims = 0, pendingClaims = 0;
  try {
    const claims = JSON.parse(decision.text)?.claims;
    if (Array.isArray(claims)) for (const claim of claims) { if (claim.status === 'confirmed') confirmedClaims++; else pendingClaims++; }
  } catch { /* 非 JSON 文本 */ }
  const result = { id: job.id, round: job.round, variant: job.variant, expected: job.expected, accepted: decision.accepted, judgmentCompleted, matchesExpected: judgmentCompleted && decision.accepted === job.expected, confirmedClaims, pendingClaims, seconds, modelCalls: requests.length, status };
  logLedger(audit, requests, job, seconds);
  const key = `${job.variant}-${job.id}-${job.round}`;
  fs.writeFileSync(path.join(out, key + '.json'), JSON.stringify({ result, decision, history, requests, audit }, null, 2));
  results.push(result); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ finished: results.length, ...result }));
}
await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (cursor < tasks.length) await run(tasks[cursor++]); }));
const changed = files.filter(file => sourceHashes[file] !== hash(fs.readFileSync(file)));
fs.writeFileSync(path.join(out, 'integrity.json'), JSON.stringify({ sourceUnchanged: !changed.length, changed }, null, 2));

// 汇总：检出率（expected=false 被拦）、误拦率（expected=true 被拦）、耗时与 token（M2 的 baseline.json / M3 的对照输入）
const summarize = (variant: string) => {
  const rows = results.filter(r => r.variant === variant);
  const expFalse = rows.filter(r => !r.expected), expTrue = rows.filter(r => r.expected);
  const secs = rows.map(r => r.seconds).sort((a: number, b: number) => a - b);
  const ledgerRows = fs.existsSync(path.resolve('tests/eval/reports/exec-v3/usage-ledger.jsonl'))
    ? fs.readFileSync(path.resolve('tests/eval/reports/exec-v3/usage-ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && r.task === TASK && (r.detail || '').startsWith(variant + '-'))
    : [];
  const sum = (field: string) => ledgerRows.reduce((n, r) => n + (r[field] || 0), 0);
  return {
    variant, runs: rows.length, cases: new Set(rows.map(r => r.id)).size,
    matchesExpected: rows.filter(r => r.matchesExpected).length,
    detection: { blocked: expFalse.filter(r => !r.accepted).length, total: expFalse.length },
    falseBlock: { blocked: expTrue.filter(r => !r.accepted).length, total: expTrue.length },
    timeP50: secs.length ? secs[Math.floor(secs.length / 2)] : 0,
    timeP90: secs.length ? secs[Math.floor(secs.length * 0.9)] : 0,
    tokens: { input: sum('inputTokens'), output: sum('outputTokens'), reasoning: sum('reasoningTokens'), cached: sum('cachedTokens'), calls: ledgerRows.length },
  };
};
const summary = { task: TASK, cases: CASES, variants, concurrency: CONCURRENCY, reviewReasoningEffort: config.reviewReasoningEffort ?? config.geminiReasoningEffort, byVariant: variants.map(summarize) };
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
if (TASK === 'M2') fs.writeFileSync(path.join(out, 'baseline.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.byVariant.map((s: any) => ({ variant: s.variant, runs: s.runs, matchesExpected: `${s.matchesExpected}/${s.runs}`, detection: `${s.detection.blocked}/${s.detection.total}`, falseBlock: `${s.falseBlock.blocked}/${s.falseBlock.total}`, p50: s.timeP50, tokens: s.tokens }))));
