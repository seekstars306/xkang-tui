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
/**
 * 首次调用模型之前预置的一条工具结果（见 AgentOptions.seedToolResults）。
 * name 必须是注册表里存在的工具：历史里的 assistant tool_calls 只能引用真实存在、模型之后也能自己调用的工具。
 */
export interface SeedToolResult {
  name: string;
  arguments: Record<string, unknown>;
  text: string;
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
  /** 可返回 Promise：允许调用方在首条消息上附加异步取得的前置信息（如输入预判），失败时返回原样消息即可 */
  prepareInput?: (input: string | MessageContentPart[]) => Message | Promise<Message>;
  review?: (candidate: Message, history: Message[], attempt: number) => Promise<ReviewDecision>;
  /**
   * 复核没有通过就收尾时改为发布"最后一稿草稿"（服务端 REVIEW_MODE=advisory 传入，见 server/src/agent/review_mode.ts）。
   * 凡是复核没有通过、经 publish 收尾的出口（修订次数用完、复核服务不可用、复核或整轮超时/冻结、修订期间模型异常或空回复）
   * 都先把最后一次送去复核的候选与它的复核结论（复核没有返回结论时为 undefined）交给它：
   * 返回非空文本就原样发布；返回 undefined 或抛错时退回原有的择优发布。
   * 复核通过时不调用（仍发布复核给出的文本）。未传时行为与引入前逐字节一致。
   */
  publishLastDraft?: (draft: Message, decision: ReviewDecision | undefined) => string | undefined;
  repairTools?: ReadonlySet<string>;
  checkpoint?: (messages: Message[]) => void;
  /** 公开回合 ID（服务端 traceId）；传入后 core 产生的消息 turnId 与公开 turn.id 天然一致 */
  turnId?: string;
  /** 动作（需审批的写操作）工具名集合；未传时从注册表派生（requiresApproval === true）。语义与原硬编码集合一致 */
  actionTools?: ReadonlySet<string>;
  /** 单次工具执行超时（毫秒），供测试注入；默认 20000，不改变现有行为 */
  toolTimeoutMs?: number;
  /** R2 活跃预算：传入即启用（服务端按 features.timeBudget 决定是否下发）；本地 --local 不传则行为完全不变 */
  budget?: RunBudget;
  /** 续查时恢复上次的运行状态（extensions 已 +1、轮次与复核次数延续） */
  initialRunState?: Partial<RunState>;
  /** 运行状态变化通知（服务端据此持久化 run_state / frozen_answer） */
  onStateChange?: (state: RunState) => void;
  /**
   * 预置工具结果：让不是工具产出的材料（如用户截图里的文字）也拥有真实的证据编号，可被复核引用。
   * run() 在压入本轮用户消息之后、第一次调用模型之前调用；有结果时先压一条 assistant tool_calls，
   * 再逐条走与真实工具调用相同的 result() 路径写入工具结果（evidence 编号、完整性、裁剪都一致）。
   * 只接受注册表里存在的工具名。钩子抛错、超时或返回空时静默当作没有，绝不让本轮排查因此失败；
   * 未传时行为与引入前完全一致。
   */
  seedToolResults?: (input: string | MessageContentPart[], options: { signal: AbortSignal }) => Promise<SeedToolResult[]>;
  /** seedToolResults 的总时限（毫秒），默认 60000；到时中止钩子并当作没有结果 */
  seedTimeoutMs?: number;
  /** 请求投影的压缩阈值（估算 token）；缺省为 COMPACTION_TOKEN_THRESHOLD（140000），行为与引入前一致 */
  contextTokens?: number;
}

/** R2 运行预算参数 */
export interface RunBudget {
  /** 本次活跃窗口（毫秒）；首轮 15 分钟，每次人工追加后重置为 15 分钟（server/src/agent/continue_budget.ts） */
  activeMs?: number;
  /** 已追加次数（每次人工触发 +1） */
  extensions?: number;
  /** 每次追加获得的工具轮数（已不再用于限制调用量，保留仅为兼容旧调用方） */
  turnsPerExtension?: number;
  /**
   * 工具轮数上限。**不配置时不设上限：服务端只按 activeMs 限时。**
   * 轮数和"能查到多少"不成比例：这个系统里一次查询常常要翻十几轮日志、
   * 结果被返回上限截断还得接着取，撞上轮数上限时往往证据刚取到一半。
   */
  maxTurns?: number;
  /** 距截止时间不足该毫秒数时强制收尾（默认 180000）；只在传了有限 activeMs 时生效 */
  wrapUpMs?: number;
  /** 每次追加获得的复核次数 */
  reviewsPerExtension?: number;
  /** 复核打回后每次获得的独立只读补查轮数（不吃 50 轮残值）；未配置时沿用原有残值公式 */
  repairTurnsPerReview?: number;
}

/** R2 运行状态（可持久化、可恢复） */
export interface RunState {
  turns: number;
  reviewAttempts: number;
  extensions: number;
  turnsAllowed: number;
  reviewAttemptsAllowed: number;
  activeMs: number;
  startedAt: number;
  frozen: boolean;
  abortedByDeadline: boolean;
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
    const projected = compactMessages(this.messages.filter(m => !m.internal), this.options.contextTokens).messages.map(m => {
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
  /** 写入预置工具结果（见 AgentOptions.seedToolResults）；任何失败都按"没有预置结果"处理 */
  private async applySeedToolResults(input: string | MessageContentPart[], turnId: string, emit: (event: StreamEvent) => void, duplicates: DuplicateCallTracker) {
    const hook = this.options.seedToolResults;
    if (!hook) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let items: unknown;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('预置工具结果超时')); }, this.options.seedTimeoutMs ?? 60000);
      });
      items = await Promise.race([Promise.resolve().then(() => hook(input, { signal: controller.signal })), deadline]);
    } catch { return; } finally { clearTimeout(timer); }
    if (!Array.isArray(items)) return;
    const seeds = (items as SeedToolResult[]).filter(item => item && typeof item.name === 'string' && typeof item.text === 'string' && this.registry.getTool(item.name));
    if (!seeds.length) return;
    const calls: ToolCall[] = seeds.map(item => ({ id: `call_${randomUUID().replaceAll('-', '').slice(0, 24)}`, name: item.name,
      arguments: item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments) ? { ...item.arguments } : {} }));
    this.messages.push({ role: 'assistant', content: '', tool_calls: calls, turnId });
    for (const call of calls) emit({ type: 'tool_call_start', toolCall: call });
    seeds.forEach((item, i) => {
      // 记入重复调用识别：模型之后用同样参数再读一次时，与普通工具一样标注为重复读取
      duplicates.check(calls[i].name, calls[i].arguments as Record<string, unknown>);
      this.result(calls[i], item.text, turnId, emit);
    });
  }
  async run(input: string | MessageContentPart[], emit: (event: StreamEvent) => void): Promise<string> {
    if (this.running) throw new Error('当前会话正在处理中');
    this.running = true;
    const turnId = this.options.turnId || `t_${randomUUID()}`;
    // prepareInput 允许异步：调用方可能要先取一次输入预判再拼首条消息。
    // 未传或抛错时退回原样的用户消息，保证这条链路不会因为附加信息而中断。
    const prepared = this.options.prepareInput
      ? await Promise.resolve(this.options.prepareInput(input)).catch(() => undefined)
      : undefined;
    this.messages.push({ ...(prepared || { role: 'user' as const, content: input }), turnId });
    this.refreshSystemPrompt();
    this.checkpoint();
    let protocols = 0, empty = 0, actionRetries = 0;
    let repairRemaining: number | null = null, summaryUsed = false, evidenceRetried = false, completenessRetried = false, dbHinted = false;
    // 时间维度的两个收敛信号（只在传了运行预算时使用）
    let elapsedHinted = false, tailHinted = false;
    // 复核服务连续不可用的次数；它与"结论被打回"是两回事，不能无限重试
    let reviewUnavailableCount = 0;
    let lastDecision: ReviewDecision | undefined;
    // 交付择优：复核可能把草稿改差，也可能再次复核时超时/异常，此时保留已核实内容最多的那一次
    let bestDecision: ReviewDecision | undefined;
    // 最后一次送去复核的候选与它的复核结论（复核没有返回结论时为 undefined）：只供 publishLastDraft 使用
    let lastDraft: Message | undefined;
    let lastDraftDecision: ReviewDecision | undefined;
    const duplicates = new DuplicateCallTracker();
    // 动作工具集合：显式传入优先，否则取注册表里需审批的工具（本地写工具 requiresApproval=true，服务端只读通道为空）
    const actionTools = this.options.actionTools ?? new Set(this.registry.getTools().filter(t => t.requiresApproval).map(t => t.name));
    // R2 运行状态与预算：未传 budget 时计数与无冻结行为同基线（本地 --local 模式完全不变）
    const budget = this.options.budget;
    const initialExtensions = this.options.initialRunState?.extensions ?? budget?.extensions ?? 0;
    const state: RunState = {
      turns: this.options.initialRunState?.turns ?? 0,
      reviewAttempts: this.options.initialRunState?.reviewAttempts ?? 0,
      extensions: initialExtensions,
      // 传了运行预算（服务端/飞书链路）就只按时间限：轮数不再是上限。
      // 没有预算的本地链路保持原来 50 轮，行为与基线一致。
      turnsAllowed: budget?.maxTurns ?? (budget ? Number.MAX_SAFE_INTEGER : 50),
      reviewAttemptsAllowed: Math.min(10, 2 + (budget?.reviewsPerExtension ?? 1) * initialExtensions),
      activeMs: budget?.activeMs ?? Number.POSITIVE_INFINITY,
      startedAt: Date.now(),
      frozen: false,
      abortedByDeadline: false,
    };
    const notify = () => this.options.onStateChange?.({ ...state });
    const finish = (text: string, record?: unknown) => {
      const message: Message = { role: 'assistant', content: text, turnId, ...(record ? { review: record } : {}) };
      this.messages.push(message); this.checkpoint();
      emit({ type: 'content_chunk', chunk: text }); emit({ type: 'done', finalMessage: message });
      return text;
    };
    // 通过复核的一律优先；否则比较「通过核实的语句数」。两者都没有时回退到传入的兜底文案与记录。
    const scoreOf = (d?: ReviewDecision) => (d?.accepted ? Number.MAX_SAFE_INTEGER : Number((d?.record as { validUnitCount?: number } | undefined)?.validUnitCount || 0));
    const publish = (fallbackText: string, fallbackRecord?: unknown) => {
      // REVIEW_MODE=advisory：发布最后一稿草稿的完整内容；拼不出来（草稿不是业务答案、未过发布校验等）时仍按下面的择优发布
      if (lastDraft && this.options.publishLastDraft) {
        let draftText: string | undefined;
        try { draftText = this.options.publishLastDraft(lastDraft, lastDraftDecision); } catch { draftText = undefined; }
        if (draftText) return finish(draftText, lastDraftDecision?.record ?? fallbackRecord);
      }
      // 相等时取更新的后一次：同样多已核实断言时，修订稿吸收了复核反馈，比初稿更可取
      const best = scoreOf(lastDecision) >= scoreOf(bestDecision) ? lastDecision : bestDecision;
      return finish(best?.text || fallbackText, best?.record ?? fallbackRecord);
    };
    try {
      // 预置工具结果（如截图文字转写）：用户消息之后、第一次调用模型之前写入；失败只当作没有
      if (this.options.seedToolResults) {
        try { await this.applySeedToolResults(input, turnId, emit, duplicates); } catch { /* 预置失败不影响本轮排查 */ }
      }
      while (true) {
        // R2 安全点：活跃窗口用尽 → 冻结收尾并保留已核实内容（未传 budget 时永不触发）
        if (budget && Date.now() - state.startedAt >= state.activeMs) {
          state.frozen = true;
          notify();
          return publish(FALLBACK);
        }
        // 复核打回后若配置了独立补查额度，则不算"必须总结"，仍可用只读补查工具
        const repairQuota = repairRemaining !== null && repairRemaining > 0;
        // 时间快到时先强制收尾，而不是等冻结把工具循环硬切断。
        // 硬切断时手里往往还没有可发布的答案，上一轮实测就是这样在 15 分钟被切断：
        // 已经查到 11 条通过核实的断言，但模型没机会把它们写成结论。
        const remaining = budget ? state.activeMs - (Date.now() - state.startedAt) : Number.POSITIVE_INFINITY;
        const wrapUp = Boolean(budget) && remaining <= (budget!.wrapUpMs ?? 180000);
        const mustSummarize = !repairQuota && (state.turns >= state.turnsAllowed || repairRemaining === 0 || wrapUp);
        if (mustSummarize && summaryUsed) return publish(FALLBACK);
        if (mustSummarize) {
          summaryUsed = true;
          this.remind(wrapUp
            ? '本轮可用时间即将用尽，立即基于已有证据完成回答；没有证据的部分明确无法确定，不再调用工具。'
            : '工具调用次数已经用完，立即基于已有证据完成回答；没有证据的部分明确无法确定，不再调用工具。');
        }
        let tools = mustSummarize ? [] : this.registry.getTools();
        if (repairRemaining !== null && this.options.repairTools) tools = tools.filter(t => this.options.repairTools!.has(t.name));
        let candidate: Message;
        try {
          if (!mustSummarize) { state.turns++; if (repairRemaining !== null) repairRemaining--; }
          candidate = await this.call(tools, emit);
          if (candidate.finishReason && !['stop', 'tool_calls', 'function_call'].includes(candidate.finishReason)) throw new ToolCallProtocolError('Incomplete answer');
        } catch (error) {
          this.messages.push({ role: 'assistant', internal: true, turnId, content: `[模型请求失败] ${error instanceof Error ? error.name + ': ' + error.message : String(error)}` });
          this.checkpoint();
          if (error instanceof ToolCallProtocolError && protocols++ < 1 && !mustSummarize) continue;
          emit({ type: 'error', error: '模型服务暂时未完成本次请求，请稍后重试。' });
          return publish(FALLBACK);
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
              // 超时只 reject 一个带标记的错误：结果未确认，既不当执行过也不当执行失败推断
              const timeoutError = new Error('工具等待超时，执行结果未确认');
              (timeoutError as Error & { notExecuted?: boolean }).notExecuted = true;
              const result = await Promise.race([this.registry.executeTool(call.name, args, this.context), new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError), this.options.toolTimeoutMs ?? 20000); })]).finally(() => clearTimeout(timer));
              let text = typeof result === 'string' ? result : JSON.stringify(result) ?? '';
              if (duplicates.check(call.name, args)) text = `【重复调用提示】与已读取的内容重复，请推进排查或收尾。\n${text}`;
              this.result(call, text, turnId, emit);
            } catch (error) { this.result(call, `工具执行失败: ${error instanceof Error ? error.message : String(error)}`, turnId, emit, error instanceof Error && (error as Error & { notExecuted?: boolean }).notExecuted === true); }
          }
          // 收敛提示按时间给：轮数上限只在"没传预算"的本地链路里还有意义。
          // 同一条提醒一个信号就够了，所以按累计已过的时间点判断，而不是每轮都算一次。
          if (budget) {
            const elapsedPct = (Date.now() - state.startedAt) / state.activeMs;
            if (!elapsedHinted && elapsedPct >= 0.6) { elapsedHinted = true; this.remind('本轮可用时间已经过半，请开始收敛，仅补充关键证据，避免重复读取。'); }
            if (!tailHinted && elapsedPct >= 0.8) { tailHinted = true; this.remind('本轮可用时间即将用尽，请尽快整理证据与待确认事项。'); }
          } else {
            if (state.turns === Math.floor(state.turnsAllowed * 0.6)) this.remind('已经连续进行了 30 轮工具调用，请开始收敛，仅补充关键证据，避免重复读取。');
            if (state.turns === state.turnsAllowed - 5) this.remind('工具调用次数即将用完（只剩 5 轮），请整理证据和待确认事项。');
          }
          if (!dbHinted && this.messages.filter(m => m.turnId === turnId && m.name === 'company_db_query').slice(-4).filter(m => isDbChannelFailure(messageText(m))).length >= 3) {
            dbHinted = true; this.remind('数据库通道近期连续超时/断连，请改用索引条件、更窄的范围或其他取证方式，避免同形态重试。');
          }
          continue;
        }
        const text = messageText(candidate).trim();
        if (!text) {
          this.messages.push({ ...candidate, internal: true });
          if (empty++ < 2 && (!mustSummarize || repairRemaining !== null)) { summaryUsed = false; this.remind('你上一轮没有输出任何内容。基于证据给出正文；没查到或查询失败的部分如实说明。'); continue; }
          return publish(FALLBACK);
        }
        if (this.options.review) {
          const attemptNo = state.reviewAttempts + 1;
          emit({ type: 'review_status', attempt: attemptNo });
          lastDraft = candidate; lastDraftDecision = undefined;
          // 复核服务不可用（连接失败、超时、内部错误）说明的是管道故障，不是结论有问题：
          //   ① 以前抛错就立刻结束整轮——排查才开始 2 分钟就被一句"未完成复核"打断；
          //   ② 以前这种失败还消耗复核配额，两次偶发失败就把额度用光。
          // 现在：先重试一次；仍然失败就记为 unavailable，不消耗配额，
          // 由上层按"没查完"处理（询问是否继续），而不是把它当成"结论被打回"。
          let reviewError: unknown = null;
          for (let attemptTry = 0; attemptTry < 2; attemptTry++) {
            try {
              lastDecision = await this.options.review(candidate, this.messages, attemptNo);
              reviewError = null;
              break;
            } catch (error) {
              reviewError = error;
              // 被截止时间取消的复核不再重试，直接按 deadline 记账
              if (/deadline/i.test(String(error instanceof Error ? error.message : error))) break;
            }
          }
          if (reviewError || !lastDecision) {
            const isDeadline = /deadline/i.test(String(reviewError instanceof Error ? reviewError.message : reviewError));
            if (isDeadline) state.abortedByDeadline = true;
            notify();
            this.messages.push({ ...candidate, internal: true });
            return publish(FALLBACK, { status: 'unavailable' });
          }
          lastDraftDecision = lastDecision;
          const diag = String((lastDecision?.record as { diagnostic?: string } | undefined)?.diagnostic || '');
          const reviewStatus = String((lastDecision?.record as { status?: string } | undefined)?.status || '');
          if (/deadline/i.test(diag)) {
            state.abortedByDeadline = true;
            notify();
          } else if (reviewStatus === 'unavailable') {
            // 复核服务没跑完：不消耗复核配额，也不把它当成"结论被打回"
            reviewUnavailableCount++;
            notify();
          } else {
            state.reviewAttempts++;
          }
          this.messages.push({ ...candidate, internal: true, review: lastDecision.record });
          this.checkpoint();
          if (scoreOf(lastDecision) > scoreOf(bestDecision)) bestDecision = lastDecision;
          if (lastDecision.accepted) return finish(lastDecision.text, lastDecision.record);
          // 复核持续不可用不能无限重试：问过两次就收尾，由上层提示"是否继续"
          if (reviewUnavailableCount >= 2) return publish(FALLBACK, { status: 'unavailable' });
          if (!lastDecision.retry || state.reviewAttempts >= state.reviewAttemptsAllowed) return publish(FALLBACK);
          repairRemaining = budget?.repairTurnsPerReview !== undefined
            ? Math.min(budget.repairTurnsPerReview, Math.max(0, 200 - state.turns))
            : Math.min(3, Math.max(0, state.turnsAllowed - state.turns));
          summaryUsed = false;
          this.remind(`以下是复核发现的问题，请只补查必要的只读证据后修订一次：\n${lastDecision.feedback || ''}\n待修订草稿：\n${text}`);
          continue;
        }
        const results = this.messages.filter(m => m.turnId === turnId && m.role === 'tool');
        if (/我已(?:经)?(?:为你|为您)?(?:执行|运行|修改|写入)|已成功执行(?:命令|工具)/.test(text) && !results.some(m => actionTools.has(m.name || '') && m.evidence?.outcome === 'success')) {
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
