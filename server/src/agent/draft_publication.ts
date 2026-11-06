import type { ReviewDecision } from '@xkang/agent-core';
import type { PublicAnswer } from '@xkang/agent-core/public';
import { checkPublicText, parsePublicDraft, type PublicDraft } from './publication.js';
import { extractJsonObject, reviewUnits } from './review.js';

/**
 * 不经复核裁剪、直接发布模型草稿（REVIEW_MODE=off 与 advisory，见 review_mode.ts）。
 * gate 不走这里：gate 发布的仍是复核给出的文本。
 */

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * 把模型草稿还原成公开答案的五个字段。不挂复核时 core 原样返回草稿，形态不固定，这里认三种：
 *  ① {"answer":{...},"evidenceIds":[...]} 包装（BUSINESS_PROMPT 要求的形态）；② 五个字段平铺的对象；
 *  ③ 包在 ```json 代码块里（代码块前后可以有说明文字）。
 * 只取五个答案字段（evidenceIds 等内部字段丢弃，业务数据只取 label/value）；缺省的列表与话术按空值补齐，结论缺失仍算解析失败。
 * 不改写任何取值（号码不做数字转换：超长订单号一旦按数字处理就会被改写），类型不对的交给 draftSchema 拒绝。
 * 找不到 JSON 对象时抛错，由调用方走现有兜底。
 */
export function draftFields(text: string): Record<string, unknown> {
  const raw = String(text ?? '').trim();
  let value: unknown;
  try { value = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch (error) {
    const json = extractJsonObject(raw);
    if (json === null) throw error;
    value = JSON.parse(json);
  }
  const source = isRecord(value) && isRecord(value.answer) ? value.answer : value;
  if (!isRecord(source)) throw new Error('草稿不是业务答案对象');
  return {
    conclusion: source.conclusion,
    businessData: Array.isArray(source.businessData) ? source.businessData.map(item => (isRecord(item) ? { label: item.label, value: item.value } : item)) : source.businessData ?? [],
    evidenceSummary: source.evidenceSummary ?? [],
    customerReply: source.customerReply ?? '',
    pendingItems: source.pendingItems ?? [],
  };
}

/** 草稿 → 过了发布校验（结构、源码/SQL/路径/内部标识、业务字段中文名）的五个字段；任何一步不过都抛错 */
export function parseDraft(text: string, terms: ReadonlySet<string>): PublicDraft {
  return parsePublicDraft(JSON.stringify(draftFields(text)), terms);
}

/**
 * 发布格式退回意见（REVIEW_MODE=off 的格式检查用）。2026-10-30：开 max 推理后模型常把终稿写成 Markdown，
 * 退回时只说"请输出 JSON"，第二稿改成了 JSON 却用中文键名（"结论""排查依据"），仍解析失败、整份兜底作废；
 * 内核只允许一次修正，所以退回意见必须一次讲清结构和键名。
 */
export const DRAFT_SKELETON = '{"answer":{"conclusion":"……","businessData":[{"label":"……","value":"……"}],"evidenceSummary":["……"],"customerReply":"……","pendingItems":["……"]},"evidenceIds":["……"]}';
export function formatRetryFeedback(reason: string): string {
  return `答案没有通过发布格式检查：${reason}。请按原来的内容重新输出，只改格式，不要改动结论，也不要再调用工具。第一个字符必须是左花括号；不要 Markdown 标题、代码围栏或中文键名；结构和键名必须与下面完全一致：${DRAFT_SKELETON}。原来写在其他键名下的内容，分别放进 conclusion（结论）、businessData（业务数据，每项一个 label 和 value）、evidenceSummary（依据）、customerReply（客服可转述的话术）、pendingItems（待确认事项）；公开字段里不要写代码、SQL、库表字段名和内部编号。`;
}

/** advisory 追加到待确认事项的复核问题上限 */
export const ADVISORY_ISSUE_LIMIT = 5;
/** 复核问题的写法是"语句编号: 理由"（reviewAnswer 与 review_jev 相同） */
const ISSUE_LINE = /^\s*((?:conclusion|customerReply|data:\d+|evidence:\d+|pending:\d+)(?:#\d+)?)\s*[:：]\s*([\s\S]*)$/;
const UNIT_ID = /\b(?:conclusion|customerReply|data:\d+|evidence:\d+|pending:\d+)(?:#\d+)?/g;
const EVIDENCE_ID = /\be_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
/** 复核理由里像内部标识符的写法（下划线名、驼峰、带点的调用）：理由由复核模型看着代码和库表写成，命中就整条不追加 */
const INTERNAL_TOKEN = /[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*[A-Za-z0-9]|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*/;
/** 程序核对给出的机械口径换成一线看得懂的说法（与 publication.ts 的 CLAIM_REASON_TEXT 同口径） */
const PLAIN_REASON: Record<string, string> = { 引用无效: '引文未通过自动核对', 缺少引文: '证据不足', 事实没有证据: '证据不足', 没有动作执行记录: '没有对应的执行记录' };

/**
 * 最后一轮复核仍未解决的问题 → 追加到待确认事项的条目：每条一句、最多 5 条、不带内部编号
 * （语句编号换成"结论第2句""业务信息「退款金额」"这类位置说明，证据编号删去）。
 * 只取能落到具体语句的问题（同一句只取第一条理由，反证阶段的理由排在前面）与复核列出的缺失证据；
 * "复核没有完整覆盖正文""复核服务未完成本次检查"这类流程性问题不追加。复核没跑完（unavailable）或只回了正文（unstructured）时不追加。
 * 每条都过发布校验，命中内部信息的整条丢弃——不能因为一条复核理由让整份答案发布失败。
 */
export function reviewIssueItems(draft: PublicDraft, decision: ReviewDecision | undefined, terms: ReadonlySet<string>): string[] {
  const record = decision?.record as { status?: string; unstructured?: boolean; issues?: unknown; report?: { missingEvidence?: unknown } } | undefined;
  if (!record || record.status === 'unavailable' || record.unstructured || !Array.isArray(record.issues)) return [];
  const units = reviewUnits(draft);
  const unitIds = new Set(units.map(unit => unit.id));
  const sentenceCount = new Map<string, number>();
  for (const unit of units) sentenceCount.set(unit.paragraphId, (sentenceCount.get(unit.paragraphId) ?? 0) + 1);
  const locate = (id: string) => {
    const [paragraph, sentence] = id.split('#');
    const [kind, index] = paragraph.split(':');
    const i = Number(index);
    const name = kind === 'conclusion' ? '结论'
      : kind === 'customerReply' ? '客服话术'
        : kind === 'data' ? (draft.businessData[i]?.label ? `业务信息「${draft.businessData[i].label}」` : `业务信息第${i + 1}项`)
          : kind === 'evidence' ? `依据第${i + 1}条` : `待确认第${i + 1}条`;
    return sentence !== undefined && (sentenceCount.get(paragraph) ?? 0) > 1 ? `${name}第${Number(sentence) + 1}句` : name;
  };
  const concise = (reason: string) => {
    const first = reason.replace(UNIT_ID, locate).replace(EVIDENCE_ID, '').split(/[。！？；;\n]/)
      .map(part => part.replace(/[（(\[【]\s*[)）\]】]/g, '').replace(/\s+/g, ' ').trim().replace(/[，,、：:\s]+$/, ''))
      .find(Boolean) ?? '';
    const plain = PLAIN_REASON[first] ?? first;
    return plain.length > 60 ? `${plain.slice(0, 60)}…` : plain;
  };
  const missing = new Set(Array.isArray(record.report?.missingEvidence) ? (record.report!.missingEvidence as unknown[]).map(String) : []);
  const seen = new Set<string>();
  const items: string[] = [];
  for (const issue of record.issues.map(String)) {
    const match = ISSUE_LINE.exec(issue);
    let where = '', reason: string;
    if (match && (unitIds.has(match[1]) || sentenceCount.has(match[1]))) {
      if (seen.has(match[1])) continue;
      seen.add(match[1]);
      where = `（${locate(match[1])}）`;
      reason = match[2];
    } else if (missing.has(issue)) reason = issue;
    else continue;
    const text = concise(reason);
    if (!text || INTERNAL_TOKEN.test(text)) continue;
    const item = `复核提示${where}：${text}${text.endsWith('…') ? '' : '。'}`;
    if (items.includes(item) || draft.pendingItems.includes(item) || checkPublicText(item, terms).length) continue;
    items.push(item);
    if (items.length >= ADVISORY_ISSUE_LIMIT) break;
  }
  return items;
}

/**
 * advisory 的发布：最后一稿草稿的完整内容（结论、业务数据、依据、客服话术、待确认都按草稿原样，不裁剪、不挪句、不改写结论），
 * 待确认事项末尾追加最后一轮复核仍未解决的问题，reviewStatus=needs_human。
 * 返回 undefined 时由 core 退回 gate 的择优发布：
 *  - 草稿不是业务答案 JSON，或没过发布校验；
 *  - 最后一轮复核判定公开答案含开发内部信息（privacySafe=false）：隐私否决不因 advisory 放宽。
 */
export function advisoryAnswer(draftText: string, decision: ReviewDecision | undefined, terms: ReadonlySet<string>, traceId: string): PublicAnswer | undefined {
  const report = (decision?.record as { report?: { privacySafe?: unknown } } | undefined)?.report;
  if (report?.privacySafe === false) return undefined;
  let draft: PublicDraft;
  try { draft = parseDraft(draftText, terms); } catch { return undefined; }
  // 上限 50 与 draftSchema 一致：超限会让服务端最终解析整篇失败
  const pendingItems = [...draft.pendingItems, ...reviewIssueItems(draft, decision, terms)].slice(0, 50);
  return { ...draft, pendingItems, reviewStatus: 'needs_human', traceId };
}
