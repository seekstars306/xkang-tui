import { randomUUID } from 'node:crypto';
import { clampToolResult, compactMessages, DuplicateCallTracker, hasIncompleteToolResult, isDbChannelFailure, isFailedToolResult, isReminderMessage, messageText, wrapReminder } from './context.js';
import { ToolCallProtocolError } from './tool_call_error.js';
import type { HarnessContext, Message, MessageContentPart, ModelType, RemoteSkill, StreamEvent, TokenUsage, ToolCall, ToolDefinition } from './types.js';

export interface ChatGateway {
  getCurrentModel(): ModelType;
  switchModel(model: ModelType): void;
  streamChat(messages: Message[], tools: ToolDefinition[], emit: (event: StreamEvent) => void, options?: { signal?: AbortSignal }): Promise<Message>;
}
export interface Registry {
  getTools(): ToolDefinition[];
  getTool(name: string): ToolDefinition | undefined;
  getRemoteSkills(): RemoteSkill[];
  registerLocal(tool: ToolDefinition): void;
  executeTool(name: string, args: Record<string, unknown>, context: HarnessContext): Promise<unknown>;
}
export interface ReviewDecision {
  accepted: boolean;
  text: string;
  retry?: boolean;
  feedback?: string;
  record?: unknown;
}
export interface AgentOptions {
  gateway: ChatGateway;
  registry: Registry;
  context: HarnessContext;
  buildPrompt: (tools: ToolDefinition[], skills: RemoteSkill[], input?: Message) => string;
  prepareInput?: (input: string | MessageContentPart[]) => Message;
  review?: (candidate: Message, history: Message[], attempt: number) => Promise<ReviewDecision>;
  repairTools?: ReadonlySet<string>;
  checkpoint?: (messages: Message[]) => void;
}

const INVESTIGATIONS = new Set(['lookup_order', 'company_db_query', 'search_logs', 'list_log_apps', 'search_code', 'read_file_lines', 'codegraph_explore', 'git_inspect']);
const FALLBACK = '目前尚未得出可靠结论，请稍后重试或由二线人员继续核实。';

/** Host-independent loop. Complete history is the source of truth; compaction is a request projection. */
export class AgentCore {
  protected gateway: ChatGateway;
  protected registry: Registry;
  protected context: HarnessContext;
  private messages: Message[] = [];
  private running = false;
  private usage: TokenUsage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  constructor(private options: AgentOptions) {
    this.gateway = options.gateway;
    this.registry = options.registry;
    this.context = options.context;
    this.registry.registerLocal({ name: 'read_tool_result', description: '按 evidenceId 或调用 ID 分页恢复本会话已经返回的工具原文，不能补齐源查询未返回的数据。',
      parameters: { type: 'object', properties: { evidenceId: { type: 'string' }, toolCallId: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } } },
      execute: async args => {
        const found = this.messages.filter(m => !m.imported && m.role === 'tool' && (args.evidenceId ? m.evidence?.id === args.evidenceId : m.tool_call_id === args.toolCallId));
        if (found.length !== 1) return { status: 'error', message: found.length ? '调用 ID 有歧义，请使用 evidenceId。' : '本会话没有保留该调用的结果，请重新执行原查询。' };
        const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 8000);
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) return { status: 'error', message: 'offset 必须为非负整数，limit 必须为正整数。' };
        const raw = found[0].raw_tool_result ?? messageText(found[0]);
        const content = raw.slice(offset, offset + Math.min(limit, 8000));
        return { status: 'success', evidenceId: found[0].evidence?.id, offset, nextOffset: offset + content.length, totalChars: raw.length, complete: offset + content.length >= raw.length, content };
      } });
    this.refreshSystemPrompt();
  }
  getCurrentModel() { return this.gateway.getCurrentModel(); }
  switchModel(model: ModelType) { this.gateway.switchModel(model); this.refreshSystemPrompt(); }
  getMessages() { return this.messages; }
  getRegistry() { return this.registry; }
  getTokenUsage() { return this.usage; }
  restoreMessages(messages: Message[]) { if (messages.length) this.messages = messages; }
  clearHistory() { this.messages = []; this.usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 }; this.refreshSystemPrompt(); }
  refreshSystemPrompt() {
    const input = [...this.messages].reverse().find(m => m.role === 'user' && !isReminderMessage(m));
    const message: Message = { role: 'system', content: this.options.buildPrompt(this.registry.getTools(), this.registry.getRemoteSkills(), input) };
    if (this.messages[0]?.role === 'system') this.messages[0] = message;
    else this.messages.unshift(message);
  }
  private checkpoint() { this.options.checkpoint?.(this.messages); }
  private remind(text: string) { this.messages.push(wrapReminder(text)); }
  private async call(tools: ToolDefinition[], emit: (event: StreamEvent) => void): Promise<Message> {
    const projected = compactMessages(this.messages.filter(m => !m.internal)).messages.map(m => {
      if (m.role !== 'tool' || !m.evidence) return m;
      return { ...m, content: `${messageText(m)}\n[证据编号: ${m.evidence.id}]` };
    });
    return this.gateway.streamChat(projected, tools, event => {
      if (event.type === 'usage_sync') {
        this.usage.promptTokens = event.promptTokens;
        this.usage.completionTokens += event.completionTokens;
        this.usage.reasoningTokens += event.reasoningTokens || 0;
        this.usage.totalTokens = this.usage.promptTokens + this.usage.completionTokens;
        emit(event);
      }
      // Text and reasoning remain private until the one final publish operation.
      if (event.type === 'tool_call_start') emit(event);
    });
  }
  private result(call: ToolCall, text: string, turnId: string, emit: (event: StreamEvent) => void, notExecuted = false) {
    const failed = isFailedToolResult(text);
    let completeness: 'complete' | 'incomplete' | 'unknown' = 'unknown';
    try { const value = JSON.parse(text); if (value.complete === true) completeness = 'complete'; if (value.complete === false || value.truncated === true) completeness = 'incomplete'; } catch { /* text tools may not declare completeness */ }
    const visible = clampToolResult(text, undefined, call.id);
    let args: Record<string, unknown> = {};
    try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; } catch { /* failed parameter parsing */ }
    const message: Message = { role: 'tool', name: call.name, tool_call_id: call.id, turnId, content: visible,
      ...(visible !== text ? { raw_tool_result: text } : {}),
      evidence: { id: `e_${randomUUID()}`, observedAt: new Date().toISOString(), arguments: args,
        outcome: notExecuted ? 'not_executed' : failed ? 'failed' : 'success', completeness } };
    this.messages.push(message);
    this.checkpoint();
    emit({ type: 'tool_call_result', toolCallId: call.id, result: visible, isError: failed || notExecuted });
  }
  async run(input: string | MessageContentPart[], emit: (event: StreamEvent) => void): Promise<string> {
    if (this.running) throw new Error('当前会话正在处理中');
    this.running = true;
    const turnId = `t_${randomUUID()}`;
    this.messages.push({ ...(this.options.prepareInput?.(input) || { role: 'user' as const, content: input }), turnId });
    this.refreshSystemPrompt();
    this.checkpoint();
    let turns = 0, protocols = 0, empty = 0, reviewCount = 0, actionRetries = 0;
    let repairRemaining: number | null = null, summaryUsed = false, evidenceRetried = false, completenessRetried = false, dbHinted = false;
    let lastDecision: ReviewDecision | undefined;
    const duplicates = new DuplicateCallTracker();
    const finish = (text: string, record?: unknown) => {
      const message: Message = { role: 'assistant', content: text, turnId, ...(record ? { review: record } : {}) };
      this.messages.push(message); this.checkpoint();
      emit({ type: 'content_chunk', chunk: text }); emit({ type: 'done', finalMessage: message });
      return text;
    };
    try {
      while (true) {
        const mustSummarize = turns >= 50 || repairRemaining === 0;
        if (mustSummarize && summaryUsed) return finish(lastDecision?.text || FALLBACK, lastDecision?.record);
        if (mustSummarize) { summaryUsed = true; this.remind('工具调用次数已经用完，立即基于已有证据完成回答；没有证据的部分明确无法确定，不再调用工具。'); }
        let tools = mustSummarize ? [] : this.registry.getTools();
        if (repairRemaining !== null && this.options.repairTools) tools = tools.filter(t => this.options.repairTools!.has(t.name));
        let candidate: Message;
        try {
          if (!mustSummarize) { turns++; if (repairRemaining !== null) repairRemaining--; }
          candidate = await this.call(tools, emit);
          if (candidate.finishReason && !['stop', 'tool_calls', 'function_call'].includes(candidate.finishReason)) throw new ToolCallProtocolError('Incomplete answer');
        } catch (error) {
          this.messages.push({ role: 'assistant', internal: true, turnId, content: `[模型请求失败] ${error instanceof Error ? error.name + ': ' + error.message : String(error)}` });
          this.checkpoint();
          if (error instanceof ToolCallProtocolError && protocols++ < 1 && !mustSummarize) continue;
          emit({ type: 'error', error: '模型服务暂时未完成本次请求，请稍后重试。' });
          return finish(lastDecision?.text || FALLBACK, lastDecision?.record);
        }
        candidate.turnId = turnId;
        if (candidate.tool_calls?.length) {
          this.messages.push(candidate);
          for (const call of candidate.tool_calls) {
            const tool = tools.find(t => t.name === call.name);
            if (!tool) { this.result(call, `错误: 当前通道未加载工具 "${call.name}"。`, turnId, emit, true); continue; }
            try {
              const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
              if (tool.requiresApproval) {
                const info = await tool.getApprovalInfo?.(args, this.context) || { filePath: '', summary: tool.description };
                const approved = await new Promise<boolean>(resolve => emit({ type: 'approval_requested', request: { id: `a_${randomUUID()}`, toolName: tool.name, description: tool.description, ...info }, resolve }));
                if (!approved) { this.result(call, '[操作未执行：员工拒绝了本次请求]', turnId, emit, true); continue; }
              }
              if (call.name === 'ask_user_question') {
                const answer = await new Promise<string>(resolve => emit({ type: 'question_requested', request: { id: `q_${randomUUID()}`, questions: Array.isArray(args.questions) ? args.questions : [] }, resolve }));
                this.result(call, answer, turnId, emit); continue;
              }
              let timer: ReturnType<typeof setTimeout> | undefined;
              const result = await Promise.race([this.registry.executeTool(call.name, args, this.context), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('工具等待超时，执行结果未确认')), 20000); })]).finally(() => clearTimeout(timer));
              let text = typeof result === 'string' ? result : JSON.stringify(result) ?? '';
              if (duplicates.check(call.name, args)) text = `【重复调用提示】与已读取的内容重复，请推进排查或收尾。\n${text}`;
              this.result(call, text, turnId, emit);
            } catch (error) { this.result(call, `工具执行失败: ${error instanceof Error ? error.message : String(error)}`, turnId, emit); }
          }
          if (turns === 30) this.remind('已经连续进行了 30 轮工具调用，请开始收敛，仅补充关键证据，避免重复读取。');
          if (turns === 45) this.remind('工具调用次数即将用完（只剩 5 轮），请整理证据和待确认事项。');
          if (!dbHinted && this.messages.filter(m => m.turnId === turnId && m.name === 'company_db_query').slice(-4).filter(m => isDbChannelFailure(messageText(m))).length >= 3) {
            dbHinted = true; this.remind('数据库通道近期连续超时/断连，请改用索引条件、更窄的范围或其他取证方式，避免同形态重试。');
          }
          continue;
        }
        const text = messageText(candidate).trim();
        if (!text) {
          this.messages.push({ ...candidate, internal: true });
          if (empty++ < 2 && !mustSummarize) { this.remind('你上一轮没有输出任何内容。基于证据给出正文；没查到或查询失败的部分如实说明。'); continue; }
          return finish(lastDecision?.text || FALLBACK, lastDecision?.record);
        }
        if (this.options.review) {
          emit({ type: 'review_status', attempt: ++reviewCount });
          try { lastDecision = await this.options.review(candidate, this.messages, reviewCount); }
          catch {
            this.messages.push({ ...candidate, internal: true });
            return finish(lastDecision?.text || FALLBACK, { status: 'unavailable' });
          }
          this.messages.push({ ...candidate, internal: true, review: lastDecision.record });
          this.checkpoint();
          if (lastDecision.accepted || !lastDecision.retry || reviewCount >= 2) return finish(lastDecision.text, lastDecision.record);
          repairRemaining = Math.min(3, Math.max(0, 50 - turns)); summaryUsed = false;
          this.remind(`以下是复核发现的问题，请只补查必要的只读证据后修订一次：\n${lastDecision.feedback || ''}\n待修订草稿：\n${text}`);
          continue;
        }
        const results = this.messages.filter(m => m.turnId === turnId && m.role === 'tool');
        if (/我已(?:经)?(?:为你|为您)?(?:执行|运行|修改|写入)|已成功执行(?:命令|工具)/.test(text) && !results.some(m => ['run_powershell', 'write_file', 'edit_file'].includes(m.name || '') && m.evidence?.outcome === 'success')) {
          this.messages.push({ ...candidate, internal: true });
          if (actionRetries++ < 2 && !mustSummarize) { this.remind('本轮没有对应的成功执行记录，不能声称操作已执行。请真实调用相应工具，或说明尚未执行。'); continue; }
          return finish('本次没有取得对应的成功执行记录，操作结果尚未确认。');
        }
        const investigations = results.filter(m => INVESTIGATIONS.has(m.name || ''));
        if (investigations.length && investigations.every(m => m.evidence?.outcome !== 'success') && !/无法|失败|未查到|证据不足|待确认|超时/.test(text)) {
          this.messages.push({ ...candidate, internal: true });
          if (!evidenceRetried && !mustSummarize) { evidenceRetried = true; this.remind('查询工具全部失败或超时，不能给出具体业务结论；请明确说明无法确定。'); continue; }
          return finish('查询未成功，目前无法确定原因，需要继续核实。');
        }
        if (!completenessRetried && !mustSummarize && results.some(hasIncompleteToolResult)) {
          completenessRetried = true; this.messages.push({ ...candidate, internal: true });
          this.remind('工具结果不完整，收尾前核对原始问题范围；必要时分页或聚合补查，不要把部分结果当成全部。'); continue;
        }
        return finish(text);
      }
    } finally { this.running = false; }
  }
}
