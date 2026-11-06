import type { ChatGateway, Message, ModelType, StreamEvent, ToolDefinition } from '@xkang/agent-core';

/**
 * 复核网关：优先用独立复核模型，失败/超时立刻降级回原复核模型。
 *
 * 两个要点：
 *  1. 复核只看已经查出来的答案，不看库、不看代码、不落日志，
 *     所以可以用更强但上下文更短的模型——它不需要工具，也不需要长历史。
 *  2. **绝不能因为换了模型就让复核停摆**：独立模型请求失败或超时，
 *     立刻用原模型重跑一遍，行为与本改造之前一致。
 *
 * 缓冲事件的原因：主模型可能已经流出一部分内容后中途失败。
 * 如果直接把事件转发给调用方，降级后会把两份内容拼在一起，复核拿到的是乱码。
 * 所以先缓冲，主模型成功才回放；失败就整段丢弃，再走降级。
 */
export class FallbackReviewGateway implements ChatGateway {
  constructor(
    private readonly primary: ChatGateway | null,
    private readonly fallback: ChatGateway,
    private readonly log: (message: string) => void = () => {},
  ) {}

  getCurrentModel(): ModelType {
    return this.fallback.getCurrentModel();
  }

  switchModel(model: ModelType): void {
    this.fallback.switchModel(model);
  }

  async streamChat(
    messages: Message[],
    tools: ToolDefinition[],
    emit: (event: StreamEvent) => void,
    options?: { signal?: AbortSignal },
  ): Promise<Message> {
    if (!this.primary) return this.fallback.streamChat(messages, tools, emit, options);

    const buffered: StreamEvent[] = [];
    try {
      const result = await this.primary.streamChat(messages, tools, event => buffered.push(event), options);
      for (const event of buffered) emit(event);
      return result;
    } catch (error) {
      // 一律降级。
      //
      // 之前这里判断"signal 已中止就当作主动取消、不降级"，结果把
      // **复核自身的截止时间**也当成了取消，独立复核模型一超时就整轮判 unavailable。
      // 真正的运行级取消（预算用尽）传下来的是同一个 signal，降级那次会立刻失败、
      // 代价可以忽略，所以这里不需要区分。
      this.log(`L3 复核失败，降级 L2：${error instanceof Error ? error.message : String(error)}`);

      // 把主模型**已经产出的内容**交给兜底模型接着做。
      // 超时前跑掉的那部分分析是有价值的，整段丢弃等于白跑一次。
      const partial = buffered
        .map(event => (event.type === 'content_chunk' ? String(event.chunk ?? '') : ''))
        .join('')
        .trim()
        .slice(0, 6000);
      const handoff: Message[] = partial
        ? [
            ...messages,
            { role: 'assistant', content: partial },
            {
              role: 'user',
              content: '上一次复核因超时被截断，以上是它已经完成的分析内容。'
                + '请在此基础上补齐并直接输出最终 JSON 结果，不要重复已经确认的部分。',
            },
          ]
        : messages;

      // 不能把已经中止的 signal 传给兜底模型：主模型是"被截止时间中止"才失败的，
      // 那个 signal 此时已经死了，兜底调用会立刻抛同一个中止错误（线上已验证）。
      const fallbackOptions = options?.signal?.aborted ? undefined : options;
      return this.fallback.streamChat(handoff, tools, emit, fallbackOptions);
    }
  }
}
