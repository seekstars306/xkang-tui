import { loadServerConfig } from '../config.js';
import { outboundFetch } from '../outbound_http.js';
import { DEFAULT_HISTORY_MINUTES } from './context.js';
import type { FeishuMessageSummary } from './context.js';

/**
 * 历史消息相关性筛选。
 *
 * 用途：客服 @ 机器人时，群里此前可能已经有关于这个问题的讨论。
 * 这里的任务是**判断哪些历史消息与当前问题相关**，而不是替客服决定要问什么。
 *
 * 为什么必须以当前问题为主：之前是按时间窗口把前 20 条一股脑塞进上下文，
 * 结果新问题和旧问题混在一起，模型答的是旧问题（真实发生过）。
 * 正确顺序是：先确定“这次要问什么”，再问“历史里哪些和它有关”。
 *
 * 失败策略：任何异常都保留全部候选（宁可多给材料，不可漏掉证据），
 * 并在结果里标注降级原因，方便事后核对。
 */

export interface RelevanceResult {
  /** 判定为相关的消息 ID */
  relevant: string[];
  /** 判定为无关的消息 ID */
  irrelevant: string[];
  /** 无法判断的消息 ID：默认保留 */
  uncertain: string[];
  /** 降级原因；有值说明没跑成，调用方应知道这次是“全保留” */
  degraded?: string;
}

/**
 * 时间窗上限（分钟），与范围裁剪共用同一个来源，避免两处各写一个 30 逐渐漂移。
 *
 * 群聊里超过半小时的对话，基本已经是另一件事：真实案例中客服问“因公护照推送不过来”，
 * 上下文里混进了 16 小时前的“航变短信发送失败”，模型于是去答旧问题。
 * 程序侧先按这个窗口裁剪，这里再把它显式告诉 Jev，
 * 让它在“文本很像但时间差很大”时判为不相关。
 */
export const MAX_HISTORY_MINUTES = DEFAULT_HISTORY_MINUTES;

const QUESTIONS = {
  relevance: {
    type: 'choice' as const,
    instructions:
      'Do these earlier group messages help answer the current question? Judge only whether they provide information about the same case, order, ticket or symptom.',
    criteria: {
      relevant:
        'Talks about the same order, ticket number, phone number, customer or the same symptom, AND was sent within the last 30 minutes of the current question — including partial clues like a price or a screenshot of the same case',
      unrelated:
        'About a different case, a different customer or a different topic, OR more than 30 minutes earlier than the current question even if the wording looks similar — a gap that large means the topic has moved on',
      insufficient:
        'Cannot tell whether it belongs to the same case from the text alone',
    },
  },
};

/** 把候选消息压成一段紧凑文本，控制 token 又不丢关键标识 */
function renderCandidates(messages: FeishuMessageSummary[], maxCharsPerMessage = 300): string {
  return messages
    .map((m, i) => {
      const stamp = new Date(m.createTimeMs).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
      const body = (m.text || (m.resourceKeys.length ? '[附件]' : '')).slice(0, maxCharsPerMessage);
      return `#${i} ${stamp} ${body}`;
    })
    .join('\n');
}

/**
 * 逐条判断历史消息与当前问题的相关性。
 *
 * 一次问一条而不是一次问一批：Jev 在长列表上容易给出笼统判断，
 * 单条判断的准确率明显更高，且失败时能精确定位是哪一条出的问题。
 */
export async function filterRelevantHistory(
  question: string,
  candidates: FeishuMessageSummary[],
  opts: { timeoutMs?: number; nowMs?: number } = {},
): Promise<RelevanceResult> {
  const all = candidates.map(m => m.messageId);
  if (!candidates.length) return { relevant: [], irrelevant: [], uncertain: [] };

  const cfg = loadServerConfig();
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return { relevant: [], irrelevant: [], uncertain: all, degraded: '未配置 TYPESAFE_API_KEY，保留全部历史' };

  const relevant: string[] = [];
  const irrelevant: string[] = [];
  const uncertain: string[] = [];

  for (const msg of candidates) {
    // 把时间差写进 state：光有两条文本，Jev 无法察觉“隔了 16 小时”。
    // 基准时间用调用方传入的主问题时间，而不是当前时钟——否则排队等待的时间
    // 也会被算进间距，把刚发完的补充误判成“过去太久”。
    const baseMs = opts.nowMs ?? Date.now();
    const gapMinutes = Math.max(0, Math.round((baseMs - msg.createTimeMs) / 60_000));
    const state = [
      '=== CURRENT QUESTION ===',
      question.slice(0, 4000),
      '',
      `=== EARLIER MESSAGE (sent ${gapMinutes} minutes before now; relevance window is ${MAX_HISTORY_MINUTES} minutes) ===`,
      renderCandidates([msg]),
    ].join('\n');
    try {
      const res = await outboundFetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: 'jev-1.13.0', state, questions: QUESTIONS }),
        timeoutMs: opts.timeoutMs ?? 15000,
      }, cfg.outboundProxy);
      if (!res.ok) { uncertain.push(msg.messageId); continue; }
      const json = (await res.json()) as { answers?: { relevance?: { choice?: string } } };
      const choice = json.answers?.relevance?.choice;
      if (choice === 'relevant') relevant.push(msg.messageId);
      else if (choice === 'unrelated') irrelevant.push(msg.messageId);
      else uncertain.push(msg.messageId);
    } catch {
      // 单条失败不影响其他条：归入“无法判断”，默认保留
      uncertain.push(msg.messageId);
    }
  }

  return { relevant, irrelevant, uncertain };
}
