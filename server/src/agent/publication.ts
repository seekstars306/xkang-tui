import { z } from 'zod';
import type { Message } from '@xkang/agent-core';
import type { PublicAnswer } from '@xkang/agent-core/public';

const publicString = z.string().max(12000);
export const draftSchema = z.object({
  conclusion: publicString.min(1),
  businessData: z.array(z.object({ label: z.string().min(1).max(100), value: publicString }).strict()).max(200),
  evidenceSummary: z.array(publicString).max(50),
  customerReply: publicString,
  pendingItems: z.array(publicString).max(50),
}).strict();
export type PublicDraft = z.infer<typeof draftSchema>;

// This policy targets implementation details. It deliberately contains no phone/ID masking rules.
const PRIVATE_PATTERNS: Array<[string, RegExp]> = [
  ['code', /```|\b(?:class|interface)\s+[A-Z]\w*|\b(?:public|private|protected)\s+(?:static\s+)?\w+\s+\w+\s*\(/i],
  ['sql', /\bselect\s+[\s\S]{0,600}?\bfrom\s+|\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+table|alter\s+table|show\s+tables)\b/i],
  ['path', /(?:[a-z]:[\\/]|\\\\[a-z0-9_.-]+\\|(?:\/(?:home|root|srv|opt|var|etc|Users|skt[-_\w]*)\/))|\b[\w.-]+\.(?:java|vue|tsx?|jsx?|sql|xml|yml|yaml|properties)(?::\d+)?\b/i],
  ['internal_address', /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3})\b|\b(?:jdbc|mysql|postgres(?:ql)?):\/\/|\/(?:api|admin|permission|internal)\/[\w/.-]+/i],
  ['credentials', /\bBearer\s+\S+|\b(?:api[_-]?key|password|access[_-]?token|secret)\s*[:=]\s*\S+|\b(?:sk-|tok_skt_)[a-z0-9_-]{8,}/i],
  ['implementation', /\b[A-Z]\w*(?:ServiceImpl|Controller|Mapper|Repository|Exception)\b|\b[a-z]+(?:_[a-z0-9]+){2,}\b|\b[a-z]+[A-Z]\w*\s*\(|\bat\s+[\w.$]+\([^)]*:\d+\)/],
];

export function collectPrivateTerms(messages: Message[]): Set<string> {
  const terms = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (text.length >= 3 && /[a-zA-Z]/.test(text)) terms.add(text);
    const base = text.split(/[\\/]/).pop();
    if (base && /\.(?:java|vue|ts|js|sql|xml)$/.test(base)) terms.add(base);
  };
  for (const m of messages) {
    for (const call of m.tool_calls || []) {
      let args: any = call.arguments;
      try { if (typeof args === 'string') args = JSON.parse(args); } catch { continue; }
      for (const key of ['database', 'tableName', 'filePath', 'file_path', 'symbol', 'repo', 'app']) add(args?.[key]);
      for (const match of String(args?.sql || '').matchAll(/\b(?:from|join|update|into)\s+`?([\w.]+)/gi)) add(match[1]);
    }
    if (m.role !== 'tool') continue;
    const args = m.evidence?.arguments || {};
    for (const key of ['database', 'tableName', 'filePath', 'file_path', 'symbol', 'repo', 'app']) add(args[key]);
    for (const match of String(args.sql || '').matchAll(/\b(?:from|join|update|into)\s+`?([\w.]+)/gi)) add(match[1]);
    const raw = m.raw_tool_result ?? (typeof m.content === 'string' ? m.content : '');
    try {
      const parsed = JSON.parse(raw);
      add(parsed.database);
      for (const column of [...(parsed.columns || []), ...(parsed.allNullColumns || [])]) add(column);
      for (const match of String(parsed.executedSql || '').matchAll(/\b(?:from|join|update|into)\s+`?([\w.]+)/gi)) add(match[1]);
    } catch { /* textual source records */ }
    for (const match of raw.matchAll(/\b(?:class|interface|function)\s+([A-Za-z_$][\w$]*)|\b([a-z][\w]*[A-Z][\w]*)\s*\(/g)) add(match[1] || match[2]);
    if (['search_code', 'read_file_lines', 'codegraph_explore'].includes(m.name || '')) {
      // Source conditions and declarations may expose simple field names without SQL keywords.
      for (const match of raw.matchAll(/\b([A-Za-z_][\w]*)\s*(?:==|!=|>=|<=|=(?!=))|\b(?:private|protected|public)\s+(?:static\s+|final\s+)*[\w<>?,.\[\]]+\s+([A-Za-z_][\w]*)\s*;/g)) add(match[1] || match[2]);
    }
  }
  return terms;
}

export function checkPublicText(text: string, terms: ReadonlySet<string>): string[] {
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '');
  const issues = PRIVATE_PATTERNS.filter(([, pattern]) => pattern.test(normalized)).map(([kind]) => kind);
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i').test(normalized)) { issues.push('internal_identifier'); break; }
  }
  return issues;
}

export function parsePublicDraft(text: string, terms: ReadonlySet<string>): PublicDraft {
  const draft = draftSchema.parse(JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));
  for (const block of publicBlocks(draft)) if (checkPublicText(block.text, terms).length) throw new Error('候选回答包含内部技术信息');
  if (draft.businessData.some(item => !/[\u3400-\u9fff]/.test(item.label))) throw new Error('业务字段必须使用中文名称');
  return draft;
}
export function publicBlocks(draft: PublicDraft): Array<{ id: string; text: string }> {
  return [
    { id: 'conclusion', text: draft.conclusion },
    ...draft.businessData.map((item, i) => ({ id: `data:${i}`, text: `${item.label}：${item.value}` })),
    ...draft.evidenceSummary.map((text, i) => ({ id: `evidence:${i}`, text })),
    ...(draft.customerReply ? [{ id: 'customerReply', text: draft.customerReply }] : []),
    ...draft.pendingItems.map((text, i) => ({ id: `pending:${i}`, text })),
  ];
}
export function unavailableAnswer(traceId: string): PublicAnswer {
  return { conclusion: '本次尚未形成可直接采信的业务结论，需要继续核实。', businessData: [], evidenceSummary: [], customerReply: '您的问题仍在核实，请由二线人员继续跟进。', pendingItems: ['当前结论未完成复核。'], reviewStatus: 'needs_human', traceId };
}
export function publicUserText(input: unknown, terms: ReadonlySet<string>): string {
  const text = typeof input === 'string' ? input : Array.isArray(input) ? input.filter(p => p?.type === 'text').map(p => p.text).join('\n') : '';
  return checkPublicText(text, terms).length ? '已提交业务问题及附件。' : text || '已提交图片或附件。';
}
