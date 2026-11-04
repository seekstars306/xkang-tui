import { loadServerConfig } from '../config.js';
import { outboundFetch } from '../outbound_http.js';

/**
 * 判断一条 @ 消息是不是在要求「继续排查」。
 *
 * 场景：一次排查用完了预算（15 分钟）就收尾了，客服想接着查下去。
 * 他会在机器人那条回复下面回复"继续""接着查"之类的话并 @ 机器人。
 * 这句话本身不含任何业务信息，只有意图，所以要单独判定。
 *
 * 判定不了的保守做法：**当作不是继续**，退回普通的补充流程。
 * 宁可让客服再说一次，也不要把一句无关的话当成加预算指令，
 * 那会白白再烧一轮预算。
 */

export interface ContinueIntentResult {
  isContinue: boolean;
  /** 有值说明 Jev 没跑成，走了退路 */
  degraded?: string;
}

// "再往下查"原先不在快速路径里（只有"再查""往下查"），要等 Jev 判定；Jev 不可达时退回关键词又判不中，
// 客服的"再往下查"就不会续查。2026-10-29 Jev 不可达时由 feishu_continue.test.ts 暴露。
const CONTINUE_WORDS = /^(继续|接着|继续吧|接着查|再查|再往下|往下查|继续排查|继续查|go\s*on|continue)/i;

/** 只看关键词的同步判定（不联网）：用于必须立刻发出的回执措辞；最终是否续查仍以 isContinueIntent 为准 */
export function isObviousContinue(text: string): boolean {
  return CONTINUE_WORDS.test((text ?? '').trim());
}

const QUESTIONS = {
  intent: {
    type: 'choice' as const,
    instructions:
      'Is the user asking to continue the same investigation that just stopped, or are they raising something new?',
    criteria: {
      continue:
        'Asks to keep going on the same case — e.g. "继续", "接着查", "再往下查", "别停", optionally with extra clarification about the same order or person. No new case is introduced',
      new_request:
        'Raises a different question, a different order or customer, or has nothing to do with continuing the previous investigation',
    },
  },
};

/**
 * 用 Jev 判断是否「继续」。
 *
 * Jev 不可用或超时时用关键词兜底：这条路必须有人在等，
 * 不能因为判定服务挂了就让客服的"继续"石沉大海。
 */
export async function isContinueIntent(
  text: string,
  options: { timeoutMs?: number } = {},
): Promise<ContinueIntentResult> {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { isContinue: false };

  // 先做一次极便宜的预判：明显的继续词直接过，不打网络
  if (CONTINUE_WORDS.test(trimmed)) return { isContinue: true };

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    return { isContinue: false, degraded: '未配置 TYPESAFE_API_KEY' };
  }

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
      // 默认给 2.5 秒：这条判定发生在事件回调里，飞书要求 3 秒内 ACK，
      // 宁可退回关键词判断，也不能拖到飞书重推。
      timeoutMs: options.timeoutMs ?? 2500,
    }, cfg.outboundProxy);
    if (!res.ok) return { isContinue: CONTINUE_WORDS.test(trimmed), degraded: `Jev HTTP ${res.status}` };
    const json = (await res.json()) as { answers?: { intent?: { choice?: string } } };
    const choice = json.answers?.intent?.choice;
    if (choice === 'continue') return { isContinue: true };
    if (choice === 'new_request') return { isContinue: false };
    return { isContinue: false, degraded: 'Jev 未给出明确判断' };
  } catch (error) {
    return {
      isContinue: CONTINUE_WORDS.test(trimmed),
      degraded: `Jev 调用失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
