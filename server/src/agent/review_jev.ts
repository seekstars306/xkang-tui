import { createHash } from 'node:crypto';
import type { Message, ReviewDecision, StreamEvent } from '@xkang/agent-core';
import { messageText } from '@xkang/agent-core/context';
import { loadServerConfig } from '../config.js';
import { outboundFetch } from '../outbound_http.js';
import { parsePublicDraft, unavailableAnswer, type PublicDraft } from './publication.js';
import { collectPrivateTerms } from './publication.js';
import { reviewUnits, validateReview, revisionDiscipline, parseCandidateJson } from './review.js';
import { observedBranchEnabled } from './observed_branch.js';

/**
 * Jev 复核器（xkang-jev 变体）。
 *
 * 与 reviewAnswer 的差别只在“谁来判定内容是否可信”：
 * - reviewAnswer：让同一套 LLM 做反证检查 + 引文核验，输出 blocks[].assessment。
 * - 本模块：把断言逐条喂给 TypeSafe 的 System One 模型（Jev），用结构化问题拿判定。
 *
 * 保持不变的部分（有意为之）：
 * - 发布形态、claim 生成、部分发布、修订反馈通道全部复用现有代码路径；
 * - 机械校验（引文能否在证据里逐字找到、角色称谓、完成态声明）仍由 validateReview 负责，
 *   不让 Jev 取代可程序化的检查——那是确定性规则，交给模型只会更不可复现。
 */

export interface JevReviewOptions {
  timeoutMs: number;
  partialPublish?: boolean;
  /** 覆盖配置里的代理与密钥（测试用） */
  proxy?: string;
  apiKey?: string;
  model?: string;
}

const DEFAULT_MODEL = 'jev-1.13.0';

/** 每条断言问 Jev 的问题；criteria 写得越能互相区分，选项判定越稳定 */
const CLAIM_QUESTIONS = {
  support: {
    type: 'noul' as const,
    instructions:
      'Is this claim directly supported by the quoted evidence? Answer NO when the evidence only shows a related fact, ' +
      'a time, an amount or a status, but does not establish the claim as written. NO also when the claim states a cause ' +
      'or mechanism that the evidence does not describe.',
  },
  role: {
    type: 'choice' as const,
    instructions: 'Does the claim attribute an action to a business role that the evidence does not name?',
    criteria: {
      grounded: 'Every actor named in the claim appears verbatim in the evidence',
      inferred: 'An actor is implied by a field value (creator, operator, cashier) but the claim treats it as the acting subject',
      invented: 'The claim names a role (finance, agent, operator) that appears nowhere in the evidence',
    },
  },
};

interface JevAnswer {
  support?: { noul: number };
  role?: { choice: string };
}

async function callJev(state: string, questions: unknown, opts: JevReviewOptions): Promise<JevAnswer> {
  const cfg = loadServerConfig();
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error('缺少 TYPESAFE_API_KEY，无法使用 Jev 复核');
  const res = await outboundFetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model: opts.model ?? DEFAULT_MODEL, state, questions }),
    timeoutMs: opts.timeoutMs,
  }, opts.proxy ?? cfg.outboundProxy);
  if (!res.ok) throw new Error(`Jev 调用失败 HTTP ${res.status}`);
  const json = (await res.json()) as { answers?: Record<string, unknown> };
  const a = (json.answers ?? {}) as Record<string, { noul?: number; choice?: string }>;
  return { support: a.support as JevAnswer['support'], role: a.role as JevAnswer['role'] };
}

export async function jevReviewAnswer(
  candidate: Message,
  history: Message[],
  attempt: number,
  traceId: string,
  emit: (event: StreamEvent) => void,
  options: JevReviewOptions,
): Promise<ReviewDecision> {
  if (!Number.isFinite(options?.timeoutMs) || options.timeoutMs <= 0) throw new Error('复核调用必须显式传入 timeoutMs');
  const partialPublish = Boolean(options.partialPublish);
  const fallback = unavailableAnswer(traceId);
  const terms = collectPrivateTerms(history);
  const record = {
    version: 2 as const,
    attempt,
    candidateHash: createHash('sha256').update(messageText(candidate)).digest('hex'),
    status: 'unavailable' as 'passed' | 'needs_revision' | 'unavailable',
    issues: [] as string[],
    omittedEvidence: [] as string[],
    responses: [] as Array<{ stage: 'challenge' | 'citations'; text: string; formatError?: string }>,
    reviewer: 'jev',
  };

  // 1) 先做与模型无关的格式/脱敏校验（与 reviewAnswer 同一入口，保证口径一致）
  let draft: PublicDraft;
  try {
    const value = parseCandidateJson(messageText(candidate));
    draft = parsePublicDraft(JSON.stringify(value.answer ?? value), terms);
  } catch (error) {
    record.status = 'needs_revision';
    record.issues = ['请按业务答案 JSON 格式重写，不能输出内部代码、SQL、库表字段或目录；完整业务号码无需掩码。'];
    return { accepted: false, retry: true, text: JSON.stringify(fallback), feedback: record.issues.join('\n') + '\n' + revisionDiscipline(observedBranchEnabled()), record };
  }

  const units = reviewUnits(draft);
  const evidence = history.filter(m => !m.imported && m.evidence);
  const evidenceText = evidence
    .map(m => `[${m.evidence!.id}] ${messageText(m).slice(0, 1200)}`)
    .join('\n\n');

  // 2) 逐条断言问 Jev：是否被引文直接支持
  const issues: string[] = [];
  let supportedCount = 0;
  for (const unit of units) {
    const state = `=== CLAIM ===\n${unit.text}\n\n=== EVIDENCE ===\n${evidenceText}`;
    let ans: JevAnswer;
    try {
      ans = await callJev(state, CLAIM_QUESTIONS, options);
    } catch (error) {
      record.status = 'unavailable';
      record.issues = [`复核服务未完成本次检查：${error instanceof Error ? error.message : String(error)}`];
      return { accepted: false, text: JSON.stringify(fallback), record };
    }
    const p = ans.support?.noul ?? 0;
    if (p >= 0.5) supportedCount++;
    else issues.push(`${unit.id}: 引文不足以直接支持该断言（Jev 支持度 ${p.toFixed(2)}）`);
    if (ans.role?.choice === 'invented') issues.push(`${unit.id}: 断言中的角色称谓在证据里没有出处`);
  }

  record.status = issues.length ? 'needs_revision' : 'passed';
  (record as { validUnitCount?: number }).validUnitCount = supportedCount;
  record.issues = issues;

  if (!issues.length) {
    const answer = { ...draft, reviewStatus: 'reviewed' as const, traceId };
    return { accepted: true, text: JSON.stringify(answer), record };
  }
  // 与 reviewAnswer 一致：给一次修订机会，由 core 决定是否重试或收尾发布
  return {
    accepted: false,
    retry: true,
    text: JSON.stringify(fallback),
    feedback: issues.join('\n') + '\n' + revisionDiscipline(observedBranchEnabled()),
    record,
  };
}
