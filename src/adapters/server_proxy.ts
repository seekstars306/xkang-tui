import OpenAI from 'openai';
import { collectChatStream, formatModelMessages } from '@xkang/agent-core/protocol';
import type { BaseModelAdapter } from './base.js';
import type { Message, StreamEvent, ToolDefinition } from '../types/index.js';
import { getDeviceId } from '../utils/device.js';
export class ServerProxyAdapter implements BaseModelAdapter {
  private client: OpenAI;
  constructor(serverUrl: string, token: string, public modelType = 'xkang-managed') {
    this.client = new OpenAI({ apiKey: token || 'default-token', baseURL: serverUrl.replace(/\/+$/, '') + '/v1', defaultHeaders: { 'x-device-id': getDeviceId() } });
  }
  async streamChat(messages: Message[], tools: ToolDefinition[], emit: (event: StreamEvent) => void, options?: { signal?: AbortSignal }): Promise<Message> {
    const stream = await this.client.chat.completions.create({ model: this.modelType, messages: formatModelMessages(messages),
      tools: tools.length ? tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters as any } })) : undefined,
      stream: true, stream_options: { include_usage: true },
    }, { signal: options?.signal });
    return collectChatStream(stream, emit);
  }
}
