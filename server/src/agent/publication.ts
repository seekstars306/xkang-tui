import { z } from 'zod';
import type { Message } from '@xkang/agent-core';
import { isReminderMessage, messageText } from '@xkang/agent-core/context';
import type { ClaimReason, PublicAnswer } from '@xkang/agent-core/public';

const publicString = z.string().max(12000);
export const draftSchema = z.object({
  conclusion: publicString.min(1),
  businessData: z.array(z.object({ label: z.string().min(1).max(100), value: publicString }).strict()).max(200),
  evidenceSummary: z.array(publicString).max(50),
  customerReply: publicString,
  pendingItems: z.array(publicString).max(50),
}).strict();
export type PublicDraft = z.infer<typeof draftSchema>;

// This policy targets implementation details. It deliberately contains no phone/ID masking rules.
const PRIVATE_PATTERNS: Array<[string, RegExp]> = [
  ['code', /```|\b(?:class|interface)\s+[A-Z]\w*|\b(?:public|private|protected)\s+(?:static\s+)?\w+\s+\w+\s*\(/i],
  ['sql', /\bselect\s+[\s\S]{0,600}?\bfrom\s+|\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+table|alter\s+table|show\s+tables)\b/i],
  ['path', /(?:(?<![A-Za-z])[a-z]:[\\/]|\\\\[a-z0-9_.-]+\\|(?:\/(?:home|root|srv|opt|var|etc|Users|skt[-_\w]*)\/))|\b[\w.-]+\.(?:java|vue|tsx?|jsx?|sql|xml|yml|yaml|properties)(?::\d+)?\b/i],
  ['internal_address', /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3})\b|\b(?:jdbc|mysql|postgres(?:ql)?):\/\/|\/(?:api|admin|permission|internal)\/[\w/.-]+/i],
  ['credentials', /\bBearer\s+\S+|\b(?:api[_-]?key|password|access[_-]?token|secret)\s*[:=]\s*\S+|\b(?:sk-|tok_skt_)[a-z0-9_-]{8,}/i],
  ['implementation', /\b[A-Z]\w*(?:ServiceImpl|Controller|Mapper|Repository|Exception)\b|\b[a-z]+(?:_[a-z0-9]+){2,}\b|\b[a-z]+[A-Z]\w*\s*\(|\bat\s+[\w.$]+\([^)]*:\d+\)/],
];

/** 只把“像内部标识符”的词收进私有词表：≥6 位、含下划线或含小写→大写过渡；app/vip/pdf 这类短局部名不再误杀 */
function isPrivateTermCandidate(text: string): boolean {
  return text.length >= 6 || text.includes('_') || /[a-z][A-Z]/.test(text);
}

/** 用户自己写过的纯字母数字 token（客户单号、外部编码）：不得再被当作内部标识符拦截 */
function collectUserExemptTerms(messages: Message[]): Set<string> {
  const exempt = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'user' || isReminderMessage(m)) continue;
    for (const token of messageText(m).split(/[^A-Za-z0-9]+/)) {
      // 保留防注入规则：含小写→大写过渡的驼峰标识（如 orderNew）不享受豁免
      if (/^[A-Za-z0-9]{2,32}$/.test(token) && !/[a-z][A-Z]/.test(token)) exempt.add(token.toLowerCase());
    }
  }
  return exempt;
}

export function collectPrivateTerms(messages: Message[]): Set<string> {
  const terms = new Set<string>();
  const userExemptTerms = collectUserExemptTerms(messages);
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    // 豁免判断用小写比较；豁免 token 是纯字母数字，不会影响下面的文件名后缀分支
    if (userExemptTerms.has(text.toLowerCase())) return;
    if (isPrivateTermCandidate(text)) terms.add(text);
    const base = text.split(/[\\/]/).pop();
    if (base && /\.(?:java|vue|ts|js|sql|xml)$/.test(base)) terms.add(base);
  };
  for (const m of messages) {
    for (const call of m.tool_calls || []) {
      let args: any = call.arguments;
      try { if (typeof args === 'string') args = JSON.parse(args); } catch { continue; }
      for (const key of ['database', 'tableName', 'filePath', 'file_path', 'symbol', 'repo', 'app']) add(args?.[key]);
      for (const match of String(args?.sql || '').matchAll(/\b(?:from|join|update|into)\s+`?([\w.]+)/gi)) add(match[1]);
    }
    if (m.role !== 'tool') continue;
    const args = m.evidence?.arguments || {};
    for (const key of ['database', 'tableName', 'filePath', 'file_path', 'symbol', 'repo', 'app']) add(args[key]);
    for (const match of String(args.sql || '').matchAll(/\b(?:from|join|update|into)\s+`?([\w.]+)/gi)) add(match[1]);
    const raw = m.raw_tool_result ?? (typeof m.content === 'string' ? m.content : '');
    try {
      const parsed = JSON.parse(raw);
      add(parsed.database);
      for (const column of [...(parsed.columns || []), ...(parsed.allNullColumns || [])]) add(column);
      for (const match of String(parsed.executedSql || '').matchAll(/\b(?:from|join|update|into)\s+`?([\w.]+)/gi)) add(match[1]);
    } catch { /* textual source records */ }
    for (const match of raw.matchAll(/\b(?:class|interface|function)\s+([A-Za-z_$][\w$]*)|\b([a-z][\w]*[A-Z][\w]*)\s*\(/g)) add(match[1] || match[2]);
    if (['search_code', 'read_file_lines', 'codegraph_explore'].includes(m.name || '')) {
      // Source conditions and declarations may expose simple field names without SQL keywords.
      for (const match of raw.matchAll(/\b([A-Za-z_][\w]*)\s*(?:==|!=|>=|<=|=(?!=))|\b(?:private|protected|public)\s+(?:static\s+|final\s+)*[\w<>?,.\[\]]+\s+([A-Za-z_][\w]*)\s*;/g)) add(match[1] || match[2]);
    }
  }
  return terms;
}

export function checkPublicText(text: string, terms: ReadonlySet<string>): string[] {
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '');
  const issues = PRIVATE_PATTERNS.filter(([, pattern]) => pattern.test(normalized)).map(([kind]) => kind);
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i').test(normalized)) { issues.push('internal_identifier'); break; }
  }
  return issues;
}

/**
 * PNR、PDF、ETA、VAT 这类全大写拉丁缩写是中文工单里的通用词，不应当被「业务字段必须使用中文名称」拦下。
 * 只放行 2~6 位、全大写、不含空格与标点的缩写；`Order No`、`total amount` 之类仍按原规则拒绝，
 * 因为那更像是直接把英文字段名搬进公开答案。
 */
export function isLatinAbbreviationLabel(label: string): boolean {
  return /^[A-Z]{2,6}$/.test(String(label ?? '').trim());
}
export function parsePublicDraft(text: string, terms: ReadonlySet<string>): PublicDraft {
  const draft = draftSchema.parse(JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));
  for (const block of publicBlocks(draft)) if (checkPublicText(block.text, terms).length) throw new Error('候选回答包含内部技术信息');
  // 业务字段名要求是中文，但 PNR、PDF、ETA 这类本身就是中文工单里的通用缩写，不应当被视为非法标签。
  // 现网 2026-10-20 客票 9999204322942：businessData 里有一个 label 是 "PNR"，校验直接抛错，
  // 复核根本没进入内容审核，两轮都停在格式关，最终把一份已查清「改签应收 0 元、详情与导出取自不同数据源」
  // 的答案降级成「本次尚未形成可直接采信的业务结论」。
  if (draft.businessData.some(item => !/[\u3400-\u9fff]/.test(item.label) && !isLatinAbbreviationLabel(item.label))) {
    throw new Error('业务字段必须使用中文名称');
  }
  return draft;
}
export function publicBlocks(draft: PublicDraft): Array<{ id: string; text: string }> {
  return [
    { id: 'conclusion', text: draft.conclusion },
    ...draft.businessData.map((item, i) => ({ id: `data:${i}`, text: `${item.label}：${item.value}` })),
    ...draft.evidenceSummary.map((text, i) => ({ id: `evidence:${i}`, text })),
    ...(draft.customerReply ? [{ id: 'customerReply', text: draft.customerReply }] : []),
    ...draft.pendingItems.map((text, i) => ({ id: `pending:${i}`, text })),
  ];
}
export function unavailableAnswer(traceId: string): PublicAnswer {
  return { conclusion: '本次尚未形成可直接采信的业务结论，需要继续核实。', businessData: [], evidenceSummary: [], customerReply: '您的问题仍在核实，请由二线人员继续跟进。', pendingItems: ['当前结论未完成复核。'], reviewStatus: 'needs_human', traceId };
}

/** R1 部分发布：客服话术不复用被复核驳回的初稿原句，统一用这条模板，口径留给人工确认 */
export const PARTIAL_REPLY_TEMPLATE = '您的问题已核实一部分，其余事项仍在核实中，稍后由二线人员补充答复。';

/** R5 部分发布：话术里只有一部分句子通过核实时，保留已核实的句子并追加这条收尾，不得让客户以为话术已说全 */
export const PARTIAL_REPLY_SUFFIX = '其余事项仍在核实中，稍后由二线人员补充答复。';

/** R1 部分发布：待确认断言的原因文案。引文未通过自动核对属于核对程序未通过，不等于业务事实存疑 */
export const CLAIM_REASON_TEXT: Record<ClaimReason, string> = {
  challenged: '复核反证阶段提出异议',
  unsupported: '证据不足',
  citation_unverified: '引文未通过自动核对，需人工确认',
};

/** 拼出 pendingItems 里的原因后缀；没有原因时不留任何标注 */
export function claimReasonSuffix(reason: ClaimReason | undefined): string {
  return reason ? `（${CLAIM_REASON_TEXT[reason]}）` : '';
}

/** V4 数据核对模式：涉及仓库档位为 unknown 时，拦截确定性的机制/原因/规则结论，只放行数据事实 */
export const DATA_ONLY_CONCLUSION = '该服务的现行实现未能确认，以下为数据核对结果。';
const MECHANISM_PATTERN = /(?:因为|原因|机制|规则|必然|一定会|总是|绝不会|禁止|设计上|实现上|调用链|分支|根因|导致|一律|所有场景|只要.*就|不可能|拦截|校验失败|风控)/;

/** 是否是"数据事实"（不含机制/原因/规则类表述） */
export function isDataFactText(text: string): boolean {
  return !MECHANISM_PATTERN.test(text);
}

/** 数据核对模式过滤：结论段统一替换，业务字段与依据只保留数据事实（unknownInvolved 为 false 时原样返回） */
export function applyDataOnlyMode(draft: PublicDraft, unknownInvolved: boolean): PublicDraft {
  if (!unknownInvolved) return draft;
  return {
    ...draft,
    conclusion: DATA_ONLY_CONCLUSION,
    businessData: draft.businessData.filter(item => isDataFactText(item.value)),
    evidenceSummary: draft.evidenceSummary.filter(isDataFactText),
    customerReply: isDataFactText(draft.customerReply) ? draft.customerReply : '',
    pendingItems: draft.pendingItems,
  };
}
export function publicUserText(input: unknown, terms: ReadonlySet<string>): string {
  const text = typeof input === 'string' ? input : Array.isArray(input) ? input.filter(p => p?.type === 'text').map(p => p.text).join('\n') : '';
  return checkPublicText(text, terms).length ? '已提交业务问题及附件。' : text || '已提交图片或附件。';
}
