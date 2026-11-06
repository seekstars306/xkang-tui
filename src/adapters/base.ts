import { Message, StreamEvent, ToolDefinition } from '../types/index.js';

export interface BaseModelAdapter {
  modelType: string;
  streamChat(
    messages: Message[],
    tools: ToolDefinition[],
    onEvent: (event: StreamEvent) => void
  ): Promise<Message>;
}
