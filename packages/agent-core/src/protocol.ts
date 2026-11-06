import { ToolCallProtocolError } from './tool_call_error.js';
import type { Message, StreamEvent, ToolCall } from './types.js';

export function formatModelMessages(messages: Message[]): any[] {
  return messages.map(m => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
    if (m.role === 'assistant') return { role: 'assistant', content: m.content || null,
      ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments) }, ...(c.extra_content ? { extra_content: c.extra_content } : {}) })) } : {}) };
    return { role: m.role, content: m.content };
  });
}

/** No tool becomes executable until the complete streamed batch has passed validation. */
export async function collectChatStream(stream: AsyncIterable<any>, emit: (event: StreamEvent) => void): Promise<Message> {
  let content = '';
  let reasoning = '';
  let finishReason: string | undefined;
  const calls = new Map<number, { id: string; name: string; arguments: string; extra_content?: Record<string, unknown> }>();
  for await (const chunk of stream) {
    if (chunk.error) throw new Error(chunk.error.message || 'Upstream error');
    if (chunk.usage) emit({ type: 'usage_sync', promptTokens: chunk.usage.prompt_tokens || 0,
      completionTokens: chunk.usage.completion_tokens || 0, reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens || 0 });
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.content) { content += delta.content; emit({ type: 'content_chunk', chunk: delta.content }); }
    if (delta.reasoning_content) { reasoning += delta.reasoning_content; emit({ type: 'reasoning_chunk', chunk: delta.reasoning_content }); }
    for (const tc of delta.tool_calls || []) {
      if (!Number.isInteger(tc.index) || tc.index < 0) throw new ToolCallProtocolError('Invalid tool index');
      const call = calls.get(tc.index) || { id: '', name: '', arguments: '' };
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) {
        const name = tc.function.name;
        if (!call.name || name.startsWith(call.name)) call.name = name;
        else if (!call.name.includes(name)) call.name += name;
      }
      call.arguments += tc.function?.arguments || '';
      if (tc.extra_content) call.extra_content = { ...call.extra_content, ...tc.extra_content };
      calls.set(tc.index, call);
    }
  }
  if (!finishReason || !['stop', 'tool_calls', 'function_call'].includes(finishReason)) {
    throw new ToolCallProtocolError('Model output was truncated or refused');
  }
  const ids = new Set<string>();
  const toolCalls: ToolCall[] = [];
  for (const [, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
    if (!call.id || !call.name.trim() || ids.has(call.id)) throw new ToolCallProtocolError('Invalid tool name or ID');
    ids.add(call.id);
    let args: unknown;
    try { args = JSON.parse(call.arguments || '{}'); } catch { throw new ToolCallProtocolError('Incomplete tool arguments'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolCallProtocolError('Tool arguments must be an object');
    toolCalls.push({ id: call.id, name: call.name, arguments: args as Record<string, unknown>, ...(call.extra_content ? { extra_content: call.extra_content } : {}) });
  }
  for (const toolCall of toolCalls) emit({ type: 'tool_call_start', toolCall });
  return { role: 'assistant', content, reasoning_content: reasoning || undefined, finishReason, tool_calls: toolCalls.length ? toolCalls : undefined };
}
