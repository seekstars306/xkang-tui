import OpenAI from 'openai';
import { BaseModelAdapter } from './base.js';
import { Message, StreamEvent, ToolCall, ToolDefinition } from '../types/index.js';

export class DeepSeekAdapter implements BaseModelAdapter {
  modelType = 'deepseek-v4-flash';
  private client: OpenAI;
  private modelName: string;

  constructor(apiKey: string, baseURL = 'https://api.deepseek.com/v1', modelName = 'deepseek-chat') {
    this.client = new OpenAI({
      apiKey: apiKey || 'dummy-key',
      baseURL,
    });
    this.modelName = modelName;
  }

  async streamChat(
    messages: Message[],
    tools: ToolDefinition[],
    onEvent: (event: StreamEvent) => void
  ): Promise<Message> {
    const formattedMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = messages.map((m) => {
      if (m.role === 'tool') {
        const textContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return {
          role: 'tool',
          tool_call_id: m.tool_call_id || 'unknown',
          content: textContent,
        };
      }
      if (m.role === 'assistant') {
        const textContent = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? JSON.stringify(m.content) : null);
        const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textContent || null,
        };
        if (m.tool_calls && m.tool_calls.length > 0) {
          msg.tool_calls = m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
            },
          }));
        }
        return msg;
      }
      if (m.role === 'system') {
        const textContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return {
          role: 'system',
          content: textContent,
        };
      }
      return {
        role: m.role,
        content: m.content as any,
      };
    });

    const formattedTools: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as unknown as Record<string, unknown>,
      },
    }));

    let fullReasoning = '';
    let fullContent = '';
    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      const stream = await this.client.chat.completions.create({
        model: this.modelName,
        messages: formattedMessages,
        tools: formattedTools.length > 0 ? formattedTools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      });

      for await (const chunk of stream) {
        if (chunk.usage) {
          const reasoning = (chunk.usage as unknown as { completion_tokens_details?: { reasoning_tokens?: number } })
            .completion_tokens_details?.reasoning_tokens || 0;
          onEvent({
            type: 'usage_sync',
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            reasoningTokens: reasoning,
          });
        }

        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta;

        // Handle DeepSeek native reasoning stream (if present in custom payload)
        const reasoningChunk = (delta as unknown as { reasoning_content?: string })?.reasoning_content;
        if (reasoningChunk) {
          fullReasoning += reasoningChunk;
          onEvent({ type: 'reasoning_chunk', chunk: reasoningChunk });
        }

        // Handle content delta
        if (delta.content) {
          fullContent += delta.content;
          onEvent({ type: 'content_chunk', chunk: delta.content });
        }

        // Handle Tool Call streaming assembly
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;
            if (!toolCallsMap.has(index)) {
              toolCallsMap.set(index, {
                id: tc.id || `call_${Date.now()}_${index}`,
                name: tc.function?.name || '',
                arguments: '',
              });
            }
            const current = toolCallsMap.get(index)!;
            if (tc.id) current.id = tc.id;
            if (tc.function?.name) {
              if (!current.name || tc.function.name.startsWith(current.name)) {
                current.name = tc.function.name;
              } else if (!current.name.includes(tc.function.name)) {
                current.name += tc.function.name;
              }
            }
            if (tc.function?.arguments) current.arguments += tc.function.arguments;
          }
        }
      }

      const finalToolCalls: ToolCall[] = [];
      for (const [, tc] of toolCallsMap.entries()) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.arguments || '{}');
        } catch {
          parsedArgs = { raw: tc.arguments };
        }
        const toolCallObj: ToolCall = {
          id: tc.id,
          name: tc.name,
          arguments: parsedArgs,
        };
        finalToolCalls.push(toolCallObj);
        onEvent({ type: 'tool_call_start', toolCall: toolCallObj });
      }

      const finalMessage: Message = {
        role: 'assistant',
        content: fullContent,
        reasoning_content: fullReasoning || undefined,
        tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
      };

      return finalMessage;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'error', error: errorMsg });
      throw err;
    }
  }
}
