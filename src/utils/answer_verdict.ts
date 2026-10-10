/**
 * 识别回答【结论】段标注的把握程度（已确认 / 推断 / 无法确定），用于网页端会话列表的标记。
 * 规则与网页端 web/answer.js 的 splitSections / verdictOf 一致，tests/client/answer_format.test.ts 会交叉校验。
 */

export type Verdict = 'confirmed' | 'inferred' | 'unknown';
export type SectionKind = 'conclusion' | 'evidence' | 'script' | 'open' | 'other';

export interface AnswerSection {
  kind: SectionKind;
  title: string;
  body: string;
}

const KIND_RULES: Array<[Exclude<SectionKind, 'other'>, RegExp]> = [
  ['conclusion', /结论/],
  ['script', /话术|回复客户|对客|向.{0,6}(?:用户|客户).{0,8}(?:解释|说明|回复)/],
  ['open', /还需|待确认|需确认|需要确认|待核实|仍需|未确认/],
  ['evidence', /依据|证据|查证|佐证|凭证/],
];

function sectionKind(title: string): SectionKind {
  for (const [kind, re] of KIND_RULES) if (re.test(title)) return kind;
  return 'other';
}

const BRACKET_LINE = /^[ \t]*(#{1,6}[ \t]*)?(\*\*)?[ \t]*【([^】\n]{1,16})】[ \t]*(\*\*)?[ \t]*[:：]?[ \t]*(.*)$/;
const BOLD_LINE = /^[ \t]*(?:#{1,6}[ \t]*)?\*\*([^*\n【】]{2,24}?)\*\*[ \t]*([:：]?)[ \t]*(.*)$/;
const HEADING_LINE = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** 去掉标题前的序号（一、/ 1. / （二））、emoji 和结尾冒号 */
function cleanTitle(raw: string): string {
  return String(raw)
    .trim()
    .replace(/^(?:[一二三四五六七八九十]+[、.．]|\d+[.、．)]|[(（][一二三四五六七八九十\d]+[)）])[ \t]*/, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[ \t]*[:：]$/, '')
    .trim();
}

function matchSectionLine(line: string): { kind: SectionKind; title: string; rest: string } | null {
  let m = line.match(BRACKET_LINE);
  if (m) {
    const title = m[3].trim();
    const kind = sectionKind(title);
    let rest = m[5] || '';
    if (kind === 'other' && !(m[1] || m[2] || m[4]) && rest.trim()) return null;
    if (m[2] && !m[4] && rest.includes('**')) rest = '**' + rest;
    return { kind, title, rest };
  }
  m = line.match(BOLD_LINE);
  if (m) {
    const title = cleanTitle(m[1]);
    const kind = sectionKind(title);
    const rest = m[3] || '';
    const colon = /[:：][ \t]*$/.test(m[1]) || m[2];
    if (kind !== 'other' && title.length <= 16 && (colon || !rest.trim())) return { kind, title, rest };
    return null;
  }
  m = line.match(HEADING_LINE);
  if (m) {
    const title = cleanTitle(m[1]);
    const kind = sectionKind(title);
    if (kind !== 'other' && title.replace(/\s+/g, '').length <= 16) return { kind, title, rest: '' };
  }
  return null;
}

function trimFiller(lines: string[]): string {
  const filler = (l: string) => /^\s*(?:(?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,})?\s*$/.test(l);
  let a = 0;
  let b = lines.length;
  while (a < b && filler(lines[a])) a++;
  while (b > a && filler(lines[b - 1])) b--;
  return lines.slice(a, b).join('\n');
}

export function splitSections(text: string): { preamble: string; sections: AnswerSection[] } {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const pre: string[] = [];
  const sections: Array<{ kind: SectionKind; title: string; lines: string[] }> = [];
  let cur: (typeof sections)[number] | null = null;
  let fence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence;
    const hit = fence ? null : matchSectionLine(line);
    if (hit) {
      cur = { kind: hit.kind, title: hit.title, lines: hit.rest.trim() ? [hit.rest] : [] };
      sections.push(cur);
    } else {
      (cur ? cur.lines : pre).push(line);
    }
  }
  return {
    preamble: trimFiller(pre),
    sections: sections.map((s) => ({ kind: s.kind, title: s.title, body: trimFiller(s.lines) })),
  };
}

const RANK: Record<Verdict, number> = { unknown: 0, inferred: 1, confirmed: 2 };
const VERDICT_PATTERNS = [
  /(?:^|\n)[ \t]*(?:[-*+][ \t]+|\d+[.、)][ \t]*)?(?:\*\*)?[ \t]*[（(【[]?[ \t]*(已确认|已核实|已证实|推断|推测|无法确定|无法确认|不能确定|不能确认|无法判断|无法推断)/g,
  /\*\*[ \t]*[（(【[]?[ \t]*(已确认|已核实|已证实|推断|推测|无法确定|无法确认|不能确定|不能确认|无法判断|无法推断)/g,
  /[（(【[][ \t]*(已确认|已核实|已证实|推断|推测|无法确定|无法确认|不能确定|不能确认|无法判断|无法推断)[ \t]*[)）】\]]/g,
];
const LABEL_ANY = /(已确认|已核实|已证实|推断|推测|无法确定|无法确认|不能确定|不能确认|无法判断|无法推断)/;
const LABEL_COLON = /(已确认|已核实|已证实|推断|推测|无法确定|无法确认|不能确定|不能确认|无法判断|无法推断)[ \t]*[:：]/;

function labelVerdict(label: string): Verdict {
  if (/^(?:无法|不能)/.test(label)) return 'unknown';
  if (/^推/.test(label)) return 'inferred';
  return 'confirmed';
}

/** 只认"标注位置"上的标签（行首、加粗、括号里）；出现多个时取最弱的一个 */
export function verdictOf(title: string, body: string): Verdict | null {
  const found: string[] = [];
  const text = String(body || '');
  const t = String(title || '').match(LABEL_ANY);
  if (t) found.push(t[1]);
  for (const re of VERDICT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) found.push(m[1]);
  }
  if (!found.length) {
    const f = text.slice(0, 60).match(LABEL_COLON);
    if (f) found.push(f[1]);
  }
  let best: Verdict | null = null;
  for (const label of found) {
    const v = labelVerdict(label);
    if (best === null || RANK[v] < RANK[best]) best = v;
  }
  return best;
}

export function detectVerdict(text: string): Verdict | null {
  const c = splitSections(text).sections.find((s) => s.kind === 'conclusion');
  return c ? verdictOf(c.title, c.body) : null;
}
