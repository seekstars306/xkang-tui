/** The only company-agent DTOs that may cross into an employee client. No internal Message imports. */
export type ReviewStatus = 'reviewed' | 'needs_human' | 'unreviewed';
/** R1 部分发布：断言未通过核实的原因，供一线区分"证据不足"与"引文未通过自动核对"（后者是核对程序没通过，不代表事实有误） */
export type ClaimReason = 'challenged' | 'unsupported' | 'citation_unverified';
/** R1 部分发布：按断言粒度的发布状态。反证点名或引文未通过的断言一律 pending，绝不为覆盖率放行 */
export interface PublicClaim {
  text: string;
  status: 'confirmed' | 'pending';
  conditions?: string[];
  exceptions?: string[];
  evidenceRefs?: string[];
  /** 仅 pending 断言携带；服务端与客户端都必须容忍它缺失或出现未知值 */
  reason?: ClaimReason;
}
export interface PublicAnswer {
  conclusion: string;
  businessData: Array<{ label: string; value: string }>;
  evidenceSummary: string[];
  customerReply: string;
  pendingItems: string[];
  reviewStatus: ReviewStatus;
  traceId: string;
  /** R1 部分发布（features.partialPublish 开启时由服务端拼装；旧字段一律保留，客户端兼容） */
  claims?: PublicClaim[];
}
export interface PublicQuestion {
  id: string;
  questions: Array<{ question: string; options?: Array<{ label: string; description?: string }> }>;
}
export interface PublicTurn { id: string; userText: string; answer?: PublicAnswer }
export interface PublicSession {
  id: string; title: string; createdAt: string; lastActiveAt: string;
  status: 'idle' | 'running' | 'waiting_question';
  turns: PublicTurn[];
  pendingQuestion?: PublicQuestion;
  /** R2 冻结续查：status 仍只有三个枚举值，冻结态用可选字段表达（客户端能力协商见 /config/client） */
  frozen?: boolean;
  extensions?: number;
  activeElapsedMs?: number;
  activeBudgetMs?: number;
}
export type PublicEvent =
  | { type: 'progress'; phase: 'checking' | 'reviewing' | 'revising' }
  | { type: 'question'; question: PublicQuestion }
  | { type: 'answer'; turnId: string; answer: PublicAnswer }
  | { type: 'error'; message: string; traceId: string }
  | { type: 'done' };

export const REVIEW_LABELS: Record<ReviewStatus, string> = { reviewed: '已复核', needs_human: '需人工核实', unreviewed: '未复核' };
export function answerText(answer: PublicAnswer): string {
  return [
    `【结论】\n${answer.conclusion}`,
    ...(answer.businessData.length ? [`【业务信息】\n${answer.businessData.map(item => `${item.label}：${item.value}`).join('\n')}`] : []),
    ...(answer.evidenceSummary.length ? [`【依据】\n${answer.evidenceSummary.join('\n')}`] : []),
    ...(answer.customerReply ? [`【客服话术】\n${answer.customerReply}`] : []),
    ...(answer.pendingItems.length ? [`【还需确认】\n${answer.pendingItems.join('\n')}`] : []),
  ].join('\n\n');
}
