import { collectChatStream, formatModelMessages } from '@xkang/agent-core/protocol';
import type { ChatGateway, Message, ModelType, StreamEvent, ToolDefinition } from '@xkang/agent-core';
import { getProviderClient, sanitizeOpenAiMessages } from '../llm.js';
import { type ManagedModelId } from '../model_state.js';
import type { ServerConfig } from '../types.js';
import type { AuditLogger } from '../auth.js';

type ProviderClient = ReturnType<typeof getProviderClient>;
export type ProviderClientFactory = (model: ManagedModelId, config: ServerConfig) => ProviderClient;

/** 单次模型调用的时限与重试：复核调用用复核预算且不重试；其余调用显式带上限，最多重试 1 次（SDK 默认多次重试叠加超时会达到十几分钟） */
export function modelCallOptions(isReview: boolean, config: ServerConfig): { maxRetries: number; timeout: number } {
  return isReview ? { maxRetries: 0, timeout: config.answerReviewTimeoutMs } : { maxRetries: 1, timeout: config.modelCallTimeoutMs };
}

/** 运行级取消信号与复核调用信号的合并：两者都在时任一 abort 即取消；只存在一个时原样使用 */
export function combineRunSignal(runSignal?: AbortSignal, callSignal?: AbortSignal): AbortSignal | undefined {
  if (runSignal && callSignal) return AbortSignal.any([runSignal, callSignal]);
  return callSignal || runSignal;
}

/**
 * 业务答案的 JSON 约束方式。
 *
 * 各家上游对 response_format 的支持不一样，实测：
 *   - gemini-3.8-flash：认 json_object；给 json_schema 直接 400
 *   - deepseek-v4.1-flash：**无视 json_object**（照样输出 Markdown）；
 *     给 json_schema 才会真的输出 JSON
 *
 * 一旦模型不输出 JSON，复核解析失败 → 两次修订都过不了 → 最终发布兜底文案，
 * 客服拿不到任何结论。所以这是"能不能用"的问题，不是格式偏好。
 * 用 MODEL_JSON_FORMAT 切换，默认 json_object 保持原有行为。
 */
function pickResponseFormat(mode: string | undefined):
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } } {
  if ((mode ?? '').trim() !== 'json_schema') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: 'business_answer',
      strict: false,
      schema: {
        type: 'object',
        properties: {
          answer: {
            type: 'object',
            properties: {
              conclusion: { type: 'string' },
              businessData: { type: 'array', items: { type: 'object' } },
              evidenceSummary: { type: 'array', items: { type: 'string' } },
              customerReply: { type: 'string' },
              pendingItems: { type: 'array', items: { type: 'string' } },
            },
            required: ['conclusion'],
          },
          evidenceIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['answer'],
      },
    },
  };
}

/**
 * 是否值得重试。
 *
 * 网络中断、超时、上游 5xx、限流都可能是瞬时的，重试有意义；
 * 400/401/403/404 这类是请求本身有问题，重试只会重复失败并拖长排查时间。
 */
function isRetryableModelError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  // terminated / other side closed / premature close 都是 undici 在流被切断时
  // 抛的 TypeError，属于典型的可恢复网络错误。之前不在白名单里，
  // 结果模型流一断就直接判定失败，连一次重试都没有（线上真实踩过）。
  if (/connection error|econnreset|econnrefused|etimedout|socket hang up|network|timed?\s*out|timeout|fetch failed|terminated|other side closed|premature close|und_err/.test(message)) return true;
  const status = (error as { status?: number; statusCode?: number; code?: string | number } | null);
  const code = typeof status?.status === 'number' ? status.status : typeof status?.statusCode === 'number' ? status.statusCode : null;
  if (code !== null) return code === 429 || code >= 500;
  return false;
}

/** Direct server-side model access; no employee HTTP/MCP credentials or private responses cross the client. */
export class BusinessModel implements ChatGateway {
  constructor(private config: ServerConfig, private model: ManagedModelId, private audit: AuditLogger, private owner: string, private runSignal?: AbortSignal, private jsonMode = true, private clientFactory: ProviderClientFactory = getProviderClient) {}
  /** 审计层级标签，默认 L2（排查模型） */
  private auditTier: 'L2' | 'L3' = 'L2';
  /** 审计里的模型名，默认用 model；L3 复核时换成真实的复核模型名 */
  private auditLabel?: string;
  /**
   * 把本次调用记为 L3 独立复核模型。
   * 复核网关用 'gemini' 这个 ManagedModelId 复用 gemini 的 reasoning 参数通道，
   * 如果审计里也照抄 'gemini [L2]'，日志上就分不出"复核模型挂了"还是"排查模型挂了"——
   * 而这两件事的处置完全不同（前者降级重跑，后者报模型异常）。
   */
  asReviewTier(label?: string): this { this.auditTier = 'L3'; this.auditLabel = label; return this; }
  private auditModel(): string { return `${this.auditLabel || this.model} [${this.auditTier}]`; }
  getCurrentModel(): ModelType { return 'xkang-managed'; }
  switchModel() { /* An in-flight business turn keeps its server-side model snapshot. */ }
  async streamChat(messages: Message[], tools: ToolDefinition[], emit: (event: StreamEvent) => void, options?: { signal?: AbortSignal }): Promise<Message> {
    /**
     * 偶发的连接中断必须重试，否则一次抖动就让整轮排查降级成兜底文案。
     * 实测上游几十次调用里会出现 Connection error，重试一次通常就成功。
     * 只重试可恢复的网络类错误：参数错误、鉴权失败重试多少次都没用，直接抛。
     */
    const attempts = this.messagesPerCallRetries();
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.streamChatOnce(messages, tools, emit, options);
      } catch (error) {
        lastError = error;
        // 主动取消不重试：那是调用方要求停下
        if (options?.signal?.aborted || this.runSignal?.aborted) throw error;
        if (!isRetryableModelError(error) || attempt === attempts) throw error;
        const delay = 800 * attempt;
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  private messagesPerCallRetries(): number {
    const raw = Number(process.env.MODEL_CALL_RETRIES ?? '3');
    return Number.isInteger(raw) && raw >= 1 && raw <= 5 ? raw : 3;
  }

  private async streamChatOnce(messages: Message[], tools: ToolDefinition[], emit: (event: StreamEvent) => void, options?: { signal?: AbortSignal }): Promise<Message> {
    const started = Date.now();
    const purpose = options?.signal ? 'answer_review' : 'investigation';
    const signal = combineRunSignal(this.runSignal, options?.signal);
    let usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
    let reportedUsage: any;
    let returnedModel: string | undefined;
    // 复核调用可单独设置思考档位（M3 实验）；缺省沿用调查档位；'default' 时不传 reasoning_effort
    const effortSetting = options?.signal ? this.config.reviewReasoningEffort ?? this.config.geminiReasoningEffort : this.config.geminiReasoningEffort;
    const reasoningEffort = this.model === 'gemini' && effortSetting !== 'default' ? (effortSetting ?? 'high')
      // deepseek 只在排查调用上带推理档位（DEEPSEEK_REASONING_EFFORT），复核调用保持原样
      : this.model === 'deepseek' && !options?.signal ? this.config.deepseekReasoningEffort : undefined;
    try {
      const { client, targetModel } = this.clientFactory(this.model, this.config);
      const stream = await client.chat.completions.create({ model: targetModel,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(this.jsonMode || options?.signal ? { response_format: pickResponseFormat(process.env.MODEL_JSON_FORMAT) } : {}),
        messages: sanitizeOpenAiMessages(formatModelMessages(messages)),
        tools: tools.length ? tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters as any } })) : undefined,
        stream: true, stream_options: { include_usage: true },
      }, { signal, ...modelCallOptions(Boolean(options?.signal), this.config) });
      const recorded = (async function* () {
        for await (const chunk of stream) {
          if (chunk.usage) reportedUsage = chunk.usage;
          returnedModel = chunk.model || returnedModel;
          yield chunk;
        }
      })();
      const result = await collectChatStream(recorded, event => {
        if (event.type === 'usage_sync') usage = { promptTokens: event.promptTokens, completionTokens: event.completionTokens, reasoningTokens: event.reasoningTokens || 0, totalTokens: event.promptTokens + event.completionTokens };
        emit(event);
      });
      signal?.throwIfAborted();
      usage.totalTokens = reportedUsage?.total_tokens ?? usage.totalTokens;
      this.audit.log({ timestamp: new Date().toISOString(), user: this.owner, type: 'llm_chat', model: this.auditModel(), details: { purpose, targetModel, returnedModel, reasoningEffort: reasoningEffort || 'default', usageReported: Boolean(reportedUsage), reasoningTokens: usage.reasoningTokens, cachedInputTokens: reportedUsage?.prompt_tokens_details?.cached_tokens }, tokensUsed: usage, durationMs: Date.now() - started, success: true });
      return result;
    } catch (error) {
      this.audit.log({ timestamp: new Date().toISOString(), user: this.owner, type: 'llm_chat', model: this.auditModel(), details: { purpose, reasoningEffort: reasoningEffort || 'default' }, durationMs: Date.now() - started, success: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}
