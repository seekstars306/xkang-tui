// 输入侧凭据脱敏：S2 是"搜不到"，这里是"即使搜到了也不送进模型"。
// 只认"键名命中敏感词 且 值形态命中"的双条件，业务字段（订单号/金额/手机号）不得被误伤。
import { appendUsageLedger } from '../usage_ledger.js';

export interface RedactionHit {
  line: number;
  keyName: string;
  kind: string;
}
export interface RedactResult {
  text: string;
  hits: RedactionHit[];
}

/** 敏感键名根（归一化后按路径段末段整词匹配；token_count 这类以 count 结尾的键不命中） */
const SENSITIVE_ROOTS = ['password', 'passwd', 'pwd', 'secret', 'token', 'credential', 'salt', 'accesskey', 'apikey', 'privatekey', 'signkey', 'appsecret'];
/** 高熵值形态：≥32 位 base64 风格字符（用于键名仅含敏感词的兜底） */
const HIGH_ENTROPY_VALUE = /^[A-Za-z0-9+/=_-]{32,}$/;
const PLACEHOLDER = /^\*\*\*REDACTED:/;

/** 取键名最后一段并归一化（去分隔符、小写），用于整词判定 */
function lastKeySegment(key: string): string {
  return key.split('.').pop()!.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_ROOTS.includes(lastKeySegment(key));
}
/** 键名任意位置含敏感词（仅配合高熵值条件使用） */
function containsSensitiveKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_ROOTS.some(root => flat.includes(root));
}

/**
 * company_db_query 的返回是 {"columns":[...],"rows":[[...]]}：值与键名不在同一行，
 * 逐行规则看不到对应关系。这里按列位脱敏：敏感列的值一律替换为占位符。
 */
function redactJsonRowValues(text: string, hits: RedactionHit[]): string | null {
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) return null;
  const sensitiveColumns = parsed.columns.map((column: unknown, index: number) => (typeof column === 'string' && isSensitiveKey(column) ? index : -1)).filter((index: number) => index >= 0);
  if (!sensitiveColumns.length) return null;
  let redactedRows = 0;
  const rows = parsed.rows.map((row: unknown) => {
    if (!Array.isArray(row)) return row;
    let touched = false;
    const next = row.map((value, index) => {
      if (!sensitiveColumns.includes(index) || value == null) return value;
      touched = true;
      return `***REDACTED:${parsed.columns[index]}***`;
    });
    if (touched) redactedRows++;
    return next;
  });
  if (!redactedRows) return null;
  hits.push({ line: 1, keyName: parsed.columns[sensitiveColumns[0]], kind: 'db_column' });
  return JSON.stringify({ ...parsed, rows });
}

function lineNumberOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/** 行首（可带缩进、JSON 开括号、引号）的键值对：敏感键的值整段脱敏 */
function redactAnchoredKeyValue(line: string, lineNo: number, hits: RedactionHit[]): string {
  const match = /^(\s*[{[]?\s*["']?)([\w.\-]+)(["']?)(\s*[:=]\s*)(.*)$/.exec(line);
  if (!match) return line;
  const [, prefix, key, close, sep, rest] = match;
  if (!isSensitiveKey(key) || PLACEHOLDER.test(rest.trim())) return line;
  const quoted = /^(["'])([\s\S]*)\1/.exec(rest);
  if (quoted) {
    hits.push({ line: lineNo, keyName: key, kind: 'json' });
    return `${prefix}${key}${close}${sep}${quoted[1]}***REDACTED:${key}***${quoted[1]}${rest.slice(quoted[0].length)}`;
  }
  // YAML（冒号）取整行剩余；properties/env（等号）取到空白、逗号或分号
  const token = sep.includes(':') ? rest.trim() : (rest.match(/^[^\s,;]+/)?.[0] ?? '');
  if (!token) return line;
  hits.push({ line: lineNo, keyName: key, kind: sep.includes(':') ? 'yaml' : 'config' });
  return `${prefix}${key}${close}${sep}${rest.replace(token, `***REDACTED:${key}***`)}`;
}

/** 行内任意位置的键值对（代码行、行号前缀输出、JSON 行）：敏感键脱敏；键名含敏感词且值 ≥32 位高熵时兜底脱敏 */
function redactInlineKeyValue(line: string, lineNo: number, hits: RedactionHit[]): string {
  // 未加引号的值不以 { [ 开头：否则整个嵌套结构会被当成一个值吞掉，里面的敏感键就漏掉了
  return line.replace(/(["']?)([\w.\-]+)\1(\s*[:=]\s*)("([^"]*)"|'([^']*)'|(?![{\[])[^\s,;]+)/g, (match, quote: string, key: string, sep: string, raw: string, doubleQuoted?: string, singleQuoted?: string) => {
    const value = doubleQuoted ?? singleQuoted ?? raw;
    if (PLACEHOLDER.test(value)) return match;
    if (isSensitiveKey(key)) {
      hits.push({ line: lineNo, keyName: key, kind: quote ? 'json' : 'inline' });
      return doubleQuoted !== undefined ? `${quote}${key}${quote}${sep}"***REDACTED:${key}***"` : `${quote}${key}${quote}${sep}***REDACTED:${key}***`;
    }
    if (containsSensitiveKey(key) && value.length >= 32 && HIGH_ENTROPY_VALUE.test(value)) {
      hits.push({ line: lineNo, keyName: key, kind: 'entropy' });
      return `${quote}${key}${quote}${sep}***REDACTED:${key}***`;
    }
    return match;
  });
}

function redactLine(line: string, lineNo: number, hits: RedactionHit[]): string {
  let out = line.replace(/(Authorization\s*:\s*)(Bearer\s+)?([A-Za-z0-9._~+/=-]{8,})/gi, (_m, prefix: string, scheme: string | undefined) => {
    hits.push({ line: lineNo, keyName: 'authorization', kind: 'bearer' });
    return `${prefix}${scheme || ''}***REDACTED:bearer_token***`;
  });
  out = out.replace(/(jdbc:[a-z0-9]+:\/\/[^:\s/]+:)([^@\s]+)(@)/gi, (_m, prefix: string, _value: string, at: string) => {
    hits.push({ line: lineNo, keyName: 'jdbc-password', kind: 'jdbc' });
    return `${prefix}***REDACTED:jdbc_password***${at}`;
  });
  out = redactAnchoredKeyValue(out, lineNo, hits);
  out = redactInlineKeyValue(out, lineNo, hits);
  return out;
}

/** 脱敏一段文本：命中时把值替换为 ***REDACTED:<键名>***，保留键名与行号 */
export function redactText(text: string): RedactResult {
  const hits: RedactionHit[] = [];
  // 先处理 DB 结果形态（columns+rows 按列位脱敏），整段替换后仍走逐行规则兜底
  const dbRedacted = redactJsonRowValues(text, hits);
  const source = dbRedacted ?? text;
  let out = source.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, (match) => {
    hits.push({ line: lineNumberOf(source, source.indexOf(match)), keyName: 'private_key', kind: 'pem' });
    return '***REDACTED:private_key_block***';
  });
  out = out.split('\n').map((line, i) => redactLine(line, i + 1, hits)).join('\n');
  return { text: out, hits };
}

const REDACTION_NOTICE = '本结果中有字段已按安全策略脱敏，不得猜测其值，也不得在回答中提及该字段。';

/** 脱敏事件写入用量台账（purpose: 'other' 元记录）：只记工具名、命中条数与键名，不记值 */
function recordRedaction(toolName: string, hits: RedactionHit[]): void {
  try {
    const keyNames = [...new Set(hits.map(h => h.keyName))].slice(0, 10).join(', ');
    appendUsageLedger({ ts: new Date().toISOString(), task: 'S6-input-guard', model: toolName, purpose: 'other', inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, durationMs: 0, ok: true, detail: `脱敏 ${hits.length} 处，键名: ${keyNames}` });
  } catch { /* 台账写入失败不影响工具结果本身 */ }
}

/**
 * 服务端工具结果脱敏包装：有命中时替换值、追加安全提示行并记台账；
 * 无命中时原样返回（不改变现有行为）。
 */
export function redactToolResult(toolName: string, text: string): string {
  const { text: redacted, hits } = redactText(text);
  if (!hits.length) return text;
  recordRedaction(toolName, hits);
  return `${redacted}\n${REDACTION_NOTICE}`;
}
