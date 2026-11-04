import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ChatGateway, Message, ModelType, Registry, StreamEvent, ToolDefinition } from '@xkang/agent-core';
import { messageText } from '@xkang/agent-core/context';
import type { PublicAnswer, PublicEvent } from '@xkang/agent-core/public';
import { AgentStore } from '../../server/src/agent/store.ts';
import { AgentService } from '../../server/src/agent/service.ts';
import { AuditLogger } from '../../server/src/auth.ts';

/**
 * REVIEW_MODE（server/src/agent/review_mode.ts）防倒退测试的场景夹具，供 tests/server/review_mode.test.ts 使用。
 *
 * 走真实拼装链路：AgentService.start → AgentCore（复核循环、择优发布）→ runReview → reviewAnswer → 服务端最终解析与发布；
 * 只把两样东西换成造假：排查/复核模型（ScriptedModel，按 options.signal 区分复核调用）与工具注册表（一条固定的数据库结果）。
 * 不触网、不读真实库，也不依赖 server/.env 里的开关：每次运行都显式设定 REVIEW_MODE，并清掉会改变提示词的 RULE_LAYER / REVIEW_OBSERVED_BRANCH。
 */

export const QUESTION = '订单1530517490084478976为什么扣了两次款，退款了没有？';
const DB_RESULT = { status: 'success', complete: true, database: 'billing', columns: ['order_no', 'pay_count', 'refund_amount'], rows: [['1530517490084478976', 2, '81.43']] };
const CALL = { id: 'c1', name: 'company_db_query', arguments: { sql: "SELECT order_no, pay_count, refund_amount FROM billing.pay_order WHERE order_no = '1530517490084478976'" } };

/** 初稿：第 2 句是成因句（现网被逐句裁剪挪进待确认的那类句子） */
export const DRAFT_1 = {
  conclusion: '订单1530517490084478976共收款两次，已退款81.43元。重复收款是因为支付回调被重复处理。',
  businessData: [{ label: '订单号', value: '1530517490084478976' }, { label: '收款次数', value: '2次' }, { label: '退款金额', value: '81.43元' }],
  evidenceSummary: ['收款记录显示该订单共收款两次。', '退款记录显示已退款81.43元。'],
  customerReply: '您好，您重复支付的81.43元已原路退回，请留意到账。',
  pendingItems: ['退款到账时间需与支付渠道确认。'],
};
/** 修订稿（最后一稿）：成因句改了措辞、多了一条待确认，用来区分"发布的是最后一稿"还是初稿 */
export const DRAFT_2 = {
  ...DRAFT_1,
  conclusion: '订单1530517490084478976共收款两次，已退款81.43元。重复收款与支付回调被重复处理有关。',
  pendingItems: ['退款到账时间需与支付渠道确认。', '支付回调日志待调取。'],
};

/** 草稿的几种输出形态：第 round 次给出候选（1=初稿，2=修订稿），evidenceId 取自本会话真实工具结果的证据编号 */
export type DraftText = (evidenceId: string, round: number) => string;
export const envelopeDrafts: DraftText = (evidenceId, round) => JSON.stringify({ answer: round === 1 ? DRAFT_1 : DRAFT_2, evidenceIds: [evidenceId] });

export interface ReviewScript {
  /** judge：按下面的配置给出两阶段结论；unavailable：复核模型每次调用都抛错（L2 复核不可用） */
  kind: 'judge' | 'unavailable';
  /** 反证阶段点名 */
  challenge?: Array<{ blockId: string; reason: string }>;
  /** 引文阶段判为未支持的语句：blockId → 结论与理由；其余事实句判 supported 并给出有效引文 */
  rejected?: Record<string, { assessment: 'unsupported' | 'uncertain' | 'contradicted'; reason: string }>;
  privacySafe?: boolean;
  missingEvidence?: string[];
}

const reply = (value: unknown): Message => ({ role: 'assistant', content: JSON.stringify(value) });

export class ScriptedModel implements ChatGateway {
  /** 发给排查模型的每次请求（深拷贝） */
  readonly main: Array<{ messages: Message[]; tools: string[] }> = [];
  /** 发给复核模型的每次请求（深拷贝） */
  readonly reviews: Message[][] = [];
  constructor(private readonly draftText: DraftText, private readonly review: ReviewScript) {}
  getCurrentModel(): ModelType { return 'xkang-managed'; }
  switchModel() {}
  async streamChat(messages: Message[], tools: ToolDefinition[], _emit: (event: StreamEvent) => void, options?: { signal?: AbortSignal }): Promise<Message> {
    if (options?.signal) return this.reviewReply(messages);
    this.main.push({ messages: structuredClone(messages), tools: tools.map(tool => tool.name) });
    if (this.main.length === 1) return { role: 'assistant', content: '', tool_calls: [structuredClone(CALL)] };
    const evidenceId = /\[证据编号: (e_[0-9a-f-]+)\]/.exec(messages.map(message => messageText(message)).join('\n'))?.[1] ?? 'e_missing';
    return { role: 'assistant', content: this.draftText(evidenceId, this.main.length - 1) };
  }
  private reviewReply(messages: Message[]): Message {
    this.reviews.push(structuredClone(messages));
    if (this.review.kind === 'unavailable') throw new Error('复核模型连接失败');
    const packet = JSON.parse(messageText(messages[1]));
    if (packet.stage === 'challenge') return reply({ checkedUnitIds: packet.blocks.map((block: any) => block.id), issues: this.review.challenge ?? [] });
    const evidenceId = packet.index.find((item: any) => item.outcome === 'success')?.id;
    return reply({
      privacySafe: this.review.privacySafe ?? true,
      missingEvidence: this.review.missingEvidence ?? [],
      blocks: packet.blocks.map((block: any) => {
        const rejected = this.review.rejected?.[block.id];
        if (rejected) return { blockId: block.id, assessment: rejected.assessment, kind: 'fact', references: [], reason: rejected.reason };
        if (String(block.id).startsWith('pending:')) return { blockId: block.id, assessment: 'non_factual', kind: 'advice', references: [], reason: '待办事项' };
        return { blockId: block.id, assessment: 'supported', kind: 'fact', references: [{ evidenceId, quote: '1530517490084478976' }], reason: '记录一致' };
      }),
    });
  }
}

class FixtureRegistry implements Registry {
  private tools = new Map<string, ToolDefinition>();
  constructor() { this.registerLocal({ name: 'company_db_query', description: 'internal', parameters: { type: 'object', properties: {} }, execute: async () => DB_RESULT }); }
  registerLocal(tool: ToolDefinition) { this.tools.set(tool.name, tool); }
  getTools() { return [...this.tools.values()]; }
  getTool(name: string) { return this.tools.get(name); }
  getRemoteSkills() { return []; }
  async executeTool(name: string, args: Record<string, unknown>) { return this.tools.get(name)!.execute(args, { repoPath: '', localCwd: '' }); }
}

/** 测试进程里 env 是全局的：逐项设定（undefined 表示删除），结束后还原 */
export async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  };
  apply(values);
  try { return await fn(); } finally { apply(saved); }
}

export interface ScenarioOptions {
  review: ReviewScript;
  drafts?: DraftText;
  partialPublish?: boolean;
  /** 传 0 时 reviewAnswer 直接抛错：模拟复核函数本身失败（core 重试一次后按复核不可用收尾） */
  answerReviewTimeoutMs?: number;
}
export interface ScenarioRun {
  answer: PublicAnswer;
  events: PublicEvent[];
  main: Array<{ messages: Message[]; tools: string[] }>;
  reviews: Message[][];
  digests: Digests;
}
export interface Digests { main: string; reviews: string; events: string; answer: string }

/** 跑一轮完整排查。mode 是 REVIEW_MODE 的取值，undefined 表示未设置 */
export async function runScenario(mode: string | undefined, options: ScenarioOptions): Promise<ScenarioRun> {
  return withEnv({ REVIEW_MODE: mode, RULE_LAYER: undefined, REVIEW_OBSERVED_BRANCH: undefined }, async () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,timestamp,user,type,tool_name,model,prompt_tokens,completion_tokens,total_tokens,duration_ms,details,success,error)');
    const audit = new AuditLogger(db), store = new AgentStore(db);
    const model = new ScriptedModel(options.drafts ?? envelopeDrafts, options.review);
    const config = { answerReviewTimeoutMs: options.answerReviewTimeoutMs ?? 60000, modelCallTimeoutMs: 240000,
      features: { partialPublish: Boolean(options.partialPublish), timeBudget: false, inputGuard: true, feedbackBinding: false } };
    const service = new AgentService(store, config as any, audit, { getActive: () => 'gemini' } as any, () => model, () => new FixtureRegistry());
    try {
      const session = store.create('alice');
      const events: PublicEvent[] = [];
      await new Promise<void>(resolve => service.start('alice', session.id, QUESTION, event => { events.push(event); if (event.type === 'done') resolve(); }));
      const answer = service.get('alice', session.id)!.turns[0].answer!;
      return { answer, events, main: model.main, reviews: model.reviews, digests: digestsOf({ main: model.main, reviews: model.reviews, events, answer }) };
    } finally { db.close(); }
  });
}

/**
 * 长度 + sha256。随机部分先归一：证据编号按首次出现顺序编号、回合 ID 与时间戳替换成固定占位，
 * 四部分共用一张证据编号表（发给排查模型 → 发给复核模型 → 公开事件 → 公开答案）。
 */
export function digestsOf(parts: { main: unknown; reviews: unknown; events: unknown; answer: unknown }): Digests {
  const ids = new Map<string, string>();
  const normalize = (value: unknown) => JSON.stringify(value)
    .replace(/e_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, id => { if (!ids.has(id)) ids.set(id, `e_${ids.size + 1}`); return ids.get(id)!; })
    .replace(/r_[0-9a-f]{32}/g, 'r_trace')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, 'TS');
  const digest = (text: string) => `${text.length}:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
  const main = normalize(parts.main), reviews = normalize(parts.reviews), events = normalize(parts.events), answer = normalize(parts.answer);
  return { main: digest(main), reviews: digest(reviews), events: digest(events), answer: digest(answer) };
}

/** 两处被判未支持的语句：成因句（结论第 2 句）与客服话术；理由是两句话，用来检查追加进待确认时只保留一句 */
export const REJECTED: NonNullable<ReviewScript['rejected']> = {
  'conclusion#1': { assessment: 'uncertain', reason: '证据只显示收款两次，未直接说明重复收款的原因。' },
  'customerReply#0': { assessment: 'unsupported', reason: '证据没有退款到账的记录；需支付渠道确认。' },
};
export const CHALLENGE = [{ blockId: 'conclusion#1', reason: '无证据说明重复收款由支付回调导致' }];

/** gate 防倒退的五个场景（golden 由改动前的代码对同一组输入生成） */
export const SCENARIOS = {
  /** 两轮复核都打回（部分发布关）：gate 发布裁剪后的兜底答案 */
  rejectTwice: { review: { kind: 'judge', rejected: REJECTED } },
  /** 两轮复核都打回（部分发布开、反证也点名）：gate 发布逐句裁剪 + 待确认挪句的部分答案 */
  rejectTwicePartial: { review: { kind: 'judge', challenge: CHALLENGE, rejected: REJECTED }, partialPublish: true },
  /** 首轮复核通过 */
  pass: { review: { kind: 'judge' } },
  /** 复核模型不可用（无 L3 时即 L2 失败） */
  reviewDown: { review: { kind: 'unavailable' } },
  /** 复核函数本身抛错 */
  reviewThrows: { review: { kind: 'judge' }, answerReviewTimeoutMs: 0 },
} satisfies Record<string, ScenarioOptions>;
export type ScenarioName = keyof typeof SCENARIOS;
