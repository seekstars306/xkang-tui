import { BaseModelAdapter } from './base.js';
import { DeepSeekAdapter } from './deepseek.js';
import { GeminiAdapter } from './gemini.js';
import { GrokAdapter } from './grok.js';
import { ServerProxyAdapter } from './server_proxy.js';
import { AppConfig } from '../config/models.js';
import { Message, ModelType, StreamEvent, ToolDefinition } from '../types/index.js';

export class ModelGateway {
  private adapters: Map<ModelType, BaseModelAdapter> = new Map();
  private currentModel: ModelType;
  private isServerManaged = false;

  constructor(config: AppConfig) {
    if (config.serverUrl) {
      // 1. Managed Server Mode: Single proxy adapter with public alias 'xkang-managed'
      // The real model is hidden from local users and controlled centrally by admins on the server.
      this.isServerManaged = true;
      this.currentModel = 'xkang-managed';
      const token = config.token || '';
      this.adapters.set(
        'xkang-managed',
        new ServerProxyAdapter(config.serverUrl, token, 'xkang-managed')
      );
    } else {
      // 2. Direct Standalone Mode: Direct SDK calls using local keys
      this.currentModel = config.defaultModel === 'xkang-managed' ? 'deepseek-v4-flash' : config.defaultModel;
      this.adapters.set(
        'deepseek-v4-flash',
        new DeepSeekAdapter(config.deepseekApiKey, config.deepseekBaseUrl, 'deepseek-chat')
      );
      this.adapters.set(
        'gemini-3.7-flash',
        new GeminiAdapter(config.geminiApiKey, 'gemini-2.5-flash')
      );
      this.adapters.set(
        'grok-4.6-medium',
        new GrokAdapter(config.grokApiKey, config.grokBaseUrl, 'grok-4.6-medium')
      );
    }
  }

  get isManaged(): boolean {
    return this.isServerManaged;
  }

  getCurrentModel(): ModelType {
    return this.currentModel;
  }

  switchModel(model: ModelType): void {
    // In managed mode, local users cannot switch models. Admin controls this on the server.
    if (this.isServerManaged) {
      return;
    }
    if (this.adapters.has(model)) {
      this.currentModel = model;
    }
  }

  async streamChat(
    messages: Message[],
    tools: ToolDefinition[],
    onEvent: (event: StreamEvent) => void
  ): Promise<Message> {
    const adapter = this.adapters.get(this.currentModel);
    if (!adapter) {
      throw new Error(`未找到模型 [${this.currentModel}] 的适配器`);
    }
    return adapter.streamChat(messages, tools, onEvent);
  }
}
