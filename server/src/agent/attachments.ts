import type { ChatGateway, Message, MessageContentPart, SeedToolResult, ToolDefinition } from '@xkang/agent-core';
import { messageText } from '@xkang/agent-core/context';

/**
 * 用户截图 → 可引用的证据。
 *
 * 调查模型能直接看截图，但截图不是工具结果，没有证据编号：复核要求每条事实都引用 {evidenceId, quote}，
 * 所以"截图上写着某句提示"永远引用不了，靠截图得出的正确结论一轮轮被打回。
 * 这里在排查开始前用调查模型把每张图逐字转写成文字，作为 read_attachment 的真实工具结果写进会话
 * （由 AgentCore.seedToolResults 走与普通工具相同的写入路径，自动获得 evidence 编号）；
 * 复核随附原图，可以对照原图核验转写是否准确。
 */

/** 工具名：历史里的 tool_calls 引用的是注册表里真实存在的只读工具，模型之后也能自己再读 */
export const READ_ATTACHMENT_TOOL = 'read_attachment';
/** 每轮最多转写的图片张数，与复核随附原图的上限一致：每条可引用的转写都有原图可对照 */
export const ATTACHMENT_IMAGE_LIMIT = 4;
/** 单张图片的转写时限；超时跳过该图 */
// 单张图片转写的时间上限。
//
// 原来写死 30 秒，而 transcribeAttachments 是**并行**转写所有图片：
// 带 3 张图时 3 个转写请求同时打模型，每个都超过 30 秒被 abort，
// 结果被 catch 静默吞掉——模型完全拿不到图片内容，表现为「读了图但答不出结论」。
// 2026-11-02 审计里三条 30019/30014/30014ms 就是这三张图的转写。
// 现在可通过 ATTACHMENT_TRANSCRIBE_TIMEOUT_MS 调整，默认放宽到 120 秒。
// 整个转写阶段的总预算（core.ts 的 seedTimeoutMs）。
//
// 这个才是真正卡死图片的闸门：core 默认只给 60 秒，到点直接 abort 整批，
// 报错是 “This operation was aborted”。
// 单图超时（上面那个）改到 120 秒也没用——60 秒的阶段预算会先触发。
// 所以必须让阶段预算大于单图预算，默认给 180 秒。
export const SEED_TOOL_TIMEOUT_MS = (() => {
  const v = Number(process.env.SEED_TOOL_TIMEOUT_MS);
  return Number.isInteger(v) && v >= 10000 ? v : 180000;
})();

const configuredTranscribeTimeout = Number(process.env.ATTACHMENT_TRANSCRIBE_TIMEOUT_MS);
export const ATTACHMENT_TRANSCRIBE_TIMEOUT_MS =
  Number.isInteger(configuredTranscribeTimeout) && configuredTranscribeTimeout >= 10000
    ? configuredTranscribeTimeout
    : 120000;
/** 纯转写指令：只抄文字，不做任何解释 */
export const TRANSCRIBE_INSTRUCTION = '逐字转写图中全部文字，从上到下、从左到右。不解释、不推测、不补全；看不清的地方写[看不清]；图中没有文字时只写[无文字]。只输出转写内容。';

export interface AttachmentImage {
  /** 图片在本轮消息中的序号（从 1 开始，按图片出现顺序） */
  index: number;
  url: string;
  detail?: 'low' | 'high' | 'auto';
}
/** 转写单张图片；signal 中止（超时、整轮取消）时应尽快放弃 */
export type ImageTranscriber = (image: AttachmentImage, signal: AbortSignal) => Promise<string>;

/** 本轮输入里的图片，按出现顺序编号（与复核占位"截图 N"、read_attachment 的 index 一致） */
export function attachmentImages(input: string | MessageContentPart[]): AttachmentImage[] {
  if (!Array.isArray(input)) return [];
  const images: AttachmentImage[] = [];
  let index = 0;
  for (const part of input) {
    if (part?.type !== 'image_url') continue;
    index++;
    const url = part.image_url?.url;
    if (typeof url === 'string' && url) images.push({ index, url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) });
  }
  return images;
}

/** 证据原文：表头注明来源是模型转写、以原图为准 */
export function attachmentEvidenceText(index: number, transcript: string): string {
  return `【附件 ${index}：图片中的文字（模型逐字转写，以原图为准）】\n${transcript}`;
}

/**
 * 用调查模型做一次纯文字转写。gatewayFor 必须给出不带 response_format 的纯文本调用：
 * BusinessModel 要用 jsonMode=false 构造，并且调用时不能传 options.signal（传了也会附加 response_format）。
 */
export function modelTranscriber(gatewayFor: (signal: AbortSignal) => ChatGateway): ImageTranscriber {
  return async (image, signal) => {
    const reply = await gatewayFor(signal).streamChat([{ role: 'user', content: [
      { type: 'text', text: TRANSCRIBE_INSTRUCTION },
      { type: 'image_url', image_url: { url: image.url, ...(image.detail ? { detail: image.detail } : {}) } },
    ] }], [], () => {});
    if (reply.tool_calls?.length) throw new Error('转写调用返回了工具调用');
    return messageText(reply);
  };
}

/** 中止信号触发时立即放弃等待（转写函数自己不理会 signal 时也不会拖住） */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/**
 * 并行转写本轮图片（最多 ATTACHMENT_IMAGE_LIMIT 张）。单张抛错、超时或转写为空就跳过该图，整体从不抛错；
 * 成功的结果按图片序号写进 transcripts（供 read_attachment 读取），并作为预置工具结果返回。
 */
export async function transcribeAttachments(
  images: AttachmentImage[],
  transcribe: ImageTranscriber,
  transcripts: Map<number, string>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SeedToolResult[]> {
  const results = await Promise.all(images.slice(0, ATTACHMENT_IMAGE_LIMIT).map(async (image): Promise<SeedToolResult | undefined> => {
    // 用普通计时器而不是 AbortSignal.timeout：后者不占事件循环，进程空闲时可能根本等不到它触发
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('图片转写超时')), options.timeoutMs ?? ATTACHMENT_TRANSCRIBE_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    try {
      const transcript = String(await untilAborted(Promise.resolve().then(() => transcribe(image, signal)), signal) ?? '').trim();
      if (!transcript) return undefined;
      const text = attachmentEvidenceText(image.index, transcript);
      transcripts.set(image.index, text);
      return { name: READ_ATTACHMENT_TOOL, arguments: { index: image.index }, text };
    } catch (error) {
      // 不能静默丢弃：图片没转写成功，模型就等于没看到图，
      // 但排查照样继续，最后只会得到一句“没形成结论”，很难回溯。
      console.warn(`[attachments] 第 ${image.index} 张图片转写失败，已跳过：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }));
  return results.filter((item): item is SeedToolResult => Boolean(item));
}

/** read_attachment：按序号返回本轮已转写的文字。只读，不再调用模型 */
export function readAttachmentTool(transcripts: ReadonlyMap<number, string>): ToolDefinition {
  return {
    name: READ_ATTACHMENT_TOOL,
    description: '按序号读取本轮客服消息所附图片的文字转写（模型逐字转写，以原图为准）。index 为图片在消息中的顺序，从 1 开始。',
    parameters: { type: 'object', properties: { index: { type: 'number', description: '图片序号，从 1 开始' } }, required: ['index'] },
    execute: async args => {
      const index = Number(args.index);
      const text = Number.isInteger(index) ? transcripts.get(index) : undefined;
      if (text) return text;
      const available = [...transcripts.keys()].sort((a, b) => a - b);
      return { status: 'error', message: `本轮没有附件 ${String(args.index)} 的文字转写。`, available };
    },
  };
}

/** 续查时从本轮历史恢复已写入的转写，让 read_attachment 仍然可读、历史里的调用仍指向存在的工具 */
export function restoreAttachmentTranscripts(messages: Message[], turnId: string): Map<number, string> {
  const transcripts = new Map<number, string>();
  for (const m of messages) {
    if (m.role !== 'tool' || m.name !== READ_ATTACHMENT_TOOL || m.turnId !== turnId || m.evidence?.outcome !== 'success') continue;
    const index = Number(m.evidence.arguments?.index);
    const text = m.raw_tool_result ?? messageText(m);
    if (Number.isInteger(index) && !transcripts.has(index) && text.startsWith('【附件')) transcripts.set(index, text);
  }
  return transcripts;
}
