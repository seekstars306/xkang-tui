import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import { BaseModelAdapter } from './base.js';
import { Message, StreamEvent, ToolCall, ToolDefinition } from '../types/index.js';

export class GeminiAdapter implements BaseModelAdapter {
  modelType = 'gemini-3.7-flash';
  private ai: GoogleGenAI;
  private modelName: string;

  constructor(apiKey: string, modelName = 'gemini-2.5-flash') {
    this.ai = new GoogleGenAI({ apiKey: apiKey || 'dummy-key' });
    this.modelName = modelName;
  }

  async streamChat(
    messages: Message[],
    tools: ToolDefinition[],
    onEvent: (event: StreamEvent) => void
  ): Promise<Message> {
    try {
      // Map system message
      let systemInstruction = '';
      const chatContents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

      for (const m of messages) {
        if (m.role === 'system') {
          systemInstruction += (systemInstruction ? '\n\n' : '') + m.content;
          continue;
        }

        if (m.role === 'user') {
          if (typeof m.content === 'string') {
            chatContents.push({
              role: 'user',
              parts: [{ text: m.content }],
            });
          } else if (Array.isArray(m.content)) {
            const parts: Array<Record<string, unknown>> = [];
            for (const part of m.content) {
              if (part.type === 'text') {
                parts.push({ text: part.text });
              } else if (part.type === 'image_url') {
                const url = part.image_url.url;
                if (url.startsWith('data:')) {
                  const match = url.match(/^data:([^;]+);base64,(.+)$/);
                  if (match) {
                    parts.push({
                      inlineData: {
                        mimeType: match[1],
                        data: match[2],
                      },
                    });
                  }
                }
              }
            }
            chatContents.push({ role: 'user', parts });
          }
        } else if (m.role === 'assistant') {
          const parts: Array<Record<string, unknown>> = [];
          const textContent = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? JSON.stringify(m.content) : '');
          if (textContent) {
            parts.push({ text: textContent });
          }
          if (m.tool_calls) {
            for (const tc of m.tool_calls) {
              parts.push({
                functionCall: {
                  name: tc.name,
                  args: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments,
                },
              });
            }
          }
          chatContents.push({ role: 'model', parts });
        } else if (m.role === 'tool') {
          chatContents.push({
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: m.name || 'tool_response',
                  response: { result: m.content },
                },
              },
            ],
          });
        }
      }

      // Convert tool definitions to Gemini FunctionDeclarations
      const functionDeclarations = tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: Type.OBJECT,
          properties: t.parameters.properties as Record<string, any>,
          required: t.parameters.required || [],
        },
      })) as unknown as FunctionDeclaration[];

      const toolConfig = functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined;

      const responseStream = await this.ai.models.generateContentStream({
        model: this.modelName,
        contents: chatContents,
        config: {
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          tools: toolConfig,
        },
      });

      let fullContent = '';
      let fullReasoning = '';
      const finalToolCalls: ToolCall[] = [];

      for await (const chunk of responseStream) {
        const candidate = chunk.candidates?.[0];
        if (!candidate?.content?.parts) continue;

        for (const part of candidate.content.parts) {
          // Check for thought / thinking
          if ((part as unknown as { thought?: string }).thought) {
            const thought = (part as unknown as { thought: string }).thought;
            fullReasoning += thought;
            onEvent({ type: 'reasoning_chunk', chunk: thought });
          } else if (part.text) {
            fullContent += part.text;
            onEvent({ type: 'content_chunk', chunk: part.text });
          }

          if (part.functionCall) {
            const fc = part.functionCall;
            const tcObj: ToolCall = {
              id: `gemini_call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              name: fc.name || '',
              arguments: (fc.args as Record<string, unknown>) || {},
            };
            finalToolCalls.push(tcObj);
            onEvent({ type: 'tool_call_start', toolCall: tcObj });
          }
        }

        if (chunk.usageMetadata) {
          onEvent({
            type: 'usage_sync',
            promptTokens: chunk.usageMetadata.promptTokenCount || 0,
            completionTokens: chunk.usageMetadata.candidatesTokenCount || 0,
            reasoningTokens: 0,
          });
        }
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
