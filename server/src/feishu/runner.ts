import type { AgentRunner, RunnerResult } from './dispatcher.js';

/**
 * 真正调用 xkang 的 runner。
 *
 * 走服务端既有的 /agent 接口（Bearer 鉴权 + SSE），而不是直接 new AgentCore：
 * 这样飞书进来的问题和客户端进来的是同一条链路，复核、发布策略、审计都一致。
 *
 * 每个新问题建一个会话，保证上下文干净；加预算续查则走服务端的 /continue，
 * 复用同一个会话，把之前查到的证据接上，而不是从头再查一遍。
 */

export interface HttpRunnerOptions {
  baseUrl: string;
  token: string;
  /** 单次排查最长等待时间，超过则中断并回报超时 */
  timeoutMs?: number;
  log?: (message: string) => void;
}

interface PublicAnswerLike {
  conclusion?: string;
  businessData?: Array<{ label: string; value: string }>;
  pendingItems?: string[];
  customerReply?: string;
  reviewStatus?: string;
  /** 预算用尽被冻结：问题还没查完，可以追加预算接着查 */
  frozen?: boolean;
}

/** 从 SSE 流里拼出最终答案；只取 answer/done/error 三类事件 */
export class HttpAgentRunner implements AgentRunner {
  constructor(private readonly options: HttpRunnerOptions) {}

  /** 新建会话 */
  async createSession(): Promise<string> {
    const { baseUrl } = this.options;
    const created = await this.json<{ id: string }>(`${baseUrl}/agent/sessions`, { method: 'POST' });
    const id = created?.id ?? '';
    if (!id) throw new Error('创建会话失败');
    return id;
  }

  /**
   * 立刻停止这个会话正在跑的一轮。
   *
   * 服务端有运行级 AbortController（AgentService.abort），这里只是把它暴露给桥接：
   * 客服在群里说“停”，就不该让已经跑偏的一轮继续烧预算、更不该把结论发出去。
   */
  async abort(sessionId: string): Promise<boolean> {
    const { baseUrl, token } = this.options;
    try {
      const res = await fetch(`${baseUrl}/agent/sessions/${encodeURIComponent(sessionId)}/abort`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok && res.status !== 409) return false;
      const body = (await res.json().catch(() => ({}))) as { aborted?: boolean };
      return body.aborted === true;
    } catch {
      return false;
    }
  }

  /** 跑一轮排查：给了 sessionId 就追加到已有会话，否则新建 */
  async run(input: {
    issueId: string;
    content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
    sessionId?: string | null;
  }): Promise<RunnerResult> {
    const sessionId = input.sessionId || await this.createSession();
    try {
      const answer = await this.stream(
        `/agent/sessions/${encodeURIComponent(sessionId)}/messages`,
        { message: input.content },
      );
      return this.result(answer, input.issueId, sessionId, await this.isFrozen(sessionId));
    } catch (error) {
      // 把会话 ID 带出去：排查中途失败时，客服仍然可以要求"继续"，
      // 直接用这个会话接着跑，不必从零重来。
      if (error && typeof error === 'object') (error as { sessionId?: string }).sessionId = sessionId;
      throw error;
    }
  }

  /**
   * 加预算续查。
   *
   * 必须走服务端的 /continue，而不是"再发一条消息"：
   *   - 它把 extensions += 1，从而 turnsAllowed 也跟着涨
   *   - 它重置活跃时间窗口，给一整段新的预算
   *   - 它从保存的消息与运行状态恢复，工具结果、已读代码都还在
   *   - 它以系统提醒的形式注入"人工已追加预算"，不会把续查看成一次新的用户提问
   * 直接发消息则只是普通追问，冻结标记不会清除，预算也不会延长。
   *
   * content：排查期间排队的客服补充，随续查一起带给服务端（body.message）；不带时请求与原来一致。
   */
  async resume(
    sessionId: string,
    issueId: string,
    content?: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>,
  ): Promise<RunnerResult> {
    const answer = await this.stream(`/agent/sessions/${encodeURIComponent(sessionId)}/continue`, content?.length ? { message: content } : undefined);
    return this.result(answer, issueId, sessionId, await this.isFrozen(sessionId));
  }

  /**
   * 会话是否处于"预算用尽被冻结"状态。
   *
   * 注意 frozen 挂在**会话**上，不在 answer 上（PublicSession.frozen），
   * 所以只能跑完之后再查一次会话，不能在 answer 里找。
   */
  private async isFrozen(sessionId: string): Promise<boolean> {
    const { baseUrl, token } = this.options;
    try {
      const res = await fetch(`${baseUrl}/agent/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false;
      const session = (await res.json()) as { frozen?: boolean };
      return session.frozen === true;
    } catch {
      // 查不到就当没冻结：宁可少提示一次"继续"，也不要误报
      return false;
    }
  }

  /**
   * 答案是不是"没查完"的兜底。
   *
   * 这两种文案分别是 core 的 FALLBACK 和服务的 unavailableAnswer，
   * 都表示"没有形成可采信的结论"。客服看到这种答案时应当被告知可以继续，
   * 否则只会认为这件事办不成。
   */
  private static readonly INCOMPLETE_MARKERS = [
    '目前尚未得出可靠结论',
    '本次尚未形成可直接采信的业务结论',
  ];

  private isIncomplete(answer: PublicAnswerLike): boolean {
    const text = (answer.conclusion ?? '').trim();
    if (!text) return true;
    return HttpAgentRunner.INCOMPLETE_MARKERS.some(marker => text.includes(marker));
  }

  private result(answer: PublicAnswerLike, issueId: string, sessionId: string, frozen: boolean): RunnerResult {
    return {
      text: this.format(answer, issueId),
      answer: answer as unknown as Record<string, unknown>,
      sessionId,
      // frozen = 预算用尽、问题没查完 → 群里要问"是否继续"
      frozen,
      // 冻结、或压根没形成结论（模型超时等），都需要给客服一个"继续"的入口
      incomplete: this.isIncomplete(answer),
    };
  }

  /** 读 SSE 直到流结束，返回最后一条 answer */
  private async stream(path: string, body: unknown): Promise<PublicAnswerLike> {
    const { baseUrl, token, timeoutMs = 20 * 60 * 1000 } = this.options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`发起排查失败：HTTP ${res.status}`);

      let answer: PublicAnswerLike | null = null;
      let streamError: string | null = null;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const line = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          try {
            // 注意字段名：core 发的是 { type: 'error', error }，而 PublicEvent 的
            // 类型声明写的是 message。只读 message 会永远拿到 undefined，
            // 结果所有模型失败都被当成正常答案发出去（线上真出现过）。
            const event = JSON.parse(line.slice(6)) as {
              type?: string; answer?: PublicAnswerLike; message?: string; error?: string;
            };
            if (event.type === 'answer' && event.answer) answer = event.answer;
            if (event.type === 'error') streamError = event.message ?? event.error ?? '未知错误';
          } catch { /* 心跳等非 JSON 片段忽略 */ }
        }
      }
      if (streamError) throw new Error(streamError);
      // 不拦截"没查出结论"的答案：模型说"尚未得出可靠结论"也是它给出的结论，
      // 应当原样转达。真正的服务故障由 streamError 覆盖。
      if (!answer) throw new Error('排查结束但没有拿到答案');
      return answer;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 给群里的简短回复：结论 + 关键数据 + 待确认。
   * 群消息不适合贴长篇依据，完整内容留给详情页。
   */
  private format(answer: PublicAnswerLike, issueId: string): string {
    const lines = [`【结论】`];
    // 模型的结论原样转达；只有真的空着时才用兜底句
    lines.push(answer.conclusion || '本次未形成可直接采信的结论。');
    const data = (answer.businessData ?? []).slice(0, 6);
    if (data.length) {
      lines.push('', '【业务信息】');
      for (const item of data) lines.push(`${item.label}：${item.value}`);
    }
    const pending = (answer.pendingItems ?? []).slice(0, 4);
    if (pending.length) {
      lines.push('', '【还需确认】');
      for (const item of pending) lines.push(`· ${item}`);
    }
    if (answer.reviewStatus === 'needs_human') lines.push('', '（本结论尚未完成自动复核，建议二线核实后再答复客户。）');
    lines.push('', `问题编号 ${issueId}`);
    return lines.join('\n');
  }

  private async json<T>(url: string, init: RequestInit): Promise<T | null> {
    const res = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.token}`, ...(init.headers ?? {}) },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  }
}
