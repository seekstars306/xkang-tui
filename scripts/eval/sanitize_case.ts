// M2-2：等长形态保留脱敏。把手机号、证件号、订单号等长数字与中文姓名替换为等长演示占位符，
// 保留数字/字母形态与标点（形态本身会影响复核判断，所以不能简单删除）。
// 同时提供从 acceptance-verified 运行目录构建脱敏后真实案例的助手。
import fs from 'node:fs';
import path from 'node:path';

/** 等长占位：数字统一替为 0，字母原样保留（证件号末位 X 等形态不变） */
const zeroSameLength = (length: number, keepLettersFrom: string) => keepLettersFrom.replace(/\d/g, '0');
/** 非全零守卫：占位符（全零）不会再次匹配，保证替换只发生一次 */
const NOT_ALL_ZERO = '(?!0+(?:[\\dXx])?\\b)';

/** 中文姓名（2-4 字）在明确姓名语境下的替换；语境词本身保留（必须有分隔符，避免"客户手机"误伤） */
const NAME_CONTEXT = /((?:姓名|联系人|乘机人|订票人|客户|乘客|员工|申请人|收款人|退款人)(?:[：:]\s*|\s+))([\u4e00-\u9fa5]{2,4})/g;

export interface SanitizeResult {
  text: string;
  replaced: Array<{ kind: string; original: string; placeholder: string }>;
}

/** 对一段文本做等长形态保留脱敏（幂等：对已脱敏文本再跑一次不产生变化） */
export function sanitizeText(text: string): SanitizeResult {
  const replaced: SanitizeResult['replaced'] = [];
  const note = (kind: string, original: string, placeholder: string) => { replaced.push({ kind, original, placeholder }); return placeholder; };
  let out = text
    // 001 前缀的 13 位电话（业务数据里的完整形态）
    .replace(new RegExp(`\\b${NOT_ALL_ZERO}00\\d{11}\\b`, 'g'), m => note('phone13', m, zeroSameLength(m.length, m)))
    // 11 位手机号
    .replace(new RegExp(`\\b${NOT_ALL_ZERO}1[3-9]\\d{9}\\b`, 'g'), m => note('phone11', m, zeroSameLength(m.length, m)))
    // 18 位证件号（末位可为 X/x）
    .replace(new RegExp(`\\b${NOT_ALL_ZERO}\\d{17}[\\dXx]\\b`, 'g'), m => note('id18', m, zeroSameLength(m.length, m)))
    // 17-20 位订单号/流水号
    .replace(new RegExp(`\\b${NOT_ALL_ZERO}\\d{17,20}\\b`, 'g'), m => note('orderNo', m, zeroSameLength(m.length, m)))
    // 13 位机票票号/供应商单号
    .replace(new RegExp(`\\b${NOT_ALL_ZERO}\\d{13}\\b`, 'g'), m => note('ticketNo13', m, zeroSameLength(m.length, m)))
    // 中文姓名（仅在明确姓名语境后替换，避免误伤普通词）
    .replace(NAME_CONTEXT, (_m, prefix: string, name: string) => `${prefix}${note('name', name, name.replace(/[\u4e00-\u9fa5]/g, '某'))}`);
  return { text: out, replaced };
}

/** 脱敏整条用例（question/source/answer 全覆盖），返回新对象 */
export function sanitizeCase<T extends { question: string; source: string; answer: unknown }>(item: T): { item: T; replaced: SanitizeResult['replaced'] } {
  const question = sanitizeText(item.question);
  const source = sanitizeText(item.source);
  const answerText = sanitizeText(typeof item.answer === 'string' ? item.answer : JSON.stringify(item.answer));
  return {
    item: { ...item, question: question.text, source: source.text, answer: typeof item.answer === 'string' ? answerText.text : JSON.parse(answerText.text) },
    replaced: [...question.replaced, ...source.replaced, ...answerText.replaced],
  };
}

export interface RealCaseSeed {
  runId: string;
  caseId: string;
  question: string;
  source: string;
  answer: string;
  expected: boolean;
  category: string;
}

/** 从一次受控运行目录提取脱敏后的真实案例（question 取首个用户消息，source 取全部工具证据，answer 取候选草稿） */
export function buildCaseFromRun(runDir: string, expected: boolean, category: string): { item: Omit<RealCaseSeed, 'expected' | 'category'> & { expected: boolean; category: string }; replacedCount: number } {
  const messages = JSON.parse(fs.readFileSync(path.join(runDir, 'messages.json'), 'utf8')) as any[];
  const userMessage = messages.find(m => m.role === 'user' && typeof m.content === 'string' && !String(m.content).startsWith('<system-reminder>'));
  const toolEvidence = messages.filter(m => m.role === 'tool' && m.evidence).map(m => String(m.content ?? ''));
  // 候选草稿：第一条带复核记录的 assistant 消息（internal 标记的那个）；
  // 最后一条带复核记录的是已发布答案（含 reviewStatus/traceId），不能当候选草稿
  const draftMessage = messages.find(m => m.role === 'assistant' && m.review && typeof m.content === 'string' && m.content.trim());
  const answer = draftMessage ? String(draftMessage.content) : (fs.existsSync(path.join(runDir, 'answer.txt')) ? fs.readFileSync(path.join(runDir, 'answer.txt'), 'utf8') : '');
  const runId = path.basename(runDir);
  const sanitized = sanitizeCase({ question: userMessage ? String(userMessage.content) : '（未找到用户问题）', source: toolEvidence.join('\n'), answer });
  return {
    item: { runId, caseId: runId, question: sanitized.item.question, source: sanitized.item.source, answer: sanitized.item.answer as string, expected, category },
    replacedCount: sanitized.replaced.length,
  };
}
