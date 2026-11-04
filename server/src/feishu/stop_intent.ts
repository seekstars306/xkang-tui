import { loadServerConfig } from '../config.js';
import { outboundFetch } from '../outbound_http.js';

/**
 * 判断一条 @ 消息是不是在要求「停止当前排查」。
 *
 * 场景：一轮排查正在跑，客服发现方向错了（例如没看到截图、问的是另一件事），
 * 直接在群里 @ 机器人说「停」「别查了」。这时候应当立刻中断，
 * 而不是等它跑完再把一个已经跑偏的结论发出来。
 *
 * 判定完全交给 Jev，不自己做关键词表：
 * 「别停吧」「先别停，继续查」这类否定说法，词表很容易判反；
 * 交给模型理解语义，比维护一份越写越长的正则可靠。
 *
 * 保守方向是**不停止**：判不出来就不停。
 * 误判成停止会白白丢掉一轮已经跑了很久的工作，代价远大于多跑一会儿。
 */

export interface StopIntentResult {
  shouldStop: boolean;
  /** 有值说明 Jev 没跑成，走了退路（退路一律是不停止） */
  degraded?: string;
}

const QUESTIONS = {
  intent: {
    type: 'choice' as const,
    instructions:
      'Is the user asking to stop the investigation that is currently running, or are they saying something else?',
    criteria: {
      stop:
        'Explicitly asks to stop or cancel the running investigation — e.g. "停", "停吧", "别查了", "不用查了", "先停下", "取消这次排查", "方向错了别查了". It does not introduce a new question that should be answered instead',
      other:
        'Anything else: adds information, asks to continue or keep going (including negations like "别停", "先别停", "不要停"), digs deeper, asks a new question, or is ordinary conversation',
    },
  },
};

/**
 * 用 Jev 判断是否「停止」。
 *
 * Jev 不可达、超时或没给出明确判断时一律返回不停止：
 * 停错一次就丢掉一整轮排查，比多跑一会儿严重得多。
 */
export async function isStopIntent(
  text: string,
  options: { timeoutMs?: number } = {},
): Promise<StopIntentResult> {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { shouldStop: false };

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return { shouldStop: false, degraded: '未配置 TYPESAFE_API_KEY' };

  try {
    const cfg = loadServerConfig();
    const res = await outboundFetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        model: 'jev-1.13.0',
        state: `=== USER MESSAGE ===\n${trimmed.slice(0, 1000)}`,
        questions: QUESTIONS,
      }),
      timeoutMs: options.timeoutMs ?? 2500,
    }, cfg.outboundProxy);
    if (!res.ok) return { shouldStop: false, degraded: `Jev HTTP ${res.status}` };
    const json = (await res.json()) as { answers?: { intent?: { choice?: string } } };
    const choice = json.answers?.intent?.choice;
    if (choice === 'stop') return { shouldStop: true };
    if (choice === 'other') return { shouldStop: false };
    return { shouldStop: false, degraded: 'Jev 未给出明确判断' };
  } catch (error) {
    return {
      shouldStop: false,
      degraded: `Jev 调用失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
