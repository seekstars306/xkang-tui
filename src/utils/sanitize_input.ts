import { MessageContentPart } from '../types/index.js';

/** 单条客服输入进入上下文的最大字符数 */
export const MAX_USER_TEXT_CHARS = 30000;

const ATTACHMENT_BLOCK = /\[附件文件: ([^\]\n]+)\]\n```\n([\s\S]*?)\n```/g;

function looksBinary(text: string): boolean {
  if (!text) return false;
  if (text.includes('\u0000')) return true;
  const bad = (text.match(/�/g) || []).length;
  return bad > 20 && bad / text.length > 0.01;
}

/**
 * 清洗客服输入：网页端会把非图片附件按文本读进消息，zip/pdf/xlsx 等二进制文件会变成大段乱码
 * （历史会话中一个 zip 变成 11.5 万字符、5 万个替换字符），既浪费上下文又会干扰模型。
 */
export function sanitizeUserText(text: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  let out = text.replace(ATTACHMENT_BLOCK, (whole, name: string, body: string) => {
    if (looksBinary(body)) {
      notes.push(`附件 ${name} 是二进制文件，已忽略其内容`);
      return `[附件文件: ${name}]（二进制或非文本文件，内容无法读取，已省略。如需分析请提供截图或复制其中的文字）`;
    }
    return whole;
  });

  if (looksBinary(out) && out.length > 2000) {
    // 非附件格式的乱码：去掉连续的替换字符/控制字符片段
    out = out.replace(/[�\u0000-\u0008\u000E-\u001F]{3,}[^\n]{0,40}/g, '');
    notes.push('输入中包含无法识别的二进制乱码，已清除');
  }

  if (out.length > MAX_USER_TEXT_CHARS) {
    const omitted = out.length - MAX_USER_TEXT_CHARS;
    out = `${out.slice(0, MAX_USER_TEXT_CHARS)}\n…[输入过长，后面 ${omitted} 个字符已省略，请只粘贴与问题相关的部分]`;
    notes.push(`输入过长，已截取前 ${MAX_USER_TEXT_CHARS} 个字符`);
  }
  return { text: out, notes };
}

export function sanitizeUserParts(parts: MessageContentPart[]): { parts: MessageContentPart[]; notes: string[] } {
  const notes: string[] = [];
  const cleaned = parts.map((p) => {
    if (p.type !== 'text') return p;
    const r = sanitizeUserText(p.text);
    notes.push(...r.notes);
    return { ...p, text: r.text };
  });
  return { parts: cleaned, notes };
}
