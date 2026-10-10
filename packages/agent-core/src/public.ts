/** The only company-agent DTOs that may cross into an employee client. No internal Message imports. */
export type ReviewStatus = 'reviewed' | 'needs_human' | 'unreviewed';
export interface PublicAnswer {
  conclusion: string;
  businessData: Array<{ label: string; value: string }>;
  evidenceSummary: string[];
  customerReply: string;
  pendingItems: string[];
  reviewStatus: ReviewStatus;
  traceId: string;
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
