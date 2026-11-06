import type { Message, MessageContentPart } from '@xkang/agent-core';

/**
 * 飞书群消息 → xkang 输入。
 *
 * 这里只做“把群里的东西整理成一次排查输入”，不判断业务对错、不调模型。
 * 关键边界（都有实测或官方文档依据）：
 * - 只处理显式 @ 当前机器人的消息，其余消息即使被推送也不建任务；
 * - 上下文区间 = 原问题之前 N 条 → 原问题 → 本次 @（含），之后不再延伸；
 * - 先按发送者过滤，再交给 Jev 做相关性筛选；原问题与本次 @ 永不丢弃。
 */

export interface FeishuMessageSummary {
  messageId: string;
  senderOpenId: string | null;
  senderType: string | null;
  createTimeMs: number;
  msgType: string;
  /** 已渲染成纯文本的正文（飞书事件与历史接口的 content 形态不同，调用方负责归一） */
  text: string;
  /** 图片/文件等资源的 key，用于后续下载 */
  resourceKeys: string[];
  parentId?: string | null;
  rootId?: string | null;
  threadId?: string | null;
  mentions: Array<{ openId: string | null; name: string | null; mentionedType: string | null }>;
}

export interface ContextWindowOptions {
  /** 原问题之前取多少条群消息（默认 20） */
  beforeCount?: number;
  /** 单次会话最多回看多少条，防止超长话题把内存打满（默认 400） */
  maxScan?: number;
}

export interface BuiltContext {
  /** 送进模型的消息内容 */
  content: MessageContentPart[];
  /** 记录用了哪些消息，便于回查与复现 */
  usedMessageIds: string[];
  /** 被 Jev 判为无关而剔除的消息 ID */
  droppedMessageIds: string[];
  /** 实际取到的窗口大小（不足时如实记录，不假装取满） */
  windowSize: number;
  originMessageId: string;
  triggerMessageId: string;
}

/** 从飞书事件/历史消息里抽出统一结构；content 的解析规则集中在调用方，这里只做兜底 */
export function toSummary(input: {
  message_id?: string; messageId?: string;
  sender?: { id?: string; sender_type?: string } | null;
  sender_id?: string; sender_type?: string;
  create_time?: string | number; createTime?: string | number;
  msg_type?: string; message_type?: string;
  content?: string; text?: string;
  parent_id?: string; root_id?: string; thread_id?: string;
  mentions?: Array<{ id?: { open_id?: string } | string; id_type?: string; open_id?: string; name?: string; mentioned_type?: string }>;
}, resourceKeys: string[] = []): FeishuMessageSummary {
  const rawCreate = input.create_time ?? input.createTime ?? 0;
  const createTimeMs = Number(rawCreate) > 1e12 ? Number(rawCreate) : Number(rawCreate) * 1000;
  return {
    messageId: String(input.message_id ?? input.messageId ?? ''),
    senderOpenId: input.sender?.id ?? input.sender_id ?? null,
    senderType: input.sender?.sender_type ?? input.sender_type ?? null,
    createTimeMs: Number.isFinite(createTimeMs) ? createTimeMs : 0,
    msgType: String(input.msg_type ?? input.message_type ?? 'text'),
    text: String(input.text ?? '').trim(),
    resourceKeys,
    parentId: input.parent_id ?? null,
    rootId: input.root_id ?? null,
    threadId: input.thread_id ?? null,
    // 历史接口返回的 mentions 是 { id: "ou_xxx", id_type: "open_id" }，
    // 事件推送返回的是 { id: { open_id: "ou_xxx" } }。两种都要认，否则 @ 永远匹配不上。
    mentions: (input.mentions ?? []).map(m => ({
      openId: typeof m.id === 'string' ? m.id : (m.id?.open_id ?? m.open_id ?? null),
      name: m.name ?? null,
      mentionedType: m.mentioned_type ?? (m.id_type ? 'open_id' : null),
    })),
  };
}

/**
 * 判断这条消息是否在“显式 @ 本机器人”。
 *
 * 必须看结构化的 mentions，不能匹配正文里的“@小康客服助手”：
 * 正文里的 @ 可能只是引用文本、可能是别人转述，也可能是被转发内容的一部分。
 */
export function mentionsBot(msg: FeishuMessageSummary, botOpenId: string): boolean {
  return msg.mentions.some(m => m.openId === botOpenId || (m.mentionedType === 'bot' && m.openId === botOpenId));
}

/**
 * 确定“原问题”是哪一条。
 *
 * 普通回复场景 parent_id 就是被回复的那条，可以信；
 * 话题内回复时 parent_id 指向话题根，此时无法还原任意楼层——这种情况明确降级为“用话题根”，
 * 并在返回里标注，避免静默归错单。
 */
export function resolveOrigin(
  trigger: FeishuMessageSummary,
): { originMessageId: string; anchorKind: 'self' | 'parent' | 'thread-root'; degraded: boolean } {
  if (trigger.parentId && trigger.parentId !== trigger.messageId) {
    const degraded = Boolean(trigger.threadId) && trigger.parentId === trigger.rootId;
    return { originMessageId: trigger.parentId, anchorKind: degraded ? 'thread-root' : 'parent', degraded };
  }
  return { originMessageId: trigger.messageId, anchorKind: 'self', degraded: false };
}


/** 历史时间的默认窗口（分钟）。往前 20 条、往后 30 分钟都用这个值。 */
export const DEFAULT_HISTORY_MINUTES = 30;

export interface ScopeOptions {
  /** 往前多少分钟（含） */
  backMinutes?: number;
  /** 往前最多取多少条 */
  backCount?: number;
  /** 往后多少分钟（含），以原问题为起点 */
  forwardMinutes?: number;
  /**
   * 只统计这个人的消息（作用于 ② 和 ③）。
   *
   * 范围里只该有当事人 A 的话：群里其他人（含来 @ 的 B）的发言不进范围，
   * 否则"最近 20 条"会被别人的闲聊占满，A 的真实上下文被挤掉。
   * ④ 的 @ 当条不受这个限制。
   */
  senderOpenId?: string | null;
}

/**
 * 取问题范围（用户口径）。
 *
 *   ① 被引用的那条（原问题）本身
 *   ② 原问题往前 30 分钟内的**最近 20 条**
 *   ③ 原问题 → 本次 @ 之间，距原问题 30 分钟内的所有会话
 *   ④ 本次 @ 当条（无论来自 A 还是 B）
 *
 * ③ 的上界取 min(原问题+30分钟, @时间)：
 *   原问题之后太久远的话已经是另一件事，而 @ 本身永远是终点。
 *   ④ 单独补进来，保证「引用很久以前的旧问题、今天才 @」时 @ 仍在范围内。
 */
export function buildScope(
  timeline: FeishuMessageSummary[],
  originMessageId: string,
  trigger: FeishuMessageSummary,
  options: ScopeOptions = {},
): { scope: FeishuMessageSummary[]; originFound: boolean; backCount: number; forwardCount: number } {
  const backMinutes = options.backMinutes ?? DEFAULT_HISTORY_MINUTES;
  const backCount = options.backCount ?? 20;
  const forwardMinutes = options.forwardMinutes ?? DEFAULT_HISTORY_MINUTES;
  const sorted = [...timeline].sort((a, b) => a.createTimeMs - b.createTimeMs);
  const origin = sorted.find(m => m.messageId === originMessageId);
  if (!origin) {
    return { scope: [trigger], originFound: false, backCount: 0, forwardCount: 0 };
  }

  const onlyFrom = options.senderOpenId ?? null;
  const fromSubject = (m: FeishuMessageSummary) => !onlyFrom || m.senderOpenId === onlyFrom;

  // ② 往前：时间窗内、只算当事人自己说的、且只取最近 N 条
  const backFloor = origin.createTimeMs - backMinutes * 60_000;
  const backwards = sorted
    .filter(m => m.createTimeMs < origin.createTimeMs && m.createTimeMs >= backFloor)
    .filter(fromSubject)
    .slice(-backCount);

  // ③ 往后：原问题起、到 min(原问题+N分钟, @时间) 止，同样只算当事人自己说的
  const upper = Math.min(origin.createTimeMs + forwardMinutes * 60_000, trigger.createTimeMs);
  const forwards = sorted
    .filter(m => m.createTimeMs >= origin.createTimeMs && m.createTimeMs <= upper)
    .filter(fromSubject);

  // ④ 合并去重；@ 当条一定在
  const seen = new Set<string>();
  const scope: FeishuMessageSummary[] = [];
  for (const m of [...backwards, ...forwards, trigger]) {
    if (seen.has(m.messageId)) continue;
    seen.add(m.messageId);
    scope.push(m);
  }
  scope.sort((a, b) => a.createTimeMs - b.createTimeMs);
  return { scope, originFound: true, backCount: backwards.length, forwardCount: forwards.length };
}

/**
 * 从群时间线里截出 [原问题前 N 条 … 本次 @] 的窗口。
 *
 * timeline 必须按时间升序传入（调用方负责排序）。找不到原问题时返回空窗口，
 * 由调用方决定是提示客服重发还是退回只用本次消息。
 */
export function buildWindow(
  timeline: FeishuMessageSummary[],
  originMessageId: string,
  trigger: FeishuMessageSummary,
  options: ContextWindowOptions = {},
): { window: FeishuMessageSummary[]; truncated: boolean; originFound: boolean } {
  const beforeCount = options.beforeCount ?? 20;
  const maxScan = options.maxScan ?? 400;
  const sorted = [...timeline].sort((a, b) => a.createTimeMs - b.createTimeMs);
  const originIndex = sorted.findIndex(m => m.messageId === originMessageId);
  if (originIndex < 0) {
    return { window: [trigger], truncated: false, originFound: false };
  }
  const startIndex = Math.max(0, originIndex - beforeCount);
  const truncated = originIndex - startIndex < beforeCount;
  // 截点固定在本次 @ 的发送时间：之后的消息一律不取，避免把后续讨论混进来
  const cutoff = trigger.createTimeMs;
  const window = sorted
    .slice(startIndex)
    .filter(m => m.createTimeMs <= cutoff || m.messageId === trigger.messageId)
    .slice(0, maxScan);
  return { window, truncated: truncated, originFound: true };
}

/**
 * 先按发送者过滤：只保留发起客服自己的消息，外加原问题与本次 @ 两条。
 *
 * 注意顺序：必须先截窗口再过滤。若先过滤再凑“客服的 20 条”，会把窗口扩到窗口之外。
 */
export function filterBySender(
  window: FeishuMessageSummary[],
  requesterOpenId: string,
  mustKeep: string[],
): { kept: FeishuMessageSummary[]; dropped: FeishuMessageSummary[] } {
  return filterBySenders(window, new Set([requesterOpenId]), mustKeep);
}

/**
 * 多发送者版本的过滤。
 *
 * 为什么需要多个：原问题作者和发起 @ 的人可能不是同一个（A 发问题、B 来 @），
 * 只留一个人会把另一方提供的材料整段丢掉。
 */
export function filterBySenders(
  window: FeishuMessageSummary[],
  allowedOpenIds: ReadonlySet<string>,
  mustKeep: string[],
): { kept: FeishuMessageSummary[]; dropped: FeishuMessageSummary[] } {
  const keepSet = new Set(mustKeep);
  const kept: FeishuMessageSummary[] = [];
  const dropped: FeishuMessageSummary[] = [];
  for (const msg of window) {
    const allowed = msg.senderOpenId !== null && allowedOpenIds.has(msg.senderOpenId);
    const passes = allowed || keepSet.has(msg.messageId);
    if (!passes) { dropped.push(msg); continue; }
    // 清洗后既没有正文也没有附件（系统提示、空文本、无法解析的消息）不进上下文：
    // 这些行对模型没有任何信息量，只会占用上下文并稀释真正的证据。
    // 例外：原问题与本次 @ 必须保留，否则窗口的定位依据会消失。
    if (!msg.text && !msg.resourceKeys.length && !keepSet.has(msg.messageId)) {
      dropped.push(msg);
      continue;
    }
    kept.push(msg);
  }
  return { kept, dropped };
}

/** 把窗口渲染成给模型看的一段上下文，保留时间与发言人，去掉内部 ID 噪音 */
export function renderWindow(messages: FeishuMessageSummary[], botOpenId: string): string {
  const lines = messages.map(m => {
    const who = m.senderType === 'bot' ? '机器人' : '客服';
    const stamp = new Date(m.createTimeMs).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    const body = m.text || (m.resourceKeys.length ? `[附件 ${m.resourceKeys.length} 个]` : '[空消息]');
    return `[${stamp}] ${who}：${body}`;
  });
  return lines.join('\n');
}

/**
 * 组装送进 xkang 的 content 数组。
 *
 * 结构上把“本次要问的问题”和“补充材料”分开写：
 * 问题是主体，历史材料只是参考。之前把两者混成一段，模型分不清哪个才是要回答的，
 * 会转去答历史里更显眼的旧问题。
 */
export function buildContent(
  rendered: string,
  attachments: Array<{ name: string; dataUrl: string }>,
  userQuestion: string,
  primaryText?: string,
  /**
   * 原问题还没出结果时客服追加的话（及其引用的那条）。单独成段、排在问题原文之后：
   * 它们是补充，不是问题本身——混进问题原文里，模型会转去回答补充的那句话。
   */
  supplementText?: string,
): MessageContentPart[] {
  const sections: string[] = [userQuestion];
  if (primaryText && primaryText.trim()) {
    sections.push('【本次问题原文】', primaryText.trim());
  }
  if (supplementText && supplementText.trim()) {
    sections.push('【客服补充】', supplementText.trimEnd());
  }
  if (rendered.trim()) {
    sections.push('【群内历史中与本次问题相关的材料】', rendered);
  }
  const parts: MessageContentPart[] = [{ type: 'text', text: sections.join('\n\n') }];
  for (const a of attachments) parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
  return parts;
}

/** 给客服的简短回执：不暴露内部排查过程，只说明已收到 */
export function ackText(issueId: string, queued: boolean): string {
  return queued
    ? `已收到（编号 ${issueId}），当前排队中，前面还有任务在处理，轮到后立刻开始排查。`
    : `已收到（编号 ${issueId}），正在排查，完成后在这里回复您。`;
}
