import { createHash, randomUUID } from 'node:crypto';

/**
 * 预算用尽时的追加提示。
 *
 * 客服看到的必须是"问题没查完、你可以让我继续"，而不是一句"尚未得出结论"——
 * 后者只会让人以为这事儿办不成。同时要说清怎么继续，否则没人知道还能续。
 */
export function buildContinueHint(reason: 'budget' | 'incomplete' | null): string {
  if (!reason) return '';
  const title = reason === 'budget'
    ? '【本次排查额度已用完，问题还没有查清】'
    : '【这次排查没有跑完，问题还没有查清】';
  // 客服手上通常只有一个问题，所以不用教他"先引用再回复"，
  // 直接 @ 说一句「继续」就能接上，门槛越低越容易被用起来。
  return `\n\n${title}\n`
    + '如需继续，直接 @我 回复「继续」即可，我会接着刚才的进度往下查，不用重新描述问题。';
}

/** 内容指纹：用于让同一条回复幂等、不同回复各自发送 */
function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}
import type * as lark from '@larksuiteoapi/node-sdk';
import {
  ackText,
  buildContent,
  buildScope,
  DEFAULT_HISTORY_MINUTES,
  filterBySender,
  filterBySenders,
  mentionsBot,
  renderWindow,
  resolveOrigin,
  toSummary,
  type FeishuMessageSummary,
} from './context.js';
import { downloadImageAsDataUrl, getMessage, listChatMessages, replyToMessage, type FeishuClientBundle } from './client.js';
import { getMonitorDb, type FeishuMonitorDb } from './monitor_db.js';
import { decideContinuation, pickUnfinishedIssue } from './attribution.js';
import { isContinueIntent, isObviousContinue } from './continue_intent.js';
import { isStopIntent } from './stop_intent.js';
import { CONTINUE_EXTENSION_MINUTES } from '../agent/continue_budget.js';
import { filterRelevantHistory } from './relevance.js';
import { createShareLink } from './share.js';

/**
 * 飞书问题调度：去重 → 定原消息 → 取窗口 → 过滤 → 调用 xkang → 回复原消息。
 *
 * 并发按“全局最多 N 个执行槽”控制，超出的排队而不是丢弃；
 * 同一客服对同一原问题再次 @ 视为补充，沿用同一 issue，不新开线程。
 * 去重键用 message_id（飞书官方要求，事件可能重复推送）。
 */

export interface AgentRunner {
  /** 跑一次排查，返回给客服看的简要答案；抛错表示失败 */
  run(input: {
    issueId: string;
    content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
    /** 复用已有会话（加预算续查时传入），缺省则新建 */
    sessionId?: string | null;
  }): Promise<RunnerResult>;
  /**
   * 加预算续查：对已冻结的会话追加预算（15 分钟）并从原进度继续。
   * content 是排查期间排队的客服补充（只在"运行中说继续、本轮没查完"时带）；不带时与原来一致。
   */
  resume?(sessionId: string, issueId: string, content?: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>): Promise<RunnerResult>;
  /**
   * 立刻停止正在跑的这一轮（客服 @ 说了“停/别查了”）。
   * 返回 true 表示服务端确实中断了那个会话的运行；false 表示它已经跑完或本来就没在跑。
   */
  abort?(sessionId: string): Promise<boolean>;
}

export interface RunnerResult {
  /** 群里展示的简短结论 */
  text: string;
  /** 供详情页使用的结构化答案（可缺省） */
  answer?: Record<string, unknown> | null;
  /** 本次使用的会话 ID；"继续"时要带上它 */
  sessionId?: string;
  /** 预算用尽被冻结：问题没查完，应当询问客服是否继续 */
  frozen?: boolean;
  /** 没形成可采信的结论（模型超时等）：同样应当提供"继续"入口 */
  incomplete?: boolean;
}

export interface DispatcherOptions {
  maxConcurrent?: number;
  beforeCount?: number;
  maxScanMessages?: number;
  log?: (message: string) => void;
  /** 监控台账；未传时用默认路径，便于单测注入临时库 */
  monitor?: FeishuMonitorDb;
  /** 公网基地址，用于拼接结论分享链接；缺省读 XKANG_PUBLIC_BASE_URL */
  publicBaseUrl?: string;
  /**
   * 历史候选的时间窗（分钟）：只有这个窗口内、同一发起人的话才可能与本问题相关。
   * 缺省 30 分钟；超过半小时的对话通常已经是另一件事。
   */
  historyWindowMinutes?: number;
}

interface Issue {
  issueId: string;
  chatId: string;
  originMessageId: string;
  /** 发起本次请求的人：@ 机器人、等待回复的人 */
  requesterOpenId: string;
  /**
   * 原问题的作者。通常与 requester 相同，但存在“A 发问题、B 来 @ 机器人”的情况。
   * 回复时两人都要 @：只 @ B 会让当事人 A 收不到结论。
   */
  originAuthorOpenId: string | null;
  /** 已处理过的触发消息 ID，用于去重与补充识别 */
  seenTriggers: Set<string>;
  queued: boolean;
  /** 建这个问题的那次 @：客服常把问题本身写在 @ 里，它和原消息一起才是"原问题" */
  firstTriggerId: string;
  /** 还在排队或运行的任务数；> 0 说明这个问题还没给出最终结果 */
  pendingJobs: number;
  /** 最近一次有动静的时间（毫秒） */
  lastActivityMs: number;
  /**
   * 原问题还没出最终结果时收到的补充，按到达顺序排队：每条是那次 @ 本身 + 它引用的那条（没引用为 null）。
   * 只排队、不另起一轮；当前这一轮结束时一次取走，在同一会话上接着跑一轮补充（见 runRound）。
   * continueIntent：排队时就发起的"是不是在要求继续"判定（带超时，判不了按不是继续）；
   * 这一轮额度用完 / 没跑完且其中有一条是继续时，下一轮走加预算续查（见 nextSupplementRound）。
   */
  queuedSupplements: Array<{ trigger: FeishuMessageSummary; quotedId: string | null; continueIntent: Promise<boolean> }>;
  /** 当前这一轮的监控任务，排队的补充在它上面留痕 */
  activeTaskId: string | null;
  /**
   * 客服要求停止（运行中 @ 说“停/别查了”）。
   * 置位后：这一轮的结果一律不外发，排队的补充全部作废。
   */
  cancelled?: boolean;
}

/** 一轮排查的输入：第一轮来自触发的那次 @，之后的补充轮来自排队的补充 */
interface RoundInput {
  trigger: FeishuMessageSummary;
  isNew: boolean;
  taskId: string;
  /** 加预算续查：第一轮（出结果后 @ 说继续），或运行中说了继续、上一轮没查完时的补充轮 */
  continuation: boolean;
  sessionId: string | null;
  /** 这一轮要并入的补充，按到达顺序 */
  supplements: Issue['queuedSupplements'];
  onStarted?: () => void;
}

/**
 * 同一个人的上一条 @ 还没归属完时，下一条最多等这么久。
 * 正常归属只要几百毫秒（最慢是 2.5 秒的 Jev 判定）；设上限是为了上一条卡在网络上时，
 * 这个人之后的 @ 不会跟着一直卡住。
 */
const SENDER_TURN_WAIT_MS = 10_000;

/**
 * 排队补充的继续意图判定上限。判定在排队时就发起、不阻塞归属；只有这一轮没查完时才会等它的结果，
 * 到点还没判出来按"不是继续"——宁可走普通补充，也不白烧一轮加预算。
 */
const QUEUED_INTENT_TIMEOUT_MS = 3_000;

export class FeishuDispatcher {
  private readonly issues = new Map<string, Issue>();
  private readonly seenMessageIds = new Set<string>();
  /** 每个"群 + 发送人"当前排着的归属轮次，见 takeSenderTurn */
  private readonly senderTurns = new Map<string, Promise<void>>();
  private readonly queue: Array<() => Promise<void>> = [];
  private running = 0;
  private readonly maxConcurrent: number;

  private readonly monitor: FeishuMonitorDb;

  constructor(private readonly bundle: FeishuClientBundle, private readonly runner: AgentRunner, private readonly options: DispatcherOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
    this.monitor = options.monitor ?? getMonitorDb();
  }

  /** 处理一条 im.message.receive_v1 事件。必须在 3 秒内返回，所以只入队不等结果 */
  async handleEvent(event: Record<string, unknown>): Promise<void> {
    const message = (event.message ?? {}) as Record<string, unknown>;
    const messageId = String(message.message_id ?? '');
    const chatId = String(message.chat_id ?? '');
    const chatType = String(message.chat_type ?? '');
    const sender = (event.sender ?? {}) as Record<string, unknown>;
    const senderOpenId = String((sender.sender_id as Record<string, unknown> | undefined)?.open_id ?? '');
    const senderType = String(sender.sender_type ?? '');

    // 只处理群聊里、由真人发出的消息
    if (!messageId || !chatId || chatType !== 'group') return;
    if (senderType !== 'user') return;

    // 去重：飞书可能重复推送同一条消息
    if (this.seenMessageIds.has(messageId)) return;
    this.seenMessageIds.add(messageId);

    const mentions = (message.mentions ?? []) as Array<Record<string, unknown>>;
    const summary = toSummary({
      message_id: messageId,
      sender_id: senderOpenId,
      sender_type: senderType,
      create_time: message.create_time as string | undefined,
      msg_type: message.message_type as string | undefined,
      text: this.extractText(message),
      parent_id: message.parent_id as string | undefined,
      root_id: message.root_id as string | undefined,
      thread_id: message.thread_id as string | undefined,
      // 事件里的 mentions 可能是 { id: "ou_xxx", id_type: "open_id" }，
      // 也可能是 { id: { open_id: "ou_xxx" } }；两种都要认，否则 @ 永远匹配不上。
      mentions: mentions.map(m => ({
        open_id: typeof m.id === 'string' ? m.id : String((m.id as Record<string, unknown> | undefined)?.open_id ?? ''),
        name: String(m.name ?? ''),
        mentioned_type: String(m.mentioned_type ?? ''),
      })),
    });

    // 只在显式 @ 本机器人时才建任务：正文里出现名字不算
    const mentioned = mentionsBot(summary, this.bundle.bot.openId);
    // 没匹配上 @ 时把正文也打出来：客服手打"@小康客服助手"不会生成 mention 实体，
    // 飞书就不会在事件里给出 open_id。以前这种情况完全静默，看起来就是"机器人不理我"。
    const preview = summary.text.replace(/\s+/g, ' ').slice(0, 60);
    this.options.log?.(`收到群消息 ${messageId}｜@本bot=${mentioned}｜mentions=${summary.mentions.map(m => m.openId).join(',') || '(无)'}${mentioned ? '' : `｜正文=${preview}`}`);
    if (!mentioned) return;

    const { originMessageId: quotedId, anchorKind, degraded } = resolveOrigin(summary);
    if (degraded) this.options.log?.(`话题内引用无法精确定位楼层，按话题根处理：${quotedId}`);
    if (!quotedId) return;

    // 同一个人在同一个群里的 @ 按到达顺序逐条归属。飞书会把积压的事件一口气推过来：
    // 上一条还在等网络、问题还没建好时，下一条如果同时归属，就看不到"还没出结果的问题"，
    // 又会被当成新问题。只串行"归属 + 入队"这一段，排查本身照常并发。
    const releaseTurn = await this.takeSenderTurn(`${chatId}:${senderOpenId}`);
    try {
      await this.routeMention(summary, chatId, senderOpenId, quotedId, anchorKind !== 'self');
    } finally {
      releaseTurn();
    }
  }

  /**
   * 排到这个人的归属轮次：上一条还没归属完就先等它（最多 SENDER_TURN_WAIT_MS），返回释放函数。
   */
  private async takeSenderTurn(key: string): Promise<() => void> {
    const previous = this.senderTurns.get(key);
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    this.senderTurns.set(key, mine);
    if (previous) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([previous, new Promise<void>(resolve => { timer = setTimeout(resolve, SENDER_TURN_WAIT_MS); })]);
      clearTimeout(timer);
    }
    return () => {
      release();
      if (this.senderTurns.get(key) === mine) this.senderTurns.delete(key);
    };
  }

  /** 一条 @ 的归属、建任务与入队（同一个人的 @ 在这里逐条执行，见 handleEvent） */
  private async routeMention(
    summary: FeishuMessageSummary,
    chatId: string,
    senderOpenId: string,
    /** 被引用的那条；没引用（直接 @）时就是这条消息自己 */
    quotedId: string,
    /** 这次 @ 是否引用了别的消息 */
    quoted: boolean,
  ): Promise<void> {
    const messageId = summary.messageId;

    // ===== 发起人自己的问题还没出最终结果：这次 @ 一律算补充 =====
    //
    // 引用或不引用、说什么都一样（包括"继续"、包括带了新单号），都并入原问题；
    // "继续"只额外记一个意图：这一轮没查完时下一轮改走加预算续查（见 nextSupplementRound），
    // 原问题仍是主问题，这次的话和它引用的那条作为补充材料（见 execute 的【客服补充】）。
    // 同一个人不会同时提两个问题，所以归属不判语义、不看编号、不设时间窗。
    // 只认同群、同一发起人（attribution.ts）：别人的 @ 永远并不进来，跨群也不行。
    // 出了最终结果之后不再命中，下面原有的引用续查 / 额度用完继续 / 新问题规则一律照旧。
    const unfinished = pickUnfinishedIssue(this.issues.values(), chatId, senderOpenId);

    // ===== 停止意愿：无论有没有在跑，都要先判一次 =====
    //
    // 有在跑   → 立刻中断，不把跑偏的结论发出去；
    // 没在跑   → 明确回“当前没有正在进行的排查”。
    // 线上真事故：客服 @ 说“停吧”时恰好没有在跑的排查，结果这句话被当成新问题，
    // 真的开了一轮排查并把结论发到了群里。停止指令永远不能变成新任务。
    //
    // 判定完全交给 Jev（不做关键词粗筛）：否定说法如「别停吧」「先别停，继续查」
    // 词表很容易判反，交给模型理解语义更可靠。
    // 保守方向仍是不停止：判不出来就按普通消息继续走，误停会白白丢掉跑了很久的一轮。
    if (!unfinished?.cancelled) {
      const stop = await isStopIntent(summary.text, { timeoutMs: 2000 });
      if (stop.shouldStop) {
        if (unfinished) {
          await this.stopIssue(unfinished, summary, stop.degraded);
        } else {
          await this.replyPlain(summary, '当前没有正在进行的排查，无需停止。需要排查新问题时，请把问题描述清楚并 @我。');
        }
        return;
      }
    }

    // ===== 加预算：客服要接着查同一个问题 =====
    //
    // 两种入口都支持：
    //   A. 引用机器人的那条「额度已用完」消息 → @机器人 → 说继续   （最精确）
    //   B. **直接 @机器人** → 说继续                                （客服手上通常只有一个问题）
    // 归属规则集中在 attribution.ts（纯函数，有单测），这里只负责执行。
    let originMessageId = unfinished ? unfinished.originMessageId : quotedId;
    let continuationSource: 'quote' | 'sender' | null = null;
    let resumeSessionId: string | null = null;

    // 并入还没出结果的问题时，下面的引用 / 续查判定全部跳过：不查结论、不调 Jev、不问机器人，
    // decideContinuation 拿到的全是空输入，必然是 normal。
    // 查库带 chatId：只有同群的结论才算，绝不跨群认领
    const resumeRef = unfinished ? null : this.monitor.findIssueByReply(quotedId, chatId);
    // 没引用结论时，看这个人手上有没有"额度用完、可以继续"的问题
    const continuable = (unfinished || resumeRef) ? null : this.monitor.findContinuableIssue(chatId, senderOpenId);

    // 有候选才判语义。2.5 秒封顶：这条判定在事件回调里跑，
    // 飞书要求 3 秒内 ACK，超时就退回关键词判断，绝不拖到重推。
    const intent = (resumeRef || continuable)
      ? await isContinueIntent(summary.text, { timeoutMs: 2500 })
      : { isContinue: false, degraded: undefined as string | undefined };

    // 只有前两条都没命中时，才需要多花一次网络调用去问"引用的那条是不是机器人"
    const needBotCheck = !unfinished && !resumeRef && !(continuable && intent.isContinue);
    const quotedIsBot = needBotCheck ? Boolean((await this.getMessageSenderInfo(quotedId))?.isBot) : false;

    const decision = decideContinuation({
      quotedId, senderOpenId, resumeRef, continuable,
      intentIsContinue: intent.isContinue, quotedIsBot,
    });

    if (decision.kind === 'reject_not_requester') {
      this.options.log?.(`拒绝续查：${senderOpenId} 不是原发起者 ${decision.originalRequester}（消息 ${messageId}）`);
      await this.replyPlain(summary, '这条结论对应的问题由其他同事发起。如需继续排查，请由最初提问的同事直接 @我 回复「继续」。');
      return;
    }
    if (decision.kind === 'reject_unknown_bot') {
      this.options.log?.(`拒绝建任务：引用了机器人消息 ${quotedId}，但查不到对应问题（消息 ${messageId}）`);
      await this.replyPlain(summary, '没有找到这条结论对应的原问题，可能已过期。请引用最初的问题，或重新描述问题后再 @ 我。');
      return;
    }
    if (decision.kind === 'continue') {
      // 归属锁死到原来那条原问题，会话沿用原来的：不新建问题、不错位。
      originMessageId = decision.originMessageId;
      resumeSessionId = decision.sessionId;
      continuationSource = resumeRef ? 'quote' : 'sender';
      this.options.log?.(
        `判为继续 ${originMessageId}（入口=${continuationSource}｜语义=${intent.isContinue ? '继续' : '补充'}${intent.degraded ? '｜' + intent.degraded : ''}）`,
      );
    }
    if (unfinished) {
      this.options.log?.(
        `并入还没出结果的问题 ${unfinished.issueId}（原问题 ${originMessageId}）：${messageId}${quoted ? `，引用 ${quotedId}` : '，未引用'}；排队，本轮结束后在同一会话上一起并入`,
      );
    }

    const issueKey = `${chatId}:${originMessageId}:${senderOpenId}`;
    let issue = this.issues.get(issueKey);
    const isNew = !issue;
    if (!issue) {
      // 原问题作者需要单独查一次：事件里只有当前消息的发送者，
      // 当 A 发问题、B 来 @ 时，A 的身份只能从原消息上取。
      const originAuthorOpenId = await this.resolveOriginAuthor(chatId, originMessageId, senderOpenId);
      issue = {
        issueId: randomUUID().slice(0, 8), chatId, originMessageId,
        requesterOpenId: senderOpenId, originAuthorOpenId,
        seenTriggers: new Set(), queued: false,
        firstTriggerId: messageId, pendingJobs: 0, lastActivityMs: Date.now(), queuedSupplements: [], activeTaskId: null,
      };
      this.issues.set(issueKey, issue);
    }
    if (issue.seenTriggers.has(messageId)) return;
    issue.seenTriggers.add(messageId);
    issue.lastActivityMs = Date.now();

    // 原问题还没出最终结果：这次 @ 只排队，绝不另起一轮和原排查并行
    if (unfinished) {
      this.queueSupplement(issue, summary, quoted ? quotedId : null);
      return;
    }

    // 监控：每条触发都建一条任务记录，补充类触发也记，便于看到“一次问题被追加了几次”。
    // 任务 ID 放进局部变量而不是实例字段——并发时实例字段会串到别人的任务上。
    const taskId = `${issue.issueId}-${issue.seenTriggers.size}`;
    issue.activeTaskId = taskId;
    try {
      this.monitor.createTask({
        id: taskId,
        chatId,
        chatName: null,
        requesterOpenId: senderOpenId,
        requesterName: summary.mentions.find(m => m.openId !== this.bundle.bot.openId)?.name ?? null,
        originAuthorOpenId: issue.originAuthorOpenId,
        originMessageId,
        triggerMessageId: messageId,
      });
      this.monitor.addStep(taskId, 'event',
        `收到 @ 消息 ${messageId}${continuationSource ? `（继续入口：${continuationSource === 'quote' ? '引用结论' : '直接 @'}）` : ''}`,
        `origin=${originMessageId} queueFull=${this.running >= this.maxConcurrent}${resumeSessionId ? ` 复用会话=${resumeSessionId}` : ''}`);
    } catch (e) {
      this.options.log?.(`监控写入失败：${e instanceof Error ? e.message : String(e)}`);
    }

    // 队列已满时立刻告知排队，不要让客服以为已经在跑。
    // 有空位则静默入队，等真正取完上下文、即将调用模型的那一刻再回“已开始”。
    const queueFull = this.running >= this.maxConcurrent || this.queue.length > 0;
    // 并入已有问题时回执里必须写明编号：客服要能看出这句话算到了哪个问题上
    const mergedAck = `已收到补充信息（编号 ${issue.issueId}），会并入当前排查。`;
    if (queueFull) {
      const ahead = this.running + this.queue.length;
      if (isNew) {
        this.ack(issue, summary, `已收到（编号 ${issue.issueId}）。当前有 ${ahead} 个任务在处理或排队，队列已满，请您等待；轮到后我会在这里回复已开始排查。`);
      } else {
        this.ack(issue, summary, mergedAck, true);
      }
    } else if (!isNew) {
      this.ack(issue, summary, mergedAck, true);
    }

    // 语义在事件回调里已经判过一次了，这里直接复用，不再重复调用 Jev。
    // 只有"确实在要求继续"才走加预算；引用了结论但提出的是新内容，按补充处理。
    const continuation = continuationSource !== null && intent.isContinue;
    const tracked = issue;
    // "还没出最终结果"从入队起算，到决定发出最终结果（结论或报错）的那一刻为止；只释放一次
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      tracked.pendingJobs--;
      tracked.lastActivityMs = Date.now();
    };
    const job = async () => {
      if (continuationSource) {
        try {
          this.monitor.addStep(taskId, 'intent',
            continuation ? '判定为继续排查（追加一轮预算）' : '引用了结论但按补充处理',
            `入口=${continuationSource === 'quote' ? '引用结论' : '直接 @'}${intent.degraded ? '｜' + intent.degraded : ''}`);
        } catch { /* ignore */ }
      }
      // 一轮接一轮：某一轮结束时有排队的补充，就不发这一轮的结果，在同一会话上接着跑补充轮，
      // 直到没有新的排队补充为止，只发最后一轮的结果。全程占同一个执行槽，不会和自己并行。
      let round: RoundInput | null = {
        trigger: summary, isNew, taskId, continuation,
        sessionId: resumeSessionId ?? this.monitor.getIssue(originMessageId)?.sessionId ?? null,
        supplements: [],
        onStarted: () => {
          if (!queueFull) {
            this.ack(tracked, summary, continuation
              ? `继续排查中（编号 ${tracked.issueId}），已追加 ${CONTINUE_EXTENSION_MINUTES} 分钟，完成后在这里回复您。`
              : `已开始排查（编号 ${tracked.issueId}），预计需要几分钟，完成后在这里回复您。`);
          }
        },
      };
      while (round) round = await this.runRound(tracked, round, release);
    };
    tracked.pendingJobs++;
    this.enqueue(() => job().finally(release));
  }

  /**
   * 原问题还没出最终结果：这次 @ 只排队（绝不另起一轮与原排查并行），回执照常发并写明编号。
   * 当前这一轮结束时，runRound 会在同一会话上带着全部排队的补充接着跑。
   */
  private queueSupplement(issue: Issue, trigger: FeishuMessageSummary, quotedId: string | null): void {
    // 先同步入队（本轮随时可能结束，入队不能晚于它的 holdBack 判断），意图判定在后台跑
    const continueIntent = this.judgeQueuedIntent(trigger.text);
    issue.queuedSupplements.push({ trigger, quotedId, continueIntent });
    const taskId = issue.activeTaskId;
    if (taskId) {
      try {
        this.monitor.addStep(taskId, 'event', `收到补充 @ ${trigger.messageId}（排队，本轮结束后并入）`, quotedId ? `引用 ${quotedId}` : '未引用');
      } catch { /* 监控失败不影响主流程 */ }
    }
    // 回执要立刻发（不等 Jev）：措辞只按关键词判；是否真的续查以排队项上的完整判定为准
    const ack = `已收到补充信息（编号 ${issue.issueId}），会并入当前排查。`;
    this.ack(issue, trigger, isObviousContinue(trigger.text)
      ? `${ack}您要求继续：本轮结束后如果还没查完，会再追加 ${CONTINUE_EXTENSION_MINUTES} 分钟接着查。`
      : ack, true);
    void continueIntent.then(isContinue => {
      if (!isContinue || !taskId) return;
      try { this.monitor.addStep(taskId, 'intent', `补充 @ ${trigger.messageId} 判定为继续`, `本轮额度用完或没跑完时，下一轮追加 ${CONTINUE_EXTENSION_MINUTES} 分钟续查`); } catch { /* ignore */ }
    });
  }

  /** 排队补充的继续意图：带超时，出错或超时一律按"不是继续" */
  private judgeQueuedIntent(text: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), QUEUED_INTENT_TIMEOUT_MS); });
    const judged = isContinueIntent(text, { timeoutMs: 2500 }).then(r => r.isContinue, () => false);
    return Promise.race([judged, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * 跑一轮并收尾。
   *
   * 到了要发结果的那一刻（结论、额度用完、没跑完、报错都算这一轮结束），先看有没有排队的补充：
   *   有   → 这一轮的结果不发群里，只记日志和监控，返回补充轮的参数，由调用方在同一会话上接着跑；
   *   没有 → 从这一刻起算"出了最终结果"（release），发出结果，返回 null。
   * 补充轮默认走普通追问（runner.run），不额外加预算；例外：这一轮额度用完（frozen）或没跑完（incomplete），
   * 且排队的补充里有一条是继续意图 → 补充轮走加预算续查（runner.resume，服务端 /continue 追加 15 分钟），
   * 排队的补充照常带进去（见 nextSupplementRound）。
   */
  private async runRound(issue: Issue, round: RoundInput, release: () => void): Promise<RoundInput | null> {
    const holdBack = () => {
      if (issue.queuedSupplements.length > 0) return true;
      release();
      return false;
    };
    const originMessageId = issue.originMessageId;
    try {
      const outcome = await this.execute(issue, round.trigger, round.isNew, round.taskId, round.onStarted,
        { continuation: round.continuation, sessionId: round.sessionId, supplements: round.supplements }, holdBack);
      if (round.continuation) {
        try { this.monitor.bumpIssueRound(originMessageId); } catch { /* ignore */ }
      }
      return outcome.heldBack ? await this.nextSupplementRound(issue, outcome.sessionId, outcome.unfinished) : null;
    } catch (error) {
      // 客服已经要求停止：中断本身会让这一轮报错，不该再发一条“模型异常/没跑完”。
      if (issue.cancelled) {
        this.options.log?.(`本轮已停止 ${issue.issueId}，不再发失败提示`);
        try { this.monitor.fail(round.taskId, '客服要求停止，本轮已中断'); } catch { /* ignore */ }
        return null;
      }
      const msg = error instanceof Error ? error.message : String(error);
      this.options.log?.(`排查失败 ${issue.issueId}：${msg}`);
      try { this.monitor.fail(round.taskId, msg); } catch { /* 监控失败不影响主流程 */ }

      // 中途失败也要留一个"继续"的入口：把会话记下来并标成可继续，
      // 否则客服只能干等或重新描述一遍问题。
      const failedSession = (error as { sessionId?: string } | null)?.sessionId
        ?? this.monitor.getIssue(originMessageId)?.sessionId
        ?? null;
      if (failedSession) {
        try {
          this.monitor.saveIssueSession({
            originMessageId,
            chatId: issue.chatId,
            requesterOpenId: issue.requesterOpenId,
            sessionId: failedSession,
          });
          this.monitor.setIssueFrozen(originMessageId, true);
        } catch { /* 监控失败不影响主流程 */ }
      }
      if (holdBack()) {
        this.options.log?.(`本轮报错未发群里 ${issue.issueId}：有 ${issue.queuedSupplements.length} 条排队的补充，接着在同一会话上跑补充轮`);
        try { this.monitor.addStep(round.taskId, 'reply', '有排队的补充，本轮报错不发群里', msg.slice(0, 300)); } catch { /* ignore */ }
        // 报错不算"额度用完 / 没跑完"的结论，排队里有"继续"也照旧走普通补充轮
        return await this.nextSupplementRound(issue, failedSession, false);
      }
      // 模型自身故障直接如实报错，不要包装成"没跑完、要不要继续"：
      // 这时候再续一轮也是同样结果，客户需要的是"等一会儿再试"，不是再点一次继续。
      const isModelError = /模型请求失败|模型服务|terminated|timed?\s*out|ECONN|socket hang up|Connection error|fetch failed/i.test(msg);
      await this.safeReply(
        issue, round.trigger,
        isModelError
          ? `【模型异常】本次排查未能完成（编号 ${issue.issueId}）。这不是问题本身的原因，请稍后重试。`
          : `这次排查没有跑完（编号 ${issue.issueId}），已记录。` + buildContinueHint(failedSession ? 'incomplete' : null),
        'failed',
      );
      return null;
    }
  }

  /**
   * 一次取走全部排队的补充，开一轮补充（同一会话），监控里单独记一条任务。
   * roundUnfinished：刚结束的这一轮是额度用完（frozen）或没跑完（incomplete）。此时排队的补充里
   * 有一条是继续意图，这一轮就走加预算续查（continuation），否则与原来一样是普通补充语义。
   */
  private async nextSupplementRound(issue: Issue, sessionId: string | null, roundUnfinished: boolean): Promise<RoundInput> {
    const supplements = issue.queuedSupplements.splice(0);
    // 只在没查完时才等判定结果：查完了的一轮与原来完全一样，不多等一毫秒
    const continuation = roundUnfinished && sessionId !== null
      && (await Promise.all(supplements.map(s => s.continueIntent))).some(Boolean);
    const trigger = supplements[supplements.length - 1].trigger;
    const taskId = `${issue.issueId}-${issue.seenTriggers.size}`;
    const ids = supplements.map(s => s.trigger.messageId).join(', ');
    issue.activeTaskId = taskId;
    try {
      this.monitor.createTask({
        id: taskId,
        chatId: issue.chatId,
        chatName: null,
        requesterOpenId: issue.requesterOpenId,
        requesterName: null,
        originAuthorOpenId: issue.originAuthorOpenId,
        originMessageId: issue.originMessageId,
        triggerMessageId: trigger.messageId,
      });
      this.monitor.addStep(taskId, 'event', continuation
        ? `续查轮（追加 ${CONTINUE_EXTENSION_MINUTES} 分钟）：上一轮没查完、排队里有继续，并入排队的 ${supplements.length} 条补充`
        : `补充轮：并入排队的 ${supplements.length} 条补充`,
        `补充 @：${ids}${sessionId ? ` 复用会话=${sessionId}` : ''}`);
    } catch (e) {
      this.options.log?.(`监控写入失败：${e instanceof Error ? e.message : String(e)}`);
    }
    this.options.log?.(`接着跑${continuation ? `续查轮（追加 ${CONTINUE_EXTENSION_MINUTES} 分钟）` : '补充轮'} ${issue.issueId}：并入 ${supplements.length} 条补充（${ids}）`);
    return { trigger, isNew: false, taskId, continuation, sessionId, supplements };
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue.push(job);
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void job().finally(() => { this.running--; void this.drain(); });
    }
  }

  private async execute(
    issue: Issue,
    trigger: FeishuMessageSummary,
    isNew: boolean,
    taskId: string,
    onStarted?: () => void,
    runOpts?: { continuation?: boolean; sessionId?: string | null; supplements?: Issue['queuedSupplements'] },
    /** 要发结果前问一次：返回 true 表示有排队的补充，这一轮的结果不发（见 runRound） */
    holdBack?: () => boolean,
  ): Promise<{ heldBack: boolean; sessionId: string | null; unfinished: boolean }> {
    const { client } = this.bundle;
    const step = (kind: string, summary: string, detail?: string) => {
      try { this.monitor.addStep(taskId, kind, summary, detail); } catch { /* 监控失败不影响排查 */ }
    };
    try { this.monitor.markRunning(taskId); } catch { /* ignore */ }
    // ===== 获取问题内容：完整逻辑（顺序不能乱）=====
    //
    //  ① 定位原问题：@ 消息的 parent_id 指向被引用的那条。
    //  ② 定条数域：原问题往前 20 条 → 本次 @（含两端）。
    //  ③ 取出问题内容：原问题 + 本次 @ —— 两条都是问题本身，永不剔除。
    //     客服常见写法是「引用问题 → 只发一个 @bot」，问题全在被引用那条；
    //     也可能「直接 @bot 并写问题」；还可能「引用 + 本次补充」，两条都带内容。
    //     所以是"都取"，不是二选一。
    //  ④ 域内剔超时：距本次 @ 超过 30 分钟的消息不进材料。
    //  ⑤ 域内剔他人：材料只留发起 @ 的那个人说的话。
    //  ⑥ Jev 判相关性：剩下的逐条问，无关的剔掉。
    //  ⑦ 组装：问题原文在前，相关材料在后。
    //
    // ③ 必须早于 ④⑤：否则「昨天提的问题、今天引用它来问」会被时间规则删掉，
    // 主体变空——这正是之前出问题的原因。
    const timeline = await this.loadTimeline(issue.chatId, trigger.createTimeMs);

    // 原问题可能早于历史窗口：群里引用很久以前那条（常带截图）来追问很常见。
    // 窗口内找不到就按 ID 单独取一次——否则「本次问题原文」只剩一个 @，
    // 问题正文和附件（截图）全部丢失，模型只能靠猜。
    if (!timeline.some(m => m.messageId === issue.originMessageId)) {
      const origin = await this.fetchSummary(issue.originMessageId);
      if (origin) {
        timeline.push(origin);
        timeline.sort((a, b) => a.createTimeMs - b.createTimeMs);
      }
    }

    // 范围（用户口径）：
    //   ① 被引用那条
    //   ② 它往前 30 分钟内的最近 20 条
    //   ③ 它 → 本次 @ 之间、距它 30 分钟内的所有会话
    //   ④ @ 当条
    // 当事人：原问题作者 A。查不到时退回发起 @ 的人。
    const subjectOpenId = issue.originAuthorOpenId ?? issue.requesterOpenId;
    const { scope, originFound, backCount, forwardCount } = buildScope(
      timeline,
      issue.originMessageId,
      trigger,
      {
        backMinutes: this.options.historyWindowMinutes ?? DEFAULT_HISTORY_MINUTES,
        backCount: this.options.beforeCount ?? 20,
        forwardMinutes: this.options.historyWindowMinutes ?? DEFAULT_HISTORY_MINUTES,
        // ②③ 只统计 A 自己的话：别人的发言不占范围名额，也不进材料
        senderOpenId: subjectOpenId,
      },
    );
    if (!originFound) {
      this.options.log?.(`未在群历史中找到被引用消息 ${issue.originMessageId}，本次仅以 @ 消息为问题`);
    }

    // 问题内容：原问题 + 本次 @。两者都算问题本身，永不剔除。
    let mustKeep = new Set([issue.originMessageId, trigger.messageId]);
    let questionParts = scope.filter(m => mustKeep.has(m.messageId));
    if (!questionParts.some(m => m.messageId === trigger.messageId)) questionParts.push(trigger);

    // 例外：补充轮。问题内容只认原问题（原消息 + 建问题的那次 @），这一轮并入的每次 @
    // 和它引用的那条按到达顺序进【客服补充】，永不剔除。
    // 事故里正是补充的那句"我刚把状态手动改为未收款了"被当成了问题本身。
    const supplementParts: Array<{ message: FeishuMessageSummary; quoted: boolean }> = [];
    if (runOpts?.supplements?.length) {
      ({ mustKeep, questionParts } = await this.collectSupplements(issue, runOpts.supplements, timeline, supplementParts));
    }
    questionParts.sort((a, b) => a.createTimeMs - b.createTimeMs);
    const questionText = questionParts
      .map(m => m.text.trim())
      .filter(Boolean)
      .join('\n\n');
    const supplementText = this.renderSupplements(supplementParts, issue.requesterOpenId);

    // 范围里其余消息就是 A 的其他发言（scope 已按 A 收窄）；去掉没有正文的。
    // B 只在 @ 那条里给出的内容算数，已计入问题内容。
    const ownMessages = scope.filter(
      m => !mustKeep.has(m.messageId)
        && (m.text.trim().length > 0 || m.resourceKeys.length > 0),
    );

    // ⑥ Jev 判相关性（有补充时连同补充一起作为判断依据）
    const relevance = ownMessages.length
      ? await filterRelevantHistory(supplementText ? `${questionText}\n\n${supplementText}` : questionText, ownMessages, { timeoutMs: 12000, nowMs: trigger.createTimeMs })
      : { relevant: [], irrelevant: [], uncertain: [], degraded: undefined };
    const keepSet = new Set([...relevance.relevant, ...relevance.uncertain]);

    // ⑦ 组装：问题内容 + 补充 + 相关材料，按时间排
    const kept = [
      ...questionParts,
      ...supplementParts.map(p => p.message),
      ...ownMessages.filter(m => keepSet.has(m.messageId)),
    ].sort((a, b) => a.createTimeMs - b.createTimeMs);
    // 材料区只放"非问题内容"，避免问题原文在 prompt 里出现两次
    const materialMessages = kept.filter(m => !mustKeep.has(m.messageId));
    const primaryText = questionText;
    step('context',
      `范围 ${scope.length} 条（仅 A 的消息｜原问题${originFound ? '已定位' : '未找到'}｜前 ${backCount} + 后 ${forwardCount} + @）` +
      `｜问题内容 ${questionParts.length} 条（必留）` +
      `${supplementParts.length ? `｜补充 ${supplementParts.length} 条（必留）` : ''}` +
      `｜A 的材料 ${ownMessages.length} 条 → 相关 ${relevance.relevant.length} / 无法判断 ${relevance.uncertain.length} / 无关 ${relevance.irrelevant.length}` +
      `${relevance.degraded ? '（降级：' + relevance.degraded + '）' : ''}`,
      `保留 ID：${kept.map(m => m.messageId).join(', ')}`);
    const rendered = renderWindow(materialMessages, this.bundle.bot.openId);

    // 群里一次贴十几张截图是常见形态，总数上限放到 20 张。
    // 单张另有 10MB 上限（见 downloadImageAsDataUrl），避免一条消息把请求撑爆；
    // 服务端 /messages 的请求体限制是 50MB，20 张通常仍在范围内。
    const MAX_ATTACHMENTS = 20;
    const attachments: Array<{ name: string; dataUrl: string }> = [];
    for (const msg of kept) {
      // 不按单条消息截断：一条富文本里放好多张截图是常见形态
      for (const key of msg.resourceKeys) {
        if (attachments.length >= MAX_ATTACHMENTS) break;
        const dataUrl = await downloadImageAsDataUrl(client, msg.messageId, key).catch(() => null);
        if (dataUrl) attachments.push({ name: key, dataUrl });
      }
    }
    step('attachment', `附件：${attachments.length} 个`, attachments.map(a => a.name).join(', '));

    const question = runOpts?.continuation
      ? `客服要求继续排查（问题编号 ${issue.issueId}）。接着上一轮已经查到的进度往下做，把还没确定的部分查清楚再给结论。`
        + (supplementText ? '【客服补充】是客服在等结果期间追加的说明或证据，不是新问题，请一并考虑。' : '')
      : isNew
        ? `客服在飞书群里提出了下面这个问题（问题编号 ${issue.issueId}）。请以它为准排查，给出可直接使用的结论。`
        : supplementText
          ? `客服补充了新的信息（问题编号 ${issue.issueId}），请结合已有材料继续排查。要回答的仍是【本次问题原文】里的问题；`
            + '【客服补充】是客服在等结果期间追加的说明或证据，不是新问题。'
          : `客服补充了新的信息（问题编号 ${issue.issueId}），请结合已有材料继续排查。`;

    // 上下文已经取全，这一秒开始真正排查 —— 此时才回“已开始”，
    // 客服看到提示时模型确实在跑，而不是收到一个可能排不上队的请求。
    this.options.log?.(`开始排查 ${issue.issueId}：问题内容 ${questionParts.length} 条、${supplementParts.length ? `补充 ${supplementParts.length} 条、` : ''}材料 ${materialMessages.length} 条、保留 ${kept.length} 条，附件 ${attachments.length} 个`);
    try {
      this.monitor.saveInput(taskId, `${question}\n\n【本次问题原文】\n${primaryText}${supplementText ? `\n\n【客服补充】\n${supplementText}` : ''}\n\n【群内历史中与本次问题相关的材料】\n${rendered}`, attachments.length, kept.length, materialMessages.length);
    } catch { /* ignore */ }
    step('model', '调用模型开始排查', `问题编号 ${issue.issueId}`);
    onStarted?.();

    // 续跑时会话历史里已经有原问题，再贴一遍纯属浪费 token，
    // 只把这次说的那句话带过去（可能是"继续"，也可能附带一点补充）。
    // 带着排队补充的续查：补充（含那句"继续"）都在【客服补充】里，问题原文会话里已有，不再重复
    const promptText = runOpts?.continuation ? (supplementText ? '' : trigger.text.trim()) : primaryText;
    // 加预算必须走服务端的 /continue：它才会 extensions+1、重置时间窗、恢复原进度。
    // 只是"再发一条消息"的话冻结标记不会清，预算也不会延长。
    const normalRun = () => this.runner.run({
      issueId: issue.issueId,
      content: buildContent(rendered, attachments, question, promptText, supplementText),
      sessionId: runOpts?.sessionId ?? null,
    });
    let result: RunnerResult;
    if (runOpts?.continuation && runOpts.sessionId && this.runner.resume) {
      try {
        // 排队的补充要随续查带过去；没有补充（出结果后 @ 说继续）时调用与原来一致
        result = supplementText
          ? await this.runner.resume(runOpts.sessionId, issue.issueId, buildContent(rendered, attachments, question, promptText, supplementText))
          : await this.runner.resume(runOpts.sessionId, issue.issueId);
      } catch (error) {
        // 会话其实没冻结（上一轮正常结束了）、或续查接口不可用：
        // 退回普通追问。会话仍然是同一个，历史不会丢，只是不追加预算。
        this.options.log?.(
          `续查未生效，退回普通追问 ${issue.issueId}：${error instanceof Error ? error.message : String(error)}`,
        );
        result = await normalRun();
      }
    } else {
      result = await normalRun();
    }
    step('answer', '已生成结论', result.text.slice(0, 300));

    // 客服已经要求停止：这一轮结果一律不外发（停止回执已由 stopIssue 发出）。
    // 中断可能晚于模型返回，所以这里必须再挡一次，不能只靠 abort。
    if (issue.cancelled) {
      this.options.log?.(`结果未发群里 ${issue.issueId}：客服已要求停止`);
      holdBack?.();
      return { heldBack: false, sessionId: null, unfinished: false };
    }

    // 没查完的两种情况都要给出"继续"入口：
    //   frozen     —— 预算用尽被冻结
    //   incomplete —— 模型超时等原因，压根没形成结论
    // 只认 frozen 的话，模型超时那次客服就无路可走（线上真出现过）。
    const incompleteReason: 'budget' | 'incomplete' | null =
      result.frozen === true ? 'budget' : (result.incomplete === true ? 'incomplete' : null);

    // 记下会话 + 可继续状态：
    //   sessionId 让"继续"能接着原进度跑，而不是从零重查；
    //   frozen    让"直接 @ 说继续"能找到该续哪一条。
    if (result.sessionId) {
      try {
        this.monitor.saveIssueSession({
          originMessageId: issue.originMessageId,
          chatId: issue.chatId,
          requesterOpenId: issue.requesterOpenId,
          sessionId: result.sessionId,
        });
        this.monitor.setIssueFrozen(issue.originMessageId, incompleteReason !== null);
      } catch { /* 监控失败不影响主流程 */ }
    }

    const answerJson = JSON.stringify(result.answer ? { text: result.text, answer: result.answer } : { text: result.text });
    const sessionId = result.sessionId ?? runOpts?.sessionId ?? null;
    // 这一轮结束了（额度用完、没跑完也算）。有排队的补充就不发：客服只该收到最后一轮的结果，
    // 这一轮只记监控和日志，由 runRound 在同一会话上接着跑补充轮。
    if (holdBack?.()) {
      this.options.log?.(`本轮结果未发群里 ${issue.issueId}：有 ${issue.queuedSupplements.length} 条排队的补充，接着在同一会话上跑补充轮`);
      try { this.monitor.finish(taskId, answerJson, null); } catch { /* ignore */ }
      step('reply', '有排队的补充，本轮结果不发群里', `排队补充：${issue.queuedSupplements.map(s => s.trigger.messageId).join(', ')}`);
      return { heldBack: true, sessionId, unfinished: incompleteReason !== null };
    }

    // 群里必须带一个可点开的完整结论链接：群消息只放简短结论，
    // 完整依据和待确认项都在页面上，且链接至少要能用 24 小时。
    let shareUrl: string | null = null;
    try {
      const base = (process.env.XKANG_PUBLIC_BASE_URL || this.options.publicBaseUrl || '').replace(/\/$/, '');
      // 没查完就不发链接：客户要的是一个明确的问题「要不要继续」，
      // 而不是一份没写完的报告——链接点开也只有兜底文案，反而让人以为排查失败。
      if (base && incompleteReason === null) {
        const link = createShareLink(taskId, base);
        shareUrl = link.url;
        step('share', '已生成结论链接', `有效期至 ${link.expiresAt}`);
      }
    } catch (error) {
      this.options.log?.(`生成分享链接失败：${error instanceof Error ? error.message : String(error)}`);
    }

    // 预算用尽（frozen）：必须明确告诉客服"没查完、可以继续"，
    // 并说清怎么操作——引用这条消息回"继续"就行，不用重新描述问题。
    // 这条消息本身会被记成续查入口（safeReply 里 setIssueReply）。
    // 没查完：既不贴未完成的结论，也不给链接，只问一句要不要继续。
    // 查完了：正常结论 + 详情链接。
    const replyText = incompleteReason
      ? (result.frozen
          ? `这轮排查用完了预算（编号 ${issue.issueId}），问题还没有查清。`
          : `这轮排查没有跑完（编号 ${issue.issueId}），问题还没有查清。`) + buildContinueHint(incompleteReason)
      : (shareUrl ? `${result.text}\n\n完整结论：${shareUrl}` : result.text);
    await this.safeReply(issue, trigger, replyText, 'final');
    try {
      this.monitor.finish(taskId, answerJson, null);
    } catch { /* ignore */ }
    step('reply', '已回复群消息', shareUrl ?? '无链接');
    return { heldBack: false, sessionId, unfinished: incompleteReason !== null };
  }

  /**
   * 取原问题的作者 open_id。
   *
   * 原消息就是当前消息时（直接 @ 提问），作者即发起人，不必额外查询。
   * 原消息是别人发的时，需要单独取一次；取不到返回 null，回复时只 @ 发起人，
   * 不能因为查不到就把 @ 列表写错。
   */
  /**
   * 查一条消息是谁发的，并区分它是不是机器人。
   *
   * 用途：判断"被引用的那条"是不是本系统发过的结论。机器人发的原消息不能当问题，
   * 否则引用链会一层层挂在机器人消息上，越漂越远。
   */
  private async getMessageSenderInfo(messageId: string): Promise<{ openId: string | null; isBot: boolean } | null> {
    try {
      const item = await getMessage(this.bundle.client, messageId) as Record<string, unknown> | null;
      if (!item) return null;
      const sender = item.sender as Record<string, unknown> | undefined;
      return {
        openId: String(sender?.id ?? '') || null,
        isBot: String(sender?.sender_type ?? '') === 'app',
      };
    } catch {
      return null;
    }
  }

  /** 不带问题的直接提示：用于拒绝/告知，不建任务也不记监控 */
  private async replyPlain(trigger: FeishuMessageSummary, text: string): Promise<void> {
    try {
      await replyToMessage(this.bundle.client, {
        messageId: trigger.messageId,
        openIds: [trigger.senderOpenId ?? ''].filter(Boolean),
        text,
        idempotencyKey: `notice-${trigger.messageId}-${fingerprint(text)}`.slice(0, 50),
        botOpenId: this.bundle.bot.openId,
      });
    } catch (error) {
      this.options.log?.(`发送提示失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async resolveOriginAuthor(chatId: string, originMessageId: string, fallbackOpenId: string): Promise<string | null> {
    try {
      const item = await getMessage(this.bundle.client, originMessageId) as Record<string, unknown> | null;
      if (!item) return null;
      const sender = item.sender as Record<string, unknown> | undefined;
      const senderType = String(sender?.sender_type ?? '');
      // 机器人发的原消息不作为“当事人”@ 回来
      if (senderType === 'app') return null;
      return String(sender?.id ?? '') || null;
    } catch {
      return fallbackOpenId;
    }
  }

  /** 拉取 trigger 之前的群历史（含 trigger 本身），最多 maxScan 条 */
  private async loadTimeline(chatId: string, untilMs: number): Promise<FeishuMessageSummary[]> {
    const maxScan = this.options.maxScanMessages ?? 400;
    const collected: FeishuMessageSummary[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < Math.ceil(maxScan / 50); page++) {
      const data = await listChatMessages(this.bundle.client, chatId, pageToken, 50);
      const items = (data.items ?? []) as Array<Record<string, unknown>>;
      if (!items.length) break;
      for (const item of items) {
        const summary = this.summarizeItem(item);
        if (summary.createTimeMs > untilMs) continue;
        collected.push(summary);
        if (collected.length >= maxScan) break;
      }
      if (!data.has_more || collected.length >= maxScan) break;
      pageToken = data.page_token as string | undefined;
      if (!pageToken) break;
    }
    return collected.sort((a, b) => a.createTimeMs - b.createTimeMs);
  }

  /** 历史接口 / 单条接口返回的消息 → 摘要（两处同一口径） */
  private summarizeItem(item: Record<string, unknown>): FeishuMessageSummary {
    return toSummary({
      message_id: item.message_id as string,
      sender_id: String((item.sender as Record<string, unknown> | undefined)?.id ?? ''),
      sender_type: String((item.sender as Record<string, unknown> | undefined)?.sender_type ?? ''),
      create_time: item.create_time as string,
      msg_type: item.msg_type as string,
      text: this.extractText(item),
      parent_id: item.parent_id as string,
      root_id: item.root_id as string,
      thread_id: item.thread_id as string,
    }, this.extractKeys(item));
  }

  /** 单独取一条消息（时间线里找不到时用）；取不到返回 null，不影响排查 */
  private async fetchSummary(messageId: string): Promise<FeishuMessageSummary | null> {
    try {
      const item = await getMessage(this.bundle.client, messageId) as Record<string, unknown> | null;
      return item ? this.summarizeItem(item) : null;
    } catch {
      return null;
    }
  }

  /**
   * 原问题还没出结果时并入的补充：问题内容只认原问题（原消息 + 建问题的那次 @），
   * 每次补充的 @ 和它引用的那条按顺序放进 out（【客服补充】）。
   *
   * 被引用的那条可能是别人发的、也可能早于 30 分钟，范围（只收 A 的话）里不一定有，
   * 所以按 ID 在整段时间线里找，找不到再单独取一次。原问题同理。
   */
  private async collectSupplements(
    issue: Issue,
    chain: Issue['queuedSupplements'],
    timeline: FeishuMessageSummary[],
    out: Array<{ message: FeishuMessageSummary; quoted: boolean }>,
  ): Promise<{ mustKeep: Set<string>; questionParts: FeishuMessageSummary[] }> {
    const byId = new Map(timeline.map(m => [m.messageId, m] as const));
    const lookup = async (id: string) => byId.get(id) ?? await this.fetchSummary(id);
    const mustKeep = new Set([issue.originMessageId, issue.firstTriggerId]);
    const questionParts: FeishuMessageSummary[] = [];
    for (const id of mustKeep) {
      const found = await lookup(id);
      if (found) questionParts.push(found);
    }
    for (const { trigger, quotedId } of chain) {
      if (!mustKeep.has(trigger.messageId)) {
        mustKeep.add(trigger.messageId);
        // 时间线里那份带图片 key，事件里那份没有
        out.push({ message: byId.get(trigger.messageId) ?? trigger, quoted: false });
      }
      // 引用的是原问题或之前的补充时已经在里面了，不重复
      if (quotedId && !mustKeep.has(quotedId)) {
        mustKeep.add(quotedId);
        const found = await lookup(quotedId);
        if (found) out.push({ message: found, quoted: true });
      }
    }
    return { mustKeep, questionParts };
  }

  /** 【客服补充】：每次补充的 @ 一行，它引用的那条紧跟其后并标明是被引用的 */
  private renderSupplements(parts: Array<{ message: FeishuMessageSummary; quoted: boolean }>, requesterOpenId: string): string {
    return parts.map(({ message: m, quoted }) => {
      const stamp = new Date(m.createTimeMs).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
      const who = m.senderType === 'app' || m.senderType === 'bot'
        ? '机器人'
        : (m.senderOpenId === requesterOpenId ? '客服' : '群内其他人');
      const body = m.text || (m.resourceKeys.length ? `[附件 ${m.resourceKeys.length} 个]` : '[空消息]');
      return `${quoted ? '  └ 上面这次 @ 引用的消息：' : ''}[${stamp}] ${who}：${body}`;
    }).join('\n');
  }

  /**
   * 把飞书消息的 content 转成纯文本。
   * 文本/富文本按 JSON 取；图片消息本身没有正文，正文由附件承载。
   */
  /**
   * 从消息里取纯文本。
   *
   * 两个来源形态不同，必须分开处理：
   * - **历史接口**：body.content 是 JSON 字符串，如 {"text":"..."}；
   * - **事件推送**：content 已经是纯文本（@ 已还原成显示名），不是 JSON。
   *
   * 之前的写法对两者都先 JSON.parse 再取 .text，遇到事件文本刚好是合法 JSON
   * （例如整段以订单号开头、内容形如一个数字）时，parse 成功但没有 .text 字段，
   * 于是返回空串——表现为「本次问题原文」为空、整条问题丢失。
   */
  private extractText(item: Record<string, unknown>): string {
    const bodyContent = (item.body as Record<string, unknown> | undefined)?.content;
    const contentField = item.content;

    // 历史接口：body.content 一定是 JSON 字符串
    if (typeof bodyContent === 'string' && bodyContent.trim()) {
      const parsed = this.tryParseJsonObject(bodyContent);
      if (parsed) {
        // 解析成功就以解析结果为准：text 为空表示这条消息只有 @，
        // 属于正常情况，不能回落成 {"text":"…"} 这种原始 JSON。
        return this.textFromParsed(parsed);
      }
      // 解析不出结构化字段（不是 JSON）才把原文当文本，不要丢
      return this.cleanMentions(bodyContent);
    }

    // 事件推送：content 是纯文本，直接使用，绝不 parse
    if (typeof contentField === 'string') {
      const trimmed = contentField.trim();
      if (!trimmed) return '';
      // 只有看起来像 JSON 对象时才尝试解析（兼容旧版本或个别消息类型）
      const parsed = trimmed.startsWith('{') ? this.tryParseJsonObject(trimmed) : null;
      if (parsed) return this.textFromParsed(parsed);
      return this.cleanMentions(trimmed);
    }

    return '';
  }

  /** 只解析对象，数组/数字/字符串等一律返回 null，避免把普通文本当成 JSON */
  private tryParseJsonObject(raw: string): Record<string, unknown> | null {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  /** 从已解析的对象里取正文：纯文本消息取 text，富文本取 content 数组 */
  private textFromParsed(parsed: Record<string, unknown>): string {
    // 有 text 字段就以它为准，即使清洗后为空——那说明这条消息本来就只有 @，
    // 属于“叫一下机器人”，不能因此把整段原始 JSON 当正文暴露给模型。
    if (typeof parsed.text === 'string') return this.cleanMentions(parsed.text);
    const post = parsed.content;
    if (Array.isArray(post)) {
      return this.cleanMentions(post.flat().map((node: unknown) => {
        const n = node as Record<string, unknown>;
        return typeof n.text === 'string' ? n.text : '';
      }).join(''));
    }
    return '';
  }

  /** 去掉 @_user_N 占位符与多余空白 */
  private cleanMentions(text: string): string {
    return text.replace(/@_user_\d+/g, '').replace(/\u200b/g, '').trim();
  }

  private extractKeys(item: Record<string, unknown>): string[] {
    const msgType = String(item.msg_type ?? '');
    if (msgType !== 'image' && msgType !== 'file' && msgType !== 'post') return [];
    const raw = typeof (item.body as Record<string, unknown> | undefined)?.content === 'string'
      ? String((item.body as Record<string, unknown>).content)
      : typeof item.content === 'string' ? String(item.content) : '';
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

    // 富文本(post)：图片键嵌套在 content 二维数组的 img 节点里。
    // 旧实现排除 post 且只读顶层 image_key，导致富文本里的截图全部丢失。
    if (msgType === 'post') {
      const keys: string[] = [];
      const rows = (parsed as Record<string, unknown>).content;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (!Array.isArray(row)) continue;
          for (const node of row) {
            if (!node || typeof node !== 'object') continue;
            const tag = (node as Record<string, unknown>).tag;
            const key = (node as Record<string, unknown>).image_key;
            if (tag === 'img' && typeof key === 'string' && key) keys.push(key);
          }
        }
      }
      return keys;
    }

    const key = (parsed as Record<string, unknown>).image_key ?? (parsed as Record<string, unknown>).file_key;
    return typeof key === 'string' && key ? [key] : [];
  }

  /**
   * 立即回执：不阻塞事件处理，失败只记日志。
   * 客服感知的是“发出去几秒内被 @ 回来”，所以这里不等任何后续步骤。
   */
  /**
   * 客服要求停止：中断服务端正在跑的那一轮，作废排队的补充，结果一律不外发。
   *
   * 为什么必须真中断而不是“只是不回”：模型还在烧预算，而且冻结态会让下一次
   * “继续”接手一个跑偏的进度。停就要停干净。
   */
  private async stopIssue(
    issue: Issue,
    trigger: FeishuMessageSummary,
    degraded?: string,
  ): Promise<void> {
    issue.cancelled = true;
    const sessionId = this.monitor.getIssue(issue.originMessageId)?.sessionId ?? null;
    const aborted = sessionId && this.runner.abort
      ? await this.runner.abort(sessionId).catch(() => false)
      : false;
    // 停了就不该再跑排队的补充
    issue.queuedSupplements = [];
    if (issue.activeTaskId) {
      try { this.monitor.fail(issue.activeTaskId, '客服要求停止，本轮已中断'); } catch { /* 监控失败不影响主流程 */ }
    }
    // 中断的一轮不构成“可以继续”的进度
    try { this.monitor.setIssueFrozen(issue.originMessageId, false); } catch { /* ignore */ }
    const text = aborted
      ? `已停止这一轮排查（编号 ${issue.issueId}）。已查到的内容没有发到群里，需要时重新 @我 发起即可。`
      : `收到停止要求（编号 ${issue.issueId}）。这一轮不会再把结论发到群里，需要时重新 @我 发起即可。`;
    await this.replyPlain(trigger, text).catch(() => { /* 回执失败不影响中断 */ });
    this.options.log?.(
      `客服要求停止 ${issue.issueId}：服务端中断=${aborted}${degraded ? `｜${degraded}` : ''}`,
    );
  }
  private ack(issue: Issue, trigger: FeishuMessageSummary, text: string, perTrigger = false): void {
    // 回执与最终结论用不同用途，否则共用一个 uuid 会被飞书去重吞掉
    void this.safeReply(issue, trigger, text, 'ack', perTrigger);
  }

  /**
   * 回复原消息。
   *
   * uuid 必须按“这条消息的用途”区分，不能只用 issue+trigger：
   * 飞书同一个 uuid 一小时内只允许成功回复一条，之前回执和最终结论共用同一个
   * uuid，结果只有第一条能发出去，后面的全被服务端去重吞掉（表现为“排查完成了
   * 但群里没收到回复”）。这里用 issue+trigger+用途 生成，并把文本摘要纳入，
   * 保证同一用途的重复调用（网络重试）仍然幂等，不同用途各自独立。
   */
  private async safeReply(
    issue: Issue,
    trigger: FeishuMessageSummary,
    text: string,
    purpose = 'final',
    /**
     * 指纹里带上触发消息：同一问题的每次补充回执文案完全一样（"已收到补充信息（编号 X）…"），
     * 只按内容算会被飞书当成重复请求，第二次补充起就收不到回执。
     */
    perTrigger = false,
  ): Promise<void> {
    try {
      // 同时 @ 发起人和原问题作者：两人可能是不同的人，缺一个就有人收不到结论。
      const openIds = [issue.requesterOpenId, issue.originAuthorOpenId ?? ''].filter(Boolean);
      const replyMessageId = await replyToMessage(this.bundle.client, {
        messageId: trigger.messageId,
        openIds,
        text,
        // uuid 上限 50 字符；用用途 + 内容指纹保证“同一条内容幂等、不同内容各自发送”
        idempotencyKey: `${issue.issueId}-${purpose}-${fingerprint(perTrigger ? `${trigger.messageId}\n${text}` : text)}`.slice(0, 50),
        botOpenId: this.bundle.bot.openId,
      });
      // 结论/失败消息要被记住：客服在它下面回复"继续"时，
      // 靠这个 ID 才能认出"引用的是我们的结论"，从而复用会话加预算。
      if (replyMessageId && (purpose === 'final' || purpose === 'failed')) {
        try { this.monitor.setIssueReply(issue.originMessageId, replyMessageId); } catch { /* ignore */ }
      }
      this.options.log?.(`已回复 ${issue.issueId}（${purpose}）${replyMessageId ? ' id=' + replyMessageId : ''}`);
    } catch (error) {
      this.options.log?.(`回复飞书消息失败 ${issue.issueId}（${purpose}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
