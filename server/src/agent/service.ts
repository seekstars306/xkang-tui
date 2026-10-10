import { randomUUID } from 'node:crypto';
import { AgentCore, type ChatGateway, type Message, type MessageContentPart, type Registry, type StreamEvent, type ToolDefinition } from '@xkang/agent-core';
import { isFailedToolResult } from '@xkang/agent-core/context';
import type { PublicAnswer, PublicEvent, PublicQuestion, PublicSession } from '@xkang/agent-core/public';
import { buildSystemPrompt } from './investigation_prompt.js';
import { getCompanyServerSkills } from '../skills.js';
import { createCompanyTools } from '../tools/index.js';
import type { ServerConfig } from '../types.js';
import type { AuditLogger } from '../auth.js';
import { ActiveModelManager, MODEL_PROFILES } from '../model_state.js';
import { BusinessModel } from './model.js';
import { reviewAnswer } from './review.js';
import { checkPublicText, collectPrivateTerms, draftSchema, parsePublicDraft, publicUserText, unavailableAnswer } from './publication.js';
import { AgentStore } from './store.js';

export const BUSINESS_PROMPT = `
读代码时必须检查关键赋值之后的覆盖、完整方法、实际调用点及输入来源。代码只证明机制，不证明本案实际发生。不同金额口径分别查明条件和输入，同一订单也不能混用。名单必须对照原问题的来源与接收范围，完整返回不等于范围正确。查不到不代表不存在。不得编造已通知、已处理等动作。
最终候选只输出一个 JSON 对象：{"answer":{"conclusion":"业务结论","businessData":[{"label":"中文业务字段","value":"完整业务值"}],"evidenceSummary":["通俗的业务依据摘要"],"customerReply":"客服可转述的话术","pendingItems":["待确认事项"]},"evidenceIds":["支撑答案的真实证据编号"]}。evidenceIds 仅用于服务端取证复核，必须引用本会话工具结果标注的真实编号，不得编造；无事实结论时可以为空。
完整姓名、电话、证件、订单和金额是客服必要信息，不掩码，不改写数字，不输出无关客户记录。号码一律字符串。业务规则用通俗话解释；最终公开字段不能出现代码、SQL、库表字段名、方法名、源码目录、内部地址与接口、原始日志或思考过程。内部证据编号仅供你取证，不能放进公开答案。不要输出 Markdown 代码围栏或额外 JSON 字段。
严格对应本轮问题：businessData 只列出回答所需的字段，不能因为查到了更多列就全部输出。用户仅核对基本信息时，不扩展未询问的退款、因果或处理建议。结论只概括一两句，具体数据放在 businessData，客服话术不要再次重复整个资料清单。
每个业务字段表达一个含义，依据摘要的每个条目说明一项依据；不同断言用完整短句分开，保留各自的条件与范围。客服话术仅转述已在正文得到证实的内容，不增加新的时效、费用、法律判断、确定原因或已执行动作。用户未询问且证据未核实的内容直接省略，不能用行业常识补齐成当前系统规则。规则咨询可按题设作条件说明，无须虚构具体订单已查证；实际事件仍需原始业务记录。形成最终候选时直接输出 JSON，第一个字符必须是左花括号，不在前后添加解释。`;

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

export class BusinessRegistry implements Registry {
  private tools = new Map<string, ToolDefinition>();
  constructor(config: ServerConfig, owner: string, audit: AuditLogger) {
    const internalTools = new Set(['lookup_order', 'company_db_query', 'search_code', 'read_file_lines', 'git_inspect', 'codegraph_explore', 'search_logs', 'list_log_apps']);
    for (const tool of createCompanyTools(config).filter(tool => internalTools.has(tool.name))) this.registerLocal({ name: tool.name, description: tool.description, parameters: jsonSchema(tool.schema), execute: async args => {
      const start = Date.now();
      try {
        const result = await tool.execute(tool.schema.parse(args), config, owner);
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
interface ActiveRun { session: PublicSession; core: AgentCore; listeners: Set<(event: PublicEvent) => void>; answer?: (text: string) => void }
export class AgentService {
  private runs = new Map<string, ActiveRun>();
  constructor(public store: AgentStore, private config: ServerConfig, private audit: AuditLogger, private models: ActiveModelManager,
    private modelFactory?: (owner: string) => ChatGateway, private registryFactory?: (owner: string) => Registry) {}
  get(owner: string, id: string): PublicSession | null {
    const loaded = this.store.load(owner, id);
    if (!loaded) return null;
    if (this.runs.has(id)) return this.runs.get(id)!.session;
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
  start(owner: string, id: string, input: string | MessageContentPart[], listener: (event: PublicEvent) => void): () => void {
    const loaded = this.store.load(owner, id);
    if (!loaded) throw new Error('not_found');
    if (this.runs.has(id)) throw new Error('busy');
    const session = loaded.public;
    const traceId = `r_${randomUUID().replaceAll('-', '')}`;
    const initialTerms = collectPrivateTerms(loaded.messages);
    const turn = { id: traceId, userText: publicUserText(input, initialTerms) };
    session.turns.push(turn); session.status = 'running'; session.lastActiveAt = new Date().toISOString();
    if (session.turns.length === 1) session.title = turn.userText.slice(0, 24);
    const setting = this.models.getActive();
    const selected = setting !== 'auto' && MODEL_PROFILES[setting].promptTier === 'l2' ? setting : 'gemini';
    const model = this.modelFactory?.(owner) || new BusinessModel(this.config, selected, this.audit, owner);
    const registry = this.registryFactory?.(owner) || new BusinessRegistry(this.config, owner, this.audit);
    const repairTools = new Set(registry.getTools().filter(t => t.name !== 'ask_user_question' && !t.requiresApproval).map(t => t.name)); repairTools.add('read_tool_result');
    const publish = (event: PublicEvent) => { for (const callback of run.listeners) { try { callback(event); } catch { run.listeners.delete(callback); } } };
    let core: AgentCore;
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
    core = new AgentCore({ gateway: model, registry, context: { repoPath: this.config.codeRepoPath || '', localCwd: '' }, buildPrompt: (tools, _skills, input) => buildSystemPrompt(tools, getCompanyServerSkills(), 'l2', { hasImages: Array.isArray(input?.content) && input.content.some(part => part.type === 'image_url') }) + '\n\n' + BUSINESS_PROMPT,
      repairTools, checkpoint: messages => this.store.save(owner, session, messages),
      review: (candidate, history, attempt) => reviewAnswer(model, candidate, history, attempt, traceId, handle, { timeoutMs: this.config.answerReviewTimeoutMs }) });
    core.restoreMessages(loaded.messages);
    const run: ActiveRun = { session, core, listeners: new Set([listener]) };
    this.runs.set(id, run);
    this.store.save(owner, session, loaded.messages);
    publish({ type: 'progress', phase: 'checking' });
    void (async () => {
      let answer = unavailableAnswer(traceId);
      try {
        const result = await core.run(input, handle);
        const parsed = JSON.parse(result);
        const { reviewStatus, traceId: ignored, ...draft } = parsed;
        const validated = parsePublicDraft(JSON.stringify(draft), collectPrivateTerms(core.getMessages()));
        if (['reviewed', 'needs_human', 'unreviewed'].includes(reviewStatus)) answer = { ...validated, reviewStatus, traceId };
      } catch { /* Never include internal exceptions in a public answer. */ }
      finally {
        const terms = collectPrivateTerms(core.getMessages());
        session.turns[session.turns.length - 1] = { ...turn, userText: publicUserText(input, terms), answer };
        // A source discovered during this turn may make an earlier title technically sensitive.
        if (checkPublicText(session.title, terms).length) session.title = '业务排障会话';
        session.status = 'idle'; delete session.pendingQuestion; session.lastActiveAt = new Date().toISOString();
        this.store.save(owner, session, core.getMessages());
        this.runs.delete(id);
        publish({ type: 'answer', turnId: traceId, answer }); publish({ type: 'done' });
      }
    })();
    return () => run.listeners.delete(listener);
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
