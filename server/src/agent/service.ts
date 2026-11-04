import { randomUUID } from 'node:crypto';
import { AgentCore, type AgentOptions, type ChatGateway, type Message, type MessageContentPart, type Registry, type RunState, type StreamEvent, type ToolDefinition } from '@xkang/agent-core';
import { isFailedToolResult, isReminderMessage, messageText, wrapReminder } from '@xkang/agent-core/context';
import type { PublicAnswer, PublicEvent, PublicQuestion, PublicSession } from '@xkang/agent-core/public';
import { buildSystemPrompt } from './investigation_prompt.js';
import { getCompanyServerSkills } from '../skills.js';
import { createCompanyTools } from '../tools/index.js';
import type { ServerConfig } from '../types.js';
import type { AuditLogger } from '../auth.js';
import { ActiveModelManager, MODEL_PROFILES, type ManagedModelId } from '../model_state.js';
import OpenAI from 'openai';
import { BusinessModel } from './model.js';
import { FallbackReviewGateway } from './review_gateway.js';
import { reviewAnswer } from './review.js';
import { jevReviewAnswer } from './review_jev.js';
import { classifyInput, judgeSufficiency, routeContextNotice } from './intent_router.js';
import { checkPublicText, collectPrivateTerms, draftSchema, parsePublicDraft, publicUserText, unavailableAnswer } from './publication.js';
import { applyDataOnlyMode } from './publication.js';
import { reviewMode, type ReviewMode } from './review_mode.js';
import { answerGuide, businessPrompt } from './answer_guide.js';
import { parseDraft, advisoryAnswer, draftFields, formatRetryFeedback } from './draft_publication.js';
import { draftText, idCheck, idCoverageFeedback, missingIds, questionIds } from './id_coverage.js';
import { redactText } from './input_guard.js';
import { beginRunPin, checkRepoDrift, formatDriftLine, hasUnknownInvolvedRepo, involvedRepos, type RunPin } from '../codegraph/version_trust.js';
import { AgentStore } from './store.js';
import { PROJECT_MAP_PROMPT } from './project_map.js';
import { CONTINUE_EXTENSION_MINUTES, continueBudget } from './continue_budget.js';
import { EXPORT_GUIDE, maskClientToolSections } from './tool_scope.js';
import { SEED_TOOL_TIMEOUT_MS, attachmentImages, modelTranscriber, readAttachmentTool, restoreAttachmentTranscripts, transcribeAttachments, type ImageTranscriber } from './attachments.js';

export const BUSINESS_PROMPT = `
读代码时必须检查关键赋值之后的覆盖、完整方法、实际调用点及输入来源。代码只证明机制，不证明本案实际发生。不同金额口径分别查明条件和输入，同一订单也不能混用。名单必须对照原问题的来源与接收范围，完整返回不等于范围正确。查不到不代表不存在。不得编造已通知、已处理等动作。
最终候选只输出一个 JSON 对象：{"answer":{"conclusion":"业务结论","businessData":[{"label":"中文业务字段","value":"完整业务值"}],"evidenceSummary":["通俗的业务依据摘要"],"customerReply":"客服可转述的话术","pendingItems":["待确认事项"]},"evidenceIds":["支撑答案的真实证据编号"]}。evidenceIds 仅用于服务端取证复核，必须引用本会话工具结果标注的真实编号，不得编造；无事实结论时可以为空。
完整姓名、电话、证件、订单和金额是客服必要信息，不掩码，不改写数字，不输出无关客户记录。号码一律字符串。业务规则用通俗话解释；最终公开字段不能出现代码、SQL、库表字段名、方法名、源码目录、内部地址与接口、原始日志或思考过程。内部证据编号仅供你取证，不能放进公开答案。不要输出 Markdown 代码围栏或额外 JSON 字段。
严格对应本轮问题：businessData 只列出回答所需的字段，不能因为查到了更多列就全部输出。用户仅核对基本信息时，不扩展未询问的退款、因果或处理建议。结论只概括一两句，具体数据放在 businessData，客服话术不要再次重复整个资料清单。
每个业务字段表达一个含义，依据摘要的每个条目说明一项依据；不同断言用完整短句分开，保留各自的条件与范围。客服话术仅转述已在正文得到证实的内容，不增加新的时效、费用、法律判断、确定原因或已执行动作。用户未询问且证据未核实的内容直接省略，不能用行业常识补齐成当前系统规则。规则咨询可按题设作条件说明，无须虚构具体订单已查证；实际事件仍需原始业务记录。输出 JSON 前逐句做反证自查：未配置或取默认值 0 的字段不能当作实值；单一渠道、单一分支或单一状态下的规则不能写成通用规则；代码里存在异步调用、定时任务或相关配置只证明机制存在，不代表本单已经执行成功，不得据此断言已通知、已处理、已完成。每条关键事实必须能在所引用的 evidenceIds 原文中找到直接文字依据，找不到的依据不得写入结论，改列为待确认。每条断言自成一句完整短句，不得用逗号把事实与原因写成同一句；原因、机制或责任人类断言（因为、导致、由于某人或某机制、有人连续提交、并发、前端连击、自动任务触发、系统缺少防重等）在本会话证据中没有直接说明该机制的日志、请求来源或代码分支时，不得写成结论，只能写成"成因尚未定位，需进一步排查"，并把要查的方向放进待确认事项；不得用时间间隔、记录条数或经办人、创建人字段反推成因。形成最终候选时直接输出 JSON，第一个字符必须是左花括号，不在前后添加解释。`;

function jsonSchema(value: any): any {
  const def = value._def;
  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault') return jsonSchema(def.innerType);
  const description = value.description;
  if (def.typeName === 'ZodObject') {
    const shape = value.shape;
    return { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([key, child]) => [key, jsonSchema(child)])), required: Object.keys(shape).filter(k => !shape[k].isOptional()), ...(description ? { description } : {}) };
  }
  if (def.typeName === 'ZodArray') return { type: 'array', items: jsonSchema(def.type), description };
  if (def.typeName === 'ZodEnum') return { type: 'string', enum: def.values, description };
  return { type: def.typeName === 'ZodNumber' ? 'number' : def.typeName === 'ZodBoolean' ? 'boolean' : 'string', ...(description ? { description } : {}) };
}

/** 本轮客服问题原文：最后一条非内部、非提醒的用户消息（飞书问题含【本次问题原文】与【客服补充】） */
function currentQuestion(messages: Message[]): string {
  const m = [...messages].reverse().find(x => x.role === 'user' && !x.internal && !isReminderMessage(x));
  return m ? messageText(m) : '';
}

export class BusinessRegistry implements Registry {
  private tools = new Map<string, ToolDefinition>();
  constructor(config: ServerConfig, owner: string, audit: AuditLogger, runPin?: RunPin) {
    // 这张白名单决定模型能看见哪些工具。新增工具必须在这里登记，
// 否则 createCompanyTools 里注册了也不会下发——
// 2026-11-03 导出/表结构工具就是这样被挡住，模型只能回“无法生成 Excel”。
const internalTools = new Set([
  'lookup_order', 'company_db_query', 'search_code', 'read_file_lines', 'git_inspect',
  'codegraph_explore', 'search_logs', 'list_log_apps',
  'db_schema', 'export_file', 'export_xlsx', 'export_query',
]);
    const codeTools = new Set(['search_code', 'read_file_lines', 'git_inspect', 'codegraph_explore']);
    for (const tool of createCompanyTools(config).filter(tool => internalTools.has(tool.name))) this.registerLocal({ name: tool.name, description: tool.description, parameters: jsonSchema(tool.schema), execute: async args => {
      const start = Date.now();
      try {
        let result = await tool.execute(tool.schema.parse(args), config, owner);
        if (runPin && runPin.heads.size > 0 && codeTools.has(tool.name) && config.codeRepoPath) {
          const driftLines: string[] = [];
          for (const repo of involvedRepos([result])) {
            const drift = checkRepoDrift(runPin, repo, config.codeRepoPath);
            if (drift.drifted && drift.from && drift.to) driftLines.push(formatDriftLine(repo, drift.from, drift.to));
          }
          if (driftLines.length) result = `${driftLines.join('\n')}\n${result}`;
        }
        audit.log({ timestamp: new Date().toISOString(), user: owner, type: 'tool_call', toolName: tool.name, durationMs: Date.now() - start, success: !isFailedToolResult(result) });
        return result;
      } catch (error) {
        audit.log({ timestamp: new Date().toISOString(), user: owner, type: 'tool_call', toolName: tool.name, durationMs: Date.now() - start, success: false });
        throw error;
      }
    } });
    this.registerLocal({ name: 'ask_user_question', description: '仅询问工具无法取得的必要业务线索，不能展示代码、SQL或内部技术名称。', parameters: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } } }, required: ['questions'] }, execute: async () => '' });
  }
  registerLocal(tool: ToolDefinition) { this.tools.set(tool.name, tool); }
  getTools() { return [...this.tools.values()]; }
  getTool(name: string) { return this.tools.get(name); }
  getRemoteSkills() { return []; }
  async executeTool(name: string, args: Record<string, unknown>) { return this.tools.get(name)!.execute(args, { repoPath: '', localCwd: '' }); }
}
interface ActiveRun { session: PublicSession; core: AgentCore; listeners: Set<(event: PublicEvent) => void>; answer?: (text: string) => void; controller: AbortController }
/**
 * L3 单次调用的时限。
 *
 * 复核调用把时限作为**每次请求**的 timeout 传给上游，会覆盖 OpenAI 客户端自带的默认值，
 * 所以只配 REVIEW_MODEL_TIMEOUT_MS 是不够的——实测一次 L3 调用跑了 204 秒（配置 120 秒）
 * 仍未被截住，一直等到整轮预算才终止，而那段时间本该早就降级 L2 重跑了。
 * 这里取"复核整体预算"与"L3 自己的预算"的较小值，让降级发生在配置说的那一刻。
 */
export function reviewCallTimeoutMs(answerReviewTimeoutMs: number, reviewModelTimeoutMs?: number): number {
  const limit = reviewModelTimeoutMs && reviewModelTimeoutMs > 0 ? reviewModelTimeoutMs : answerReviewTimeoutMs;
  return Math.max(1000, Math.min(answerReviewTimeoutMs, limit));
}

export class AgentService {
  private runs = new Map<string, ActiveRun>();
  /**
   * 复核器工厂：把两种复核器统一成同一个调用签名，供 AgentCore 的 review 选项直接使用。
   *
   * - 'llm'（默认）：现有 reviewAnswer，用同一套 LLM 做反证与引文核验，行为与引入本工厂前一致。
   * - 'jev'：TypeSafe System One，逐条断言问“证据是否直接支持”，产出同构 ReviewDecision。
   *
   * 只替换“谁判定内容可信”；发布形态、修订反馈通道、机械校验（引文逐字比对等）仍然共用。
   */
  private reviewer() {
    if (this.config.reviewer === 'jev') {
      return (model: unknown, candidate: Message, history: Message[], attempt: number, traceId: string, emit: (e: StreamEvent) => void, opts: { timeoutMs: number; partialPublish?: boolean }) =>
        jevReviewAnswer(candidate, history, attempt, traceId, emit, { timeoutMs: opts.timeoutMs, partialPublish: opts.partialPublish });
    }
    return (model: ChatGateway, candidate: Message, history: Message[], attempt: number, traceId: string, emit: (e: StreamEvent) => void, opts: { timeoutMs: number; partialPublish?: boolean }) =>
      reviewAnswer(model, candidate, history, attempt, traceId, emit, opts);
  }
  /**
   * 复核用的网关（L3）。
   *
   * 分层约定：
   *   L2 = 排查模型，负责查库、读代码、跑日志
   *   L3 = 复核模型，只看 L2 已经查出来的答案，不碰任何工具
   *
   * L3 的强项是逐句挑毛病，所以用更强的模型；代价是慢和不稳定。
   * **L3 出任何问题都立刻降级 L2**——复核绝不能因为换了模型而停摆。
   */
  private reviewGateway(owner: string, signal: AbortSignal, fallback: ChatGateway): ChatGateway {
    const cfg = this.config.reviewModel;
    if (!cfg || this.config.reviewer === 'jev') return fallback;
    // 单次 L3 调用的时限必须由 REVIEW_MODEL_TIMEOUT_MS 决定，而不是复核整体预算。
    // 复核调用把时限作为**每次请求**的 timeout 传下去，会覆盖客户端默认值，
    // 所以不在这里压下来，REVIEW_MODEL_TIMEOUT_MS 就完全不生效——
    // 实测一次 L3 调用跑了 204 秒还没被 120 秒的配置截住，只能等整轮预算来终止，
    // 而这段时间里本该早就降级 L2 重跑了。
    const callTimeoutMs = reviewCallTimeoutMs(this.config.answerReviewTimeoutMs, cfg.timeoutMs);
    const primary = new BusinessModel(
      // 复核用 high：独立复核模型的强项就是逐句挑毛病，降档会放过问题
      { ...this.config, answerReviewTimeoutMs: callTimeoutMs, reviewReasoningEffort: 'high' as const },
      'gemini',
      this.audit,
      owner,
      signal,
      true,
      () => ({
        client: new OpenAI({
          apiKey: cfg.apiKey,
          baseURL: cfg.baseUrl,
          timeout: cfg.timeoutMs ?? 120000,
          maxRetries: 0,
        }),
        targetModel: cfg.model,
      }),
    ).asReviewTier(cfg.model);
    return new FallbackReviewGateway(primary, fallback, message => console.warn('[review-gateway]', message));
  }

  /**
   * 跑一次复核：L3 出任何问题立刻降级 L2。
   *
   * 两种情况都要降级：
   *  ① 调用抛错 —— 由 FallbackReviewGateway 兜住
   *  ② 返回了结果但 status=unavailable（模型回了、复核没跑成）
   * 第二种以前没人管：结果照常返回，core 只看到"复核不可用"，两轮后收尾。
   * 这里补上——只要出现一次 unavailable，马上用原复核模型重跑，不等第二次。
   */
  private async runReview(
    owner: string,
    signal: AbortSignal,
    fallbackModel: ChatGateway,
    candidate: Message,
    history: Message[],
    attempt: number,
    traceId: string,
    emit: (event: StreamEvent) => void,
    opts: { timeoutMs: number; partialPublish?: boolean; maxPromptTokens?: number },
  ) {
    const fallbackReviewer = this.reviewer();
    if (!this.config.reviewModel || this.config.reviewer === 'jev') {
      return fallbackReviewer(fallbackModel, candidate, history, attempt, traceId, emit, opts);
    }
    const gateway = this.reviewGateway(owner, signal, fallbackModel);
    const decision = await fallbackReviewer(gateway, candidate, history, attempt, traceId, emit, opts);
    const record = decision?.record as { status?: string; unstructured?: boolean } | undefined;
    const status = String(record?.status || '');
    // ②' 只回了正文（Markdown 复核报告）：模型回了、但没给结构化结论，与"没跑成"一样要立刻降级
    if (status !== 'unavailable' && !record?.unstructured) return decision;
    console.warn(status === 'unavailable'
      ? '[review-gateway] L3 复核返回不可用，立即降级 L2 重跑'
      : '[review-gateway] L3 复核只回正文，立即降级 L2 重跑');
    return fallbackReviewer(fallbackModel, candidate, history, attempt, traceId, emit, opts);
  }

  /**
   * 按 REVIEW_MODE 接线复核（见 review_mode.ts）。
   *  - gate：只传 review，与引入开关前逐字节一致；
   *  - advisory：同样的 review，另传 publishLastDraft——复核没通过就收尾时发布最后一稿草稿的完整内容并追加复核问题；
   *  - off：不做内容复核，只挂一道"发布格式"检查——草稿过不了发布解析（JSON 写坏、内部标识等）时，把错误原样退回一次，
   *    要求只修格式、不改内容；过了就原样发布草稿。2026-10-29 实测：不挂这一道时，3 次里有 1 次模型把 JSON 写坏
   *    （字符串字段用 "] 收尾），整份答案被兜底作废。不调用复核模型，也不裁剪任何句子。
   */
  private reviewWiring(mode: ReviewMode, review: NonNullable<AgentOptions['review']>, messages: () => Message[], traceId: string, attemptsAllowed = 2): Pick<AgentOptions, 'review' | 'publishLastDraft'> {
    if (mode === 'off') return { review: async (candidate, _history, attemptNo) => {
      const text = messageText(candidate);
      // 问题号码交代检查（ANSWER_ID_CHECK=on，见 id_coverage.ts）：只在后面还有修正机会时退回，最后一稿照常发布
      const canRetry = attemptNo < attemptsAllowed;
      const ids = idCheck() === 'on' ? questionIds(currentQuestion(messages())) : [];
      try {
        const draft = parseDraft(text, collectPrivateTerms(messages()));
        const missing = missingIds(ids, draftText(draft));
        if (missing.length && canRetry) return { accepted: false, retry: true, text, feedback: idCoverageFeedback(missing) };
        return { accepted: true, text };
      } catch (error) {
        const reason = String((error as Error)?.message ?? error).slice(0, 300);
        const missing = missingIds(ids, text);
        return { accepted: false, retry: true, text, feedback: formatRetryFeedback(reason) + (missing.length ? '\n另外：' + idCoverageFeedback(missing) : '') };
      }
    } };
    if (mode === 'gate') return { review };
    return { review, publishLastDraft: (draft, decision) => {
      const answer = advisoryAnswer(messageText(draft), decision, collectPrivateTerms(messages()), traceId);
      return answer ? JSON.stringify(answer) : undefined;
    } };
  }

  constructor(public store: AgentStore, private config: ServerConfig, private audit: AuditLogger, private models: ActiveModelManager,
    private modelFactory?: (owner: string, runSignal: AbortSignal) => ChatGateway, private registryFactory?: (owner: string) => Registry,
    private transcriberFactory?: (owner: string, runSignal: AbortSignal) => ImageTranscriber) {}
  /**
   * 截图转写函数：默认用本轮的调查模型做纯文本调用。
   * jsonMode=false 且调用时不传 options.signal——两者任一都会让 BusinessModel 附加 response_format
   * （MODEL_JSON_FORMAT=json_schema 时还会要求输出答案结构），转写就不再是纯文字了。
   * 超时与整轮取消通过构造参数 runSignal 生效。
   * 注入了模型工厂（测试/评测）却没注入转写函数时不转写：绝不在那种场景里悄悄调用真实模型。
   */
  private imageTranscriber(owner: string, selected: ManagedModelId, runSignal: AbortSignal): ImageTranscriber | undefined {
    if (this.transcriberFactory) return this.transcriberFactory(owner, runSignal);
    if (this.modelFactory) return undefined;
    return modelTranscriber(signal => new BusinessModel(this.config, selected, this.audit, owner, AbortSignal.any([runSignal, signal]), false));
  }
  get(owner: string, id: string): PublicSession | null {
    const loaded = this.store.load(owner, id);
    if (!loaded) return null;
    if (this.runs.has(id)) return this.runs.get(id)!.session;
    // R2：冻结会话（无活动运行但标记 frozen）严禁被擦除为 unavailableAnswer——保留 frozen/extensions/frozenAnswer 供续查
    if (loaded.public.frozen) return loaded.public;
    // A process restart cannot silently resume an old in-flight tool call.
    if (loaded.public.status !== 'idle') {
      loaded.public.status = 'idle'; delete loaded.public.pendingQuestion;
      const turn = loaded.public.turns.at(-1);
      if (turn && !turn.answer) turn.answer = unavailableAnswer(turn.id);
      this.store.save(owner, loaded.public, loaded.messages);
    }
    return loaded.public;
  }
  remove(owner: string, id: string): boolean {
    if (!this.store.load(owner, id)) return false;
    if (this.runs.has(id)) throw new Error('busy');
    return this.store.delete(owner, id);
  }
  answerQuestion(owner: string, id: string, qid: string, text: string): boolean {
    if (!this.store.load(owner, id)) return false;
    const run = this.runs.get(id);
    if (!run?.answer || run.session.pendingQuestion?.id !== qid) return false;
    run.answer(text); return true;
  }
  /** 取消一次进行中的运行：中止在途模型请求，run() 随即收尾为"待人工"答案 */
  abort(owner: string, id: string): boolean {
    if (!this.store.load(owner, id)) return false;
    const run = this.runs.get(id);
    if (!run) return false;
    run.controller.abort();
    return true;
  }
  /**
   * R4：反馈上下文。只取被反馈回合的私有消息（按 turnId 过滤；未传时取最后一轮；传 '__all__' 时取全会话），
   * 内容经输入脱敏后再序列化——不把整会话原文和凭据值带进反馈库。
   */
  feedbackContext(owner: string, id: string, turnId?: string): unknown[] | null {
    const loaded = this.store.load(owner, id);
    if (!loaded) return null;
    const knownTurns = [...new Set(loaded.messages.filter(m => m.turnId).map(m => m.turnId!))];
    const target = turnId === '__all__' ? undefined : (turnId && knownTurns.includes(turnId) ? turnId : knownTurns.at(-1));
    return loaded.messages
      .filter(m => !target || m.turnId === target)
      .map(m => ({ role: m.role, ...(m.name ? { name: m.name } : {}), content: redactText(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).text }));
  }
  start(owner: string, id: string, input: string | MessageContentPart[], listener: (event: PublicEvent) => void): () => void {
    const loaded = this.store.load(owner, id);
    if (!loaded) throw new Error('not_found');
    if (this.runs.has(id)) throw new Error('busy');
    const session = loaded.public;
    const traceId = `r_${randomUUID().replaceAll('-', '')}`;
    const initialTerms = collectPrivateTerms(loaded.messages);
    const turn = { id: traceId, userText: publicUserText(input, initialTerms) };
    // 意图分流（旁路观察）：只在 OBSERVE_INTENT_ROUTER 开启时跑，结果写进 audit，不改变任何路由。
    // 先旁路的原因：L1 当年因分类不准被关掉，直接拿分类结果路由风险太大，需要真实流量验证。
    // 预判结果只作为上下文进入 L2，不直接回给用户：要不要追问、追问什么，由 L2 自己决定。
    // start() 是同步方法，这里只发起不等待；prepareInput 在 core.run 时读取，拿不到就退化为原样消息。
    // 开关关闭时 routePromise 为 undefined，prepareInput 不参与，行为与引入前逐字节一致。
    const routePromise: Promise<string | undefined> | undefined = this.config.observeIntentRouter
      ? (async () => {
          const decision = await classifyInput(turn.userText, { timeoutMs: 15000 }).catch(() => undefined);
          if (!decision) return undefined;
          const suff = decision.route === 'l2_complex'
            ? await judgeSufficiency(turn.userText, { timeoutMs: 15000 }).catch(() => undefined)
            : undefined;
          this.audit.log({ type: 'intent_route', model: 'auto', details: { traceId, text: turn.userText.slice(0, 200), ...decision, sufficiency: suff?.sufficient, suffConfidence: suff?.confidence }, tokensUsed: { prompt: 0, completion: 0 } } as never);
          // 附件（图片等非文本 part）不参与预判，但会改变提示的措辞：带附件时不能断言"没有可定位信息"。
          const hasAttachment = Array.isArray(input) && input.some(part => part.type !== 'text');
          return routeContextNotice(decision, suff, hasAttachment);
        })()
      : undefined;
    session.turns.push(turn); session.status = 'running'; session.lastActiveAt = new Date().toISOString();
    if (session.turns.length === 1) session.title = turn.userText.slice(0, 24);
    const setting = this.models.getActive();
    const selected = setting !== 'auto' && MODEL_PROFILES[setting].promptTier === 'l2' ? setting : 'gemini';
    // 运行级取消信号：整次 run() 可被 abort() 中止（options.signal 仍只表示"这是一次复核调用"）
    const controller = new AbortController();
    const runPin = beginRunPin(this.config.codeRepoPath || '');
    const model = this.modelFactory?.(owner, controller.signal) || new BusinessModel(this.config, selected, this.audit, owner, controller.signal);
    const registry = this.registryFactory?.(owner) || new BusinessRegistry(this.config, owner, this.audit, runPin);
    // 本轮截图：排查开始前逐张转写成文字，作为 read_attachment 的工具结果写进会话，从而拥有可引用的证据编号。
    // 工具先注册再派生补查工具集：历史里的 tool_calls 指向真实存在的只读工具，模型之后也能自己按序号再读。
    const images = attachmentImages(input);
    // 图片本身已经作为 image_url 直接发给主模型（见 context.ts 的 buildContent）。
    // 逐字转写是额外一层：每张图单独跑一次完整模型调用，3 张并发时互相争抢，
    // 单张经常超过 120 秒被丢弃，反而把整轮拖慢好几分钟，还多一个失败点。
    // 2026-11-02 默认关闭；确实需要截图逐字文本时设 ATTACHMENT_TRANSCRIBE=1 打开。
    // 显式注入了 transcriberFactory 就照常转写（测试与依赖注入走这条），
    // 只有生产默认路径受环境开关控制，默认关闭。
    const transcribeEnabled = this.transcriberFactory
      ? true
      : /^(1|true|on|yes)$/i.test(String(process.env.ATTACHMENT_TRANSCRIBE ?? '').trim());
    const transcribe = transcribeEnabled && images.length
      ? this.imageTranscriber(owner, selected, controller.signal)
      : undefined;
    const transcripts = new Map<number, string>();
    if (transcribe) registry.registerLocal(readAttachmentTool(transcripts));
    const repairTools = new Set(registry.getTools().filter(t => t.name !== 'ask_user_question' && !t.requiresApproval).map(t => t.name)); repairTools.add('read_tool_result');
    const publish = (event: PublicEvent) => { for (const callback of run.listeners) { try { callback(event); } catch { run.listeners.delete(callback); } } };
    let core: AgentCore;
    let lastState: RunState | undefined;
    const handle = (event: StreamEvent) => {
      if (event.type === 'tool_call_start') publish({ type: 'progress', phase: 'checking' });
      if (event.type === 'review_status') publish({ type: 'progress', phase: event.attempt === 1 ? 'reviewing' : 'revising' });
      if (event.type === 'question_requested') {
        const terms = collectPrivateTerms(core.getMessages());
        const source = event.request.questions;
        if (!source.length || checkPublicText(JSON.stringify(source), terms).length) { event.resolve('请自行核对已有线索，不要向客服展示内部技术信息。'); return; }
        const question: PublicQuestion = { id: event.request.id, questions: source.map(q => ({ question: q.question, ...(q.options ? { options: q.options.map(o => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })) } : {}) })) };
        session.pendingQuestion = question; session.status = 'waiting_question';
        const timer = setTimeout(() => run.answer?.('客服尚未作答，请依据现有信息说明待确认事项。'), 5 * 60 * 1000);
        run.answer = text => { clearTimeout(timer); delete session.pendingQuestion; session.status = 'running'; run.answer = undefined; this.store.save(owner, session, core.getMessages()); event.resolve(text); };
        this.store.save(owner, session, core.getMessages()); publish({ type: 'question', question });
      }
    };
    // REVIEW_MODE（见 review_mode.ts）：本轮只读一次，复核接线与最终解析用同一个值
    const mode = reviewMode();
    core = new AgentCore({ gateway: model, registry, context: { repoPath: this.config.codeRepoPath || '', localCwd: '' }, ...(this.config.contextTokens ? { contextTokens: this.config.contextTokens } : {}), buildPrompt: (tools, _skills, input) => maskClientToolSections(buildSystemPrompt(tools, getCompanyServerSkills(), 'l2', { hasImages: Array.isArray(input?.content) && input.content.some(part => part.type === 'image_url') })) + '\n\n' + businessPrompt(BUSINESS_PROMPT, answerGuide()) + '\n\n' + PROJECT_MAP_PROMPT + '\n\n' + EXPORT_GUIDE,
      repairTools, checkpoint: messages => this.store.save(owner, session, messages),
      // 截图转写：单张约 30 秒时限、失败跳过该图；整体失败或超时由 core 静默当作没有，不影响本轮排查
      ...(transcribe ? { seedToolResults: (_value: string | MessageContentPart[], { signal }: { signal: AbortSignal }) => transcribeAttachments(images, transcribe, transcripts, { signal }), seedTimeoutMs: SEED_TOOL_TIMEOUT_MS } : {}),
      // 预判结果并入首条用户消息：只进模型上下文，不直接展示给用户。
      // 用 async 读取 routePromise：core.run 在真正发起模型调用前 await 它，
      // 因此 15s 内拿不到预判时不会拖住整轮，只是这条提示缺席。
      ...(routePromise ? { prepareInput: async (value: string | MessageContentPart[]) => {
        const notice = await routePromise.catch(() => undefined);
        if (!notice) return { role: 'user' as const, content: value };
        return {
          role: 'user' as const,
          content: Array.isArray(value)
            ? [...value, { type: 'text' as const, text: '\n\n' + notice }]
            : `${value}\n\n${notice}`,
        };
      } } : {}),
      turnId: traceId, // R4：私有消息的 turnId 与公开回合 ID 一致，反馈可按回合精确取上下文
      // R2：开启 timeBudget 时下发 15 分钟活跃预算；未开启时不传 budget，行为与基线一致
      ...(this.config.features?.timeBudget ? { budget: { activeMs: 15 * 60 * 1000, extensions: 0, reviewsPerExtension: 1, repairTurnsPerReview: 4, wrapUpMs: 180000 }, onStateChange: (state: RunState) => { lastState = state; } } : {}),
      // 复核接线按 REVIEW_MODE：gate 只传 review（与引入开关前一致）；advisory 另传 publishLastDraft；off 都不传
      ...this.reviewWiring(mode, (candidate, history, attempt) => this.runReview(owner, controller.signal, model, candidate, history, attempt, traceId, handle, { timeoutMs: this.config.answerReviewTimeoutMs, partialPublish: Boolean(this.config.features?.partialPublish), ...(this.config.reviewModel ? { maxPromptTokens: this.config.reviewMaxPromptTokens } : {}) }), () => core.getMessages(), traceId) });
    core.restoreMessages(loaded.messages);
    const run: ActiveRun = { session, core, listeners: new Set([listener]), controller };
    this.runs.set(id, run);
    this.store.save(owner, session, loaded.messages);
    publish({ type: 'progress', phase: 'checking' });
    void (async () => {
      let answer = unavailableAnswer(traceId);
      let resultText = '';
      try {
        const result = await core.run(input, handle);
        resultText = result;
        // off：core 不挂复核，返回的是模型草稿原文（包装 / 平铺 / 代码块），按草稿取出五个答案字段；gate/advisory 返回的是带 reviewStatus 的公开答案
        const parsed = mode === 'off' ? { ...draftFields(result), reviewStatus: 'needs_human' } : JSON.parse(result);
        // R1：claims 是可选字段，绝不塞进 .strict() 的 draftSchema——先剥离再校验，通过后拼回
        const { reviewStatus, traceId: ignored, claims, ...draft } = parsed;
        let validated = parsePublicDraft(JSON.stringify(draft), collectPrivateTerms(core.getMessages()));
        // V4 数据核对模式：本次证据涉及 unknown 档位仓库时，只放行数据事实（开关默认关）
        if (this.config.dataOnlyForUnknown) {
          const toolTexts = core.getMessages().filter(m => m.role === 'tool').map(m => String(m.content ?? ''));
          if (hasUnknownInvolvedRepo(toolTexts)) validated = applyDataOnlyMode(validated, true);
        }
        if (['reviewed', 'needs_human', 'unreviewed'].includes(reviewStatus)) answer = { ...validated, reviewStatus, traceId, ...(Array.isArray(claims) ? { claims } : {}) };
      } catch { /* Never include internal exceptions in a public answer. */ }
      finally {
        const terms = collectPrivateTerms(core.getMessages());
        session.turns[session.turns.length - 1] = { ...turn, userText: publicUserText(input, terms), answer };
        // A source discovered during this turn may make an earlier title technically sensitive.
        if (checkPublicText(session.title, terms).length) session.title = '业务排障会话';
        // R2：冻结收尾——持久化运行状态与已核实答案，会话标记 frozen（线缆 status 仍为 idle）
        if (lastState?.frozen) {
          this.store.saveRunState(owner, id, lastState, resultText || null);
          session.frozen = true; session.extensions = lastState.extensions;
          session.activeElapsedMs = lastState.activeMs; session.activeBudgetMs = lastState.activeMs;
        } else {
          delete session.frozen; delete session.extensions; delete session.activeElapsedMs; delete session.activeBudgetMs;
          this.store.clearRunState(owner, id);
        }
        session.status = 'idle'; delete session.pendingQuestion; session.lastActiveAt = new Date().toISOString();
        this.store.save(owner, session, core.getMessages());
        this.runs.delete(id);
        publish({ type: 'answer', turnId: traceId, answer }); publish({ type: 'done' });
      }
    })();
    return () => run.listeners.delete(listener);
  }
  /**
   * R2：续查。对已冻结的会话 extensions += 1、重置为 15 分钟活跃窗口（CONTINUE_EXTENSION_MS），从已保存的消息与运行状态恢复。
   * 重复点击幂等（已在运行或未冻结时返回 false）。
   * supplement：客服随续查一起给的补充（飞书里排查期间排队的【客服补充】）；缺省时与原来一样只注入系统提醒。
   */
  continue(owner: string, id: string, listener: (event: PublicEvent) => void, supplement?: string | MessageContentPart[]): boolean {
    const loaded = this.store.load(owner, id);
    if (!loaded || !loaded.public.frozen) return false;
    if (this.runs.has(id)) return false;
    const saved = this.store.loadRunState(owner, id);
    if (!saved?.runState) return false;
    const session = loaded.public;
    const traceId = session.turns[session.turns.length - 1]?.id;
    if (!traceId) return false;
    const extensions = (saved.runState.extensions ?? 0) + 1;
    const setting = this.models.getActive();
    const selected = setting !== 'auto' && MODEL_PROFILES[setting].promptTier === 'l2' ? setting : 'gemini';
    const controller = new AbortController();
    const runPin = beginRunPin(this.config.codeRepoPath || '');
    const model = this.modelFactory?.(owner, controller.signal) || new BusinessModel(this.config, selected, this.audit, owner, controller.signal);
    const registry = this.registryFactory?.(owner) || new BusinessRegistry(this.config, owner, this.audit, runPin);
    // 续查沿用本轮已写入的截图转写：历史里的 read_attachment 调用仍指向存在的工具，模型也能继续按序号读取
    const transcripts = restoreAttachmentTranscripts(loaded.messages, traceId);
    if (transcripts.size) registry.registerLocal(readAttachmentTool(transcripts));
    const repairTools = new Set(registry.getTools().filter(t => t.name !== 'ask_user_question' && !t.requiresApproval).map(t => t.name)); repairTools.add('read_tool_result');
    session.status = 'running'; session.lastActiveAt = new Date().toISOString();
    delete session.frozen;
    // REVIEW_MODE（见 review_mode.ts）：本次续查只读一次，复核接线与最终解析用同一个值
    const mode = reviewMode();
    const publish = (event: PublicEvent) => { for (const callback of run.listeners) { try { callback(event); } catch { run.listeners.delete(callback); } } };
    let core: AgentCore;
    let lastState: RunState | undefined;
    const handle = (event: StreamEvent) => {
      if (event.type === 'tool_call_start') publish({ type: 'progress', phase: 'checking' });
      if (event.type === 'review_status') publish({ type: 'progress', phase: event.attempt === 1 ? 'reviewing' : 'revising' });
      if (event.type === 'question_requested') {
        const terms = collectPrivateTerms(core.getMessages());
        const source = event.request.questions;
        if (!source.length || checkPublicText(JSON.stringify(source), terms).length) { event.resolve('请自行核对已有线索，不要向客服展示内部技术信息。'); return; }
        const question: PublicQuestion = { id: event.request.id, questions: source.map(q => ({ question: q.question, ...(q.options ? { options: q.options.map(o => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })) } : {}) })) };
        session.pendingQuestion = question; session.status = 'waiting_question';
        const timer = setTimeout(() => run.answer?.('客服尚未作答，请依据现有信息说明待确认事项。'), 5 * 60 * 1000);
        run.answer = text => { clearTimeout(timer); delete session.pendingQuestion; session.status = 'running'; run.answer = undefined; this.store.save(owner, session, core.getMessages()); event.resolve(text); };
        this.store.save(owner, session, core.getMessages()); publish({ type: 'question', question });
      }
    };
    core = new AgentCore({ gateway: model, registry, context: { repoPath: this.config.codeRepoPath || '', localCwd: '' }, ...(this.config.contextTokens ? { contextTokens: this.config.contextTokens } : {}), buildPrompt: (tools, _skills, input) => maskClientToolSections(buildSystemPrompt(tools, getCompanyServerSkills(), 'l2', { hasImages: Array.isArray(input?.content) && input.content.some(part => part.type === 'image_url') })) + '\n\n' + businessPrompt(BUSINESS_PROMPT, answerGuide()) + '\n\n' + PROJECT_MAP_PROMPT + '\n\n' + EXPORT_GUIDE,
      repairTools, checkpoint: messages => this.store.save(owner, session, messages),
      turnId: traceId,
      budget: continueBudget(extensions),
      initialRunState: { turns: saved.runState.turns ?? 0, reviewAttempts: saved.runState.reviewAttempts ?? 0, extensions },
      onStateChange: (state: RunState) => { lastState = state; },
      // 续查不是新的用户提问：以系统提醒形式注入，避免污染对话历史。
      // 带了客服补充时，补充是真实输入，不能整条标成提醒：补充在前、提醒文字在后，合成一条用户消息。
      prepareInput: (value: string | MessageContentPart[]) => {
        const reminder = wrapReminder(`人工已追加 ${CONTINUE_EXTENSION_MINUTES} 分钟活跃预算（第 ${extensions} 次追加）。请继续之前的排查：已核实的內容如实给出，未核实的明确标注待确认，并在窗口内收尾。`);
        const extra: MessageContentPart[] = typeof value === 'string' ? (value.trim() ? [{ type: 'text', text: value }] : []) : value;
        if (!extra.length) return reminder;
        return { role: 'user' as const, content: [...extra, { type: 'text' as const, text: '\n\n' + String(reminder.content) }] };
      },
      // 复核接线按 REVIEW_MODE：gate 只传 review（与引入开关前一致）；advisory 另传 publishLastDraft；off 都不传
      ...this.reviewWiring(mode, (candidate, history, attempt) => this.runReview(owner, controller.signal, model, candidate, history, attempt, traceId, handle, { timeoutMs: this.config.answerReviewTimeoutMs, partialPublish: Boolean(this.config.features?.partialPublish), ...(this.config.reviewModel ? { maxPromptTokens: this.config.reviewMaxPromptTokens } : {}) }), () => core.getMessages(), traceId, 2 + extensions) });
    core.restoreMessages(loaded.messages);
    const run: ActiveRun = { session, core, listeners: new Set([listener]), controller };
    this.runs.set(id, run);
    this.store.save(owner, session, loaded.messages);
    publish({ type: 'progress', phase: 'checking' });
    void (async () => {
      let answer = unavailableAnswer(traceId);
      let resultText = '';
      try {
        const result = await core.run(supplement ?? '', handle);
        resultText = result;
        // off：core 不挂复核，返回的是模型草稿原文（包装 / 平铺 / 代码块），按草稿取出五个答案字段；gate/advisory 返回的是带 reviewStatus 的公开答案
        const parsed = mode === 'off' ? { ...draftFields(result), reviewStatus: 'needs_human' } : JSON.parse(result);
        const { reviewStatus, traceId: ignored, claims, ...draft } = parsed;
        let validated = parsePublicDraft(JSON.stringify(draft), collectPrivateTerms(core.getMessages()));
        if (this.config.dataOnlyForUnknown) {
          const toolTexts = core.getMessages().filter(m => m.role === 'tool').map(m => String(m.content ?? ''));
          if (hasUnknownInvolvedRepo(toolTexts)) validated = applyDataOnlyMode(validated, true);
        }
        if (['reviewed', 'needs_human', 'unreviewed'].includes(reviewStatus)) answer = { ...validated, reviewStatus, traceId, ...(Array.isArray(claims) ? { claims } : {}) };
      } catch { /* Never include internal exceptions in a public answer. */ }
      finally {
        const terms = collectPrivateTerms(core.getMessages());
        session.turns[session.turns.length - 1] = { ...session.turns[session.turns.length - 1], answer };
        if (checkPublicText(session.title, terms).length) session.title = '业务排障会话';
        if (lastState?.frozen) {
          this.store.saveRunState(owner, id, lastState, resultText || null);
          session.frozen = true; session.extensions = lastState.extensions;
          session.activeElapsedMs = lastState.activeMs; session.activeBudgetMs = lastState.activeMs;
        } else {
          delete session.frozen; delete session.extensions; delete session.activeElapsedMs; delete session.activeBudgetMs;
          this.store.clearRunState(owner, id);
        }
        session.status = 'idle'; delete session.pendingQuestion; session.lastActiveAt = new Date().toISOString();
        this.store.save(owner, session, core.getMessages());
        this.runs.delete(id);
        publish({ type: 'answer', turnId: traceId, answer }); publish({ type: 'done' });
      }
    })();
    return true;
  }
  migrate(owner: string, migrationId: string, hash: string, source: { messages: Message[] }): { session: PublicSession; hash: string } {
    if (AgentStore.hash(source) !== hash) throw new Error('hash_mismatch');
    return this.store.transaction(() => {
    const existing = this.store.migration(owner, migrationId);
    if (existing) { if (existing.hash !== hash) throw new Error('migration_conflict'); return existing; }
    const session = this.store.create(owner), terms = collectPrivateTerms(source.messages);
    // Imported assistant prose has never passed the new review. Keep it private; preserve business inputs.
    for (const message of source.messages) {
      if (message.role === 'user' && !message.isReminder && !String(message.content).startsWith('<system-reminder>')) {
        session.turns.push({ id: `r_${randomUUID()}`, userText: publicUserText(message.content, terms), answer: { ...unavailableAnswer('legacy'), conclusion: '历史技术详情已归档，可重新发起排查。', reviewStatus: 'unreviewed', pendingItems: [] } });
      } else if (message.role === 'assistant' && !message.tool_calls?.length && typeof message.content === 'string') {
        const previous = session.turns.at(-1)?.answer;
        const text = message.content.trim();
        // Preserve clearly business-only historical text, including full phone/ID values; never promote its truth status.
        const ambiguous = /数据库|SQL|源码|代码|接口|字段|方法|目录|堆栈|^[\[{]|[A-Za-z_$][\w$]*\s*\(/i.test(text);
        if (previous && text && text.length <= 12000 && !ambiguous && !checkPublicText(text, terms).length) {
          previous.conclusion = '以下为历史业务信息，尚未经过本次复核。';
          previous.evidenceSummary = [text]; previous.customerReply = '';
        }
      }
    }
    session.title = session.turns[0]?.userText.slice(0, 24) || '已归档会话';
    this.store.save(owner, session, source.messages.map(m => ({ ...m, internal: true, imported: true })));
    this.store.markMigration(owner, session.id, migrationId, hash);
    return { session, hash };
    });
  }
}
