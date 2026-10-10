import { collectChatStream, formatModelMessages } from '@xkang/agent-core/protocol';
import type { ChatGateway, Message, ModelType, StreamEvent, ToolDefinition } from '@xkang/agent-core';
import { getProviderClient, sanitizeOpenAiMessages } from '../llm.js';
import { type ManagedModelId } from '../model_state.js';
import type { ServerConfig } from '../types.js';
import type { AuditLogger } from '../auth.js';

/** Direct server-side model access; no employee HTTP/MCP credentials or private responses cross the client. */
export class BusinessModel implements ChatGateway {
  constructor(private config: ServerConfig, private model: ManagedModelId, private audit: AuditLogger, private owner: string, private runSignal?: AbortSignal, private jsonMode = true) {}
  getCurrentModel(): ModelType { return 'xkang-managed'; }
  switchModel() { /* An in-flight business turn keeps its server-side model snapshot. */ }
  async streamChat(messages: Message[], tools: ToolDefinition[], emit: (event: StreamEvent) => void, options?: { signal?: AbortSignal }): Promise<Message> {
    const started = Date.now();
    const purpose = options?.signal ? 'answer_review' : 'investigation';
    const signal = this.runSignal && options?.signal ? AbortSignal.any([this.runSignal, options.signal]) : options?.signal || this.runSignal;
    let usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
    let reportedUsage: any;
    let returnedModel: string | undefined;
    const reasoningEffort = this.model === 'gemini' && this.config.geminiReasoningEffort !== 'default' ? 'high' : undefined;
    try {
      const { client, targetModel } = getProviderClient(this.model, this.config);
      const stream = await client.chat.completions.create({ model: targetModel,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(this.jsonMode || options?.signal ? { response_format: { type: 'json_object' as const } } : {}),
        messages: sanitizeOpenAiMessages(formatModelMessages(messages)),
        tools: tools.length ? tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters as any } })) : undefined,
        stream: true, stream_options: { include_usage: true },
      }, { signal, ...(options?.signal ? { maxRetries: 0, timeout: this.config.answerReviewTimeoutMs ?? 60000 } : {}) });
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
      this.audit.log({ timestamp: new Date().toISOString(), user: this.owner, type: 'llm_chat', model: `${this.model} [L2]`, details: { purpose, targetModel, returnedModel, reasoningEffort: reasoningEffort || 'default', usageReported: Boolean(reportedUsage), reasoningTokens: usage.reasoningTokens, cachedInputTokens: reportedUsage?.prompt_tokens_details?.cached_tokens }, tokensUsed: usage, durationMs: Date.now() - started, success: true });
      return result;
    } catch (error) {
      this.audit.log({ timestamp: new Date().toISOString(), user: this.owner, type: 'llm_chat', model: `${this.model} [L2]`, details: { purpose, reasoningEffort: reasoningEffort || 'default' }, durationMs: Date.now() - started, success: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}
