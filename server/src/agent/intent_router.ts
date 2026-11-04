import { loadServerConfig } from '../config.js';
import { outboundFetch } from '../outbound_http.js';

/**
 * 输入意图分流（旁路观察版）。
 *
 * 判定口径由用户给定：**要回答这条消息，是否需要查代码 / 日志 / 数据库**。
 * - l2_complex：需要查证，走 L2 深度排障
 * - l1_simple：不需要查证，直接回答
 * - ambiguous：信息不足，追问澄清（不猜、不漏）
 *
 * 当前阶段只做“观察”：分类结果写进 audit，不影响任何实际路由。
 * 等真实流量验证准确率后，再由调用方决定是否据此分流。
 */

export type RouteClass = 'l2_complex' | 'l1_simple' | 'ambiguous';

export interface RouteDecision {
  route: RouteClass;
  confidence: number;
  probabilities?: Record<string, number>;
  /** 分类失败时保留原因，调用方据此决定是否退回默认路径 */
  error?: string;
}

const QUESTIONS = {
  route: {
    type: 'choice' as const,
    instructions:
      'To answer this message properly, would someone need to look up company source code, production logs, or business databases?',
    criteria: {
      l2_complex:
        'Answering requires reading code, searching logs, or querying business databases — for example to explain why an order, invoice, refund, approval or export behaves the way it does',
      l1_simple:
        'Can be answered without touching code, logs or databases — greetings, thanks, general knowledge, or product how-to that needs no company data',
      ambiguous:
        'Might need a data lookup but the message is too vague to tell — a bare noun, a pronoun with no referent, or a symptom with no object',
    },
  },
};

/** 低于该置信度时一律按复杂任务处理：宁可多查，不可漏判 */
export const LOW_CONFIDENCE_FLOOR = 0.5;

/**
 * 信息是否足够开始排查。
 *
 * 只判“够不够”，**不判“缺什么”**——实测“缺什么”这一问只有 3/8 准确，会给出误导性的追问方向；
 * 而“够不够”是 8/8、置信度 1.00。缺什么、要不要追问用户，交给 L2 自己判断。
 */
export const SUFFICIENCY_QUESTIONS = {
  sufficient: {
    type: 'choice' as const,
    instructions: 'Does this message give enough to start troubleshooting, or must the user supply more before anyone can look it up?',
    criteria: {
      ready: 'Contains at least one locatable identifier (order number, ticket number, PNR) or a concrete enough symptom to locate the affected record',
      need_more: 'A business problem is described but nothing identifies which order, ticket or record to inspect',
      not_business: 'Not a business troubleshooting request at all',
    },
  },
};

export type Sufficiency = 'ready' | 'need_more' | 'not_business';

export interface SufficiencyDecision {
  sufficient: Sufficiency;
  confidence: number;
  error?: string;
}

/** 判断输入是否已包含可定位的线索；失败时按 need_more 处理（宁可多问一句） */
export async function judgeSufficiency(text: string, opts: { timeoutMs?: number } = {}): Promise<SufficiencyDecision> {
  const cfg = loadServerConfig();
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return { sufficient: 'need_more', confidence: 0, error: '未配置 TYPESAFE_API_KEY' };
  try {
    const res = await outboundFetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model: 'jev-1.13.0', state: 'USER MESSAGE: ' + text, questions: SUFFICIENCY_QUESTIONS }),
      timeoutMs: opts.timeoutMs ?? 15000,
    }, cfg.outboundProxy);
    if (!res.ok) return { sufficient: 'need_more', confidence: 0, error: `HTTP ${res.status}` };
    const json = (await res.json()) as { answers?: { sufficient?: { choice?: string; confidence?: number } } };
    const a = json.answers?.sufficient;
    return { sufficient: (a?.choice as Sufficiency) ?? 'need_more', confidence: Number(a?.confidence ?? 0) };
  } catch (error) {
    return { sufficient: 'need_more', confidence: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 把分类结果拼成给 L2 的上下文提示。
 *
 * 关键约束：这段文字只进入模型上下文，**不直接展示给用户**。
 * 要不要向用户追问、追问什么，由 L2 结合排查过程自行决定。
 */
export function routeContextNotice(route: RouteDecision, suff?: SufficiencyDecision, hasAttachment = false): string {
  const lines = [
    `【输入预判】分类=${route.route}（置信度 ${route.confidence.toFixed(2)}）`,
  ];
  if (suff) lines.push(`【输入预判】信息完整度=${suff.sufficient}（置信度 ${suff.confidence.toFixed(2)}）`);
  // 预判只看文字，看不到附件内容。带附件时不能把 need_more 当结论——附件里可能已经写明单号。
  if (route.route === 'l2_complex' && suff?.sufficient === 'need_more') {
    lines.push(hasAttachment
      ? '【输入预判】文字里没有可定位的单号/票号/PNR，但用户附带了附件。附件内容无法参与这条预判，请先查看附件里是否已有定位信息（单号、票号、姓名、报错原文等）；附件中确实没有时，再向用户索取最小必要信息，不要一次问多个问题。'
      : '【输入预判】该问题可能是业务问题，但输入里没有可定位的单号/票号/PNR。请先判断能否从上下文或系统推断出目标单据；确实无法定位时，再向用户索取最小必要信息，不要一次问多个问题。');
  } else if (route.route === 'ambiguous') {
    lines.push(hasAttachment
      ? '【输入预判】该输入指向不明，但用户附带了附件。请先查看附件内容再判断是否需要澄清；附件已足够定位时直接排查，否则只问一个最关键的问题。'
      : '【输入预判】该输入指向不明。若能结合上下文确定目标，直接排查；否则只问一个最关键的澄清问题。');
  } else if (route.route === 'l1_simple') {
    lines.push('【输入预判】该输入看起来不需要查代码、日志或数据库。若判断错误，请照常排查，不要因为这条预判而放弃取证。');
  }
  return lines.join('\n');
}

/**
 * 把分类结果折算成最终路由。
 * 规则（按用户确定的口径）：
 * - ambiguous → 追问澄清
 * - 置信度低于下限 → 升级 L2（防止 L1 时代的漏判重演）
 */
export function decideRoute(raw: { choice?: string; confidence?: number } | undefined): RouteDecision {
  if (!raw?.choice) return { route: 'l2_complex', confidence: 0, error: '分类结果为空，按复杂任务处理' };
  const route = raw.choice as RouteClass;
  const confidence = Number(raw.confidence ?? 0);
  if (confidence < LOW_CONFIDENCE_FLOOR) {
    return { route: 'l2_complex', confidence, error: `置信度 ${confidence.toFixed(2)} 低于 ${LOW_CONFIDENCE_FLOOR}，升级 L2` };
  }
  return { route, confidence };
}

/** 调用 Jev 做一次分流判断；任何异常都退回 l2_complex，绝不把业务问题当闲聊 */
export async function classifyInput(text: string, opts: { timeoutMs?: number } = {}): Promise<RouteDecision> {
  const cfg = loadServerConfig();
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return { route: 'l2_complex', confidence: 0, error: '未配置 TYPESAFE_API_KEY，按复杂任务处理' };
  try {
    const res = await outboundFetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model: 'jev-1.13.0', state: 'USER MESSAGE: ' + text, questions: QUESTIONS }),
      timeoutMs: opts.timeoutMs ?? 15000,
    }, cfg.outboundProxy);
    if (!res.ok) return { route: 'l2_complex', confidence: 0, error: `HTTP ${res.status}` };
    const json = (await res.json()) as { answers?: { route?: { choice?: string; confidence?: number; probabilities?: Record<string, number> } } };
    const a = json.answers?.route;
    const d = decideRoute(a);
    return { ...d, probabilities: a?.probabilities };
  } catch (error) {
    return { route: 'l2_complex', confidence: 0, error: error instanceof Error ? error.message : String(error) };
  }
}
