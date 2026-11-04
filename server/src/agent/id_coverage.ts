/**
 * 问题号码交代检查 ANSWER_ID_CHECK（on / off，缺省 off）。
 *
 * 2026-10-30 线上统计：客服问题里带长号码且已作答的 7 单中，有 2 单答案没有交代客服给出的号码
 * （2898ed55 漏手机号 18765322976；c4a2f188 漏 15066808805——客人用的是另一条同名档案，正是关键）。
 * 这是机械检查：只看客服给出的每个号码在答案里有没有出现，不评判内容对错；不针对任何一单。
 *
 * 只在 REVIEW_MODE=off 的发布格式检查里用，且只在后面还有修正机会时退回；
 * 最后一稿即使仍有号码没交代也照常发布，绝不因此兜底。
 */
import type { PublicDraft } from './publication.js';

/** 客服问题里的独立长号码（10–20 位数字：手机号、订单号、票号等）；夹在字母数字中间的（消息编号、哈希）不算 */
export function questionIds(text: string): string[] {
  const cleaned = String(text ?? '').replace(/问题编号\s*[0-9a-f]{6,}/gi, ' ');
  return [...new Set(cleaned.match(/(?<![0-9A-Za-z_])\d{10,20}(?![0-9A-Za-z_])/g) || [])];
}

export function draftText(d: PublicDraft): string {
  return [d.conclusion, ...(d.businessData || []).map(x => x.label + ' ' + x.value), ...(d.evidenceSummary || []), d.customerReply, ...(d.pendingItems || [])].join('\n');
}

export function missingIds(ids: string[], answerText: string): string[] {
  return ids.filter(id => !answerText.includes(id));
}

export function idCoverageFeedback(missing: string[]): string {
  return `客服在问题里给出了 ${missing.join('、')}，答案里没有交代${missing.length > 1 ? '它们各自' : '它'}对应什么。请查清每个号码对应的记录（是谁、哪一单、哪个账号）以及与问题的关系，写进结论或业务数据；同号对应多条记录时逐一区分；与问题无关的也要说明为什么无关。已经写对的内容保持不变。`;
}

export type IdCheck = 'on' | 'off';
export function idCheck(env: NodeJS.ProcessEnv = process.env): IdCheck {
  return (env.ANSWER_ID_CHECK || '').trim().toLowerCase() === 'on' ? 'on' : 'off';
}
export function validateIdCheck(env: NodeJS.ProcessEnv = process.env): IdCheck {
  const v = (env.ANSWER_ID_CHECK || '').trim().toLowerCase();
  if (v && v !== 'on' && v !== 'off') throw new Error('ANSWER_ID_CHECK 只能是 on 或 off，当前值：' + env.ANSWER_ID_CHECK);
  return v === 'on' ? 'on' : 'off';
}
