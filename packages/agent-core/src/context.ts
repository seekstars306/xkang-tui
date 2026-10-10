import { Message } from './types.js';

/** 单条工具结果进入上下文的最大字符数（各工具自身已控制在约 16k 以内，这里是兜底） */
export const TOOL_RESULT_CHAR_LIMIT = 20000;
/** 估算 token 超过该值时开始分级压缩上下文 */
export const COMPACTION_TOKEN_THRESHOLD = 100000;
const KEEP_RECENT_TOOL_RESULTS = 8;
const KEEP_RECENT_USER_TURNS = 2;
const OLD_ANSWER_MAX_CHARS = 2000;

const REMINDER_OPEN = '<system-reminder>';
const REMINDER_CLOSE = '</system-reminder>';
// 旧版本直接以普通用户消息注入的提醒，历史会话里仍然存在
const LEGACY_REMINDER_PREFIXES = ['【系统提醒】', '【通道降级提醒】', '【排查提示】', '【取证盲区提醒】', '请根据前面工具调用的检索结果', '你刚才只是用文字', '[[ESCALATE_TO_L2]]'];

export function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
  }
  return '';
}

/**
 * harness 的提醒/纠偏仍以 user 角色发送（服务端会把中途的 system 消息挪到最前面），
 * 但用 <system-reminder> 包裹并说明不是客服输入，避免模型把它当成客服的原话。
 */
export function wrapReminder(text: string): Message {
  return {
    role: 'user',
    content: `${REMINDER_OPEN}\n（以下是排障系统自动给出的提示，不是客服的输入）\n${text}\n${REMINDER_CLOSE}`,
    isReminder: true,
  };
}

export function isReminderMessage(m: Message): boolean {
  if (m.role !== 'user') return false;
  if (m.isReminder) return true;
  const t = typeof m.content === 'string' ? m.content.trimStart() : '';
  return t.startsWith(REMINDER_OPEN) || LEGACY_REMINDER_PREFIXES.some((p) => t.startsWith(p));
}

/** 超长工具结果按行截断，并明确告诉模型后面还有多少没显示 */
export function clampToolResult(text: string, limit = TOOL_RESULT_CHAR_LIMIT, toolCallId?: string): string {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const lastNl = slice.lastIndexOf('\n');
  const kept = lastNl > limit * 0.5 ? slice.slice(0, lastNl) : slice;
  const rest = text.slice(kept.length);
  const restLines = rest.split('\n').filter(Boolean).length;
  const recovery = toolCallId ? `可用 read_tool_result(toolCallId=${JSON.stringify(toolCallId)}, offset=${kept.length}) 读取本次返回的剩余原文。` : '';
  return `${kept}\n…[系统提示：工具结果过长，后面还有约 ${rest.length} 个字符（${restLines} 行）未显示，以上内容不完整。${recovery}源查询本身未返回的数据仍需缩小范围或分页查询，不要把这部分当成全部结果]`;
}

/** 仅依据工具显式的完整性元数据和本地裁剪记录，不按业务词猜测。 */
export function hasIncompleteToolResult(message: Message): boolean {
  if (message.raw_tool_result !== undefined) return true;
  try {
    const result = JSON.parse(stripHarnessAnnotations(messageText(message)));
    return result?.complete === false || result?.truncated === true;
  } catch {
    return false;
  }
}

const FAILURE_PREFIX = /^(工具执行失败|工具 \[.*\] 执行超时|错误[:：]|搜索执行错误|代码检索超时|日志查询失败|获取应用列表失败|Git 查询失败|读取文件失败|互联网搜索(失败|不可用)|【CodeGraph 查询失败】|【单号定位失败】|操作参数预检失败|服务端未配置|安全拦截|【安全拦截】)/;

/** 去掉 harness 加在工具结果前面的标注（如重复调用提示），再判断工具结果本身 */
function stripHarnessAnnotations(content: string): string {
  return (content || '').replace(/^【重复调用提示】[^\n]*\n/, '').trim();
}

/** 工具结果是否为失败（报错、超时、未执行），用于判断一轮排查是否拿到了任何真实数据 */
export function isFailedToolResult(content: string): boolean {
  const t = stripHarnessAnnotations(content);
  if (!t) return true;
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t);
      if (o && (o.status === 'error' || o.status === 'security_violation')) return true;
      return false;
    } catch {
      // 不是完整 JSON（可能被截断），按文本判断
    }
  }
  return FAILURE_PREFIX.test(t);
}

/** 数据库通道级故障（超时/断连），用于提示模型切换排查通道 */
export function isDbChannelFailure(content: string): boolean {
  const t = stripHarnessAnnotations(content);
  if (!t.startsWith('{')) return /^工具 \[company_db_query\] 执行超时/.test(t);
  try {
    const o = JSON.parse(t);
    return o?.status === 'error' && /超时|ECONNRESET|EPIPE|PROTOCOL_CONNECTION_LOST|获取数据库连接/i.test(String(o.message || ''));
  } catch {
    return false;
  }
}

export function estimateTokens(messages: Message[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') totalChars += part.text.length;
        else if (part.type === 'image_url') totalChars += 2000;
      }
    }
    if (msg.reasoning_content) totalChars += msg.reasoning_content.length;
    for (const tc of msg.tool_calls || []) {
      totalChars += (tc.name || '').length;
      totalChars += typeof tc.arguments === 'string' ? tc.arguments.length : JSON.stringify(tc.arguments || {}).length;
    }
  }
  // 中英混排 + 代码，约 2.5 字符/token 的保守估算
  return Math.ceil(totalChars / 2.5);
}

function stripImages(m: Message): Message {
  if (!Array.isArray(m.content)) return m;
  const hasImage = m.content.some((p) => p.type === 'image_url');
  if (!hasImage) return m;
  const text = m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return { ...m, content: `${text}\n[早期截图已从上下文中省略]` };
}

function isRealUser(m: Message): boolean {
  return m.role === 'user' && !isReminderMessage(m);
}

export interface CompactionResult {
  messages: Message[];
  stage: 0 | 1 | 2 | 3;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * 分级压缩上下文（以前超过阈值就把最早的一整轮连同原始问题直接删掉，且不做摘要）：
 * 1. 把较早的工具结果压缩成摘录（保留最近若干条完整结果）；
 * 2. 更早的轮次只保留客服问题和最终回答，去掉中间的工具调用与截图；
 * 3. 仍超出时删除中间的早期轮次，但永远保留会话的第一个问题（原始任务）。
 * 每一步都保持 assistant.tool_calls 与 tool 结果成对，不产生孤立消息。
 */
export function compactMessages(messages: Message[], threshold = COMPACTION_TOKEN_THRESHOLD): CompactionResult {
  const beforeTokens = estimateTokens(messages);
  if (beforeTokens <= threshold) {
    return { messages, stage: 0, beforeTokens, afterTokens: beforeTokens };
  }

  // Stage 1：压缩较早的工具结果
  let msgs: Message[] = messages.map((m) => ({ ...m }));
  const toolIdxs = msgs.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIdxs.slice(0, Math.max(0, toolIdxs.length - KEEP_RECENT_TOOL_RESULTS))) {
    const text = messageText(msgs[i]);
    if (text.length > 600 && !text.startsWith('[已压缩')) {
      msgs[i] = {
        ...msgs[i],
        raw_tool_result: msgs[i].raw_tool_result ?? text,
        content: `[已压缩的早期工具结果 ${msgs[i].name || ''}，原文 ${(msgs[i].raw_tool_result ?? text).length} 字符。用 read_tool_result(toolCallId=${JSON.stringify(msgs[i].tool_call_id)}) 按需读取原文；以下摘录不能证明中间不存在其他分支或数据]\n${text.slice(0, 400)}…\n[末尾摘录]\n${text.slice(-200)}`,
      };
    }
  }
  let tokens = estimateTokens(msgs);
  if (tokens <= threshold) {
    return { messages: msgs, stage: 1, beforeTokens, afterTokens: tokens };
  }

  // Stage 2：较早的轮次只保留客服问题与最终回答
  const realUserIdxs = msgs.map((m, i) => (isRealUser(m) ? i : -1)).filter((i) => i >= 0);
  if (realUserIdxs.length > KEEP_RECENT_USER_TURNS) {
    const recentStart = realUserIdxs[realUserIdxs.length - KEEP_RECENT_USER_TURNS];
    const out: Message[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (i >= recentStart || m.role === 'system') {
        out.push(m);
      } else if (m.role === 'user') {
        if (!isReminderMessage(m)) out.push(stripImages(m));
      } else if (m.role === 'assistant' && !(m.tool_calls && m.tool_calls.length > 0)) {
        const t = messageText(m);
        out.push({ ...m, content: t.length > OLD_ANSWER_MAX_CHARS ? t.slice(0, OLD_ANSWER_MAX_CHARS) + '…[早期回答已截断]' : t });
      }
      // 早期的 tool_call 请求与 tool 结果成对丢弃
    }
    msgs = out;
  }
  tokens = estimateTokens(msgs);
  if (tokens <= threshold) {
    return { messages: msgs, stage: 2, beforeTokens, afterTokens: tokens };
  }

  // Stage 3：删除中间的早期轮次，保留第一个问题与最近的轮次
  const notice: Message = wrapReminder('为控制上下文长度，原始问题之后的若干轮早期对话已省略；请以原始问题和最近的对话为准。');
  let noticeInserted = false;
  while (estimateTokens(msgs) > threshold) {
    const users = msgs.map((m, i) => (isRealUser(m) ? i : -1)).filter((i) => i >= 0);
    if (users.length <= KEEP_RECENT_USER_TURNS + 1) break;
    const start = users[1];
    const end = users[2];
    msgs.splice(start, end - start);
    if (!noticeInserted) {
      msgs.splice(start, 0, notice);
      noticeInserted = true;
    }
  }
  return { messages: msgs, stage: 3, beforeTokens, afterTokens: estimateTokens(msgs) };
}

/** 生成稳定的工具调用签名（参数按键排序），用于识别完全相同的重复调用 */
export function toolCallSignature(name: string, args: Record<string, unknown>): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])
      );
    }
    return v;
  };
  return `${name}:${JSON.stringify(sortKeys(args || {}))}`;
}

// 与服务端 read_file_lines 的窗口规则保持一致：未给范围读 300 行，小于 120 行的窗口会被扩大
const READ_DEFAULT_SPAN = 300;
const READ_MIN_SPAN = 120;

function effectiveReadRange(args: Record<string, unknown>): [number, number] {
  const reqStart = Number(args.startLine) > 0 ? Math.floor(Number(args.startLine)) : undefined;
  const reqEnd = Number(args.endLine) > 0 ? Math.floor(Number(args.endLine)) : undefined;
  if (reqStart === undefined && reqEnd === undefined) return [1, READ_DEFAULT_SPAN];
  let start = reqStart ?? Math.max(1, (reqEnd as number) - READ_DEFAULT_SPAN + 1);
  let end = reqEnd ?? start + READ_DEFAULT_SPAN - 1;
  if (end < start) [start, end] = [end, start];
  if (end - start + 1 < READ_MIN_SPAN) {
    const newStart = Math.max(1, start - 20);
    end = Math.max(end, newStart + READ_MIN_SPAN - 1);
    start = newStart;
  }
  return [start, end];
}

function normalizeFilePath(p: unknown): string {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
}

/**
 * 识别同一轮排查中的重复工具调用：参数完全相同的调用，或对同一文件的读取范围有 80% 以上与之前重叠。
 * 回放评测中出现过模型在 50 轮里反复读取同一段代码、最终没有任何结论的情况。
 */
export class DuplicateCallTracker {
  private signatures = new Set<string>();
  private reads: Array<{ file: string; start: number; end: number }> = [];

  /** 返回 true 表示这次调用与之前的调用重复 */
  check(name: string, args: Record<string, unknown>): boolean {
    if (name === 'todo_write' || name === 'ask_user_question') return false;
    const sig = toolCallSignature(name, args);
    if (this.signatures.has(sig)) return true;
    this.signatures.add(sig);
    if (name !== 'read_file_lines') return false;

    const file = normalizeFilePath(args.filePath ?? args.file_path);
    const [start, end] = effectiveReadRange(args);
    const span = end - start + 1;
    const duplicate = this.reads.some((r) => {
      const sameFile = r.file === file || r.file.endsWith('/' + file) || file.endsWith('/' + r.file);
      if (!sameFile) return false;
      const overlap = Math.max(0, Math.min(end, r.end) - Math.max(start, r.start) + 1);
      return overlap / span >= 0.8;
    });
    this.reads.push({ file, start, end });
    return duplicate;
  }
}
