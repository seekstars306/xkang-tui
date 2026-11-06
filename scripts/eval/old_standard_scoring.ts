import { createHash, randomUUID } from 'node:crypto';

/** Pure offline scoring support. Never reads credentials, runs a model, or fills in a missing case. */
type Obj = Record<string, any>;
export interface OldSource {
  condition: string; ticket: string; runId: string; status: string; publicAnswer: unknown;
  missingDelivery?: { reason: string; evidence: string };
}
export interface OldPack { rubrics: Record<string, Obj>; answers: { blindId: string; ticket: string; answer: string }[] }
export interface OldKey {
  schema: 1; conditions: string[]; tickets: string[]; rubricSha256: string;
  samples: { blindId: string; condition: string; ticket: string; runId: string; status: string;
    sourceSha256: string; answerSha256: string; noAnswer: boolean }[];
}
export class OldScoreError extends Error { constructor(readonly code: string) { super(code); } }
const check: (ok: unknown, code: string) => asserts ok = (ok, code) => { if (!ok) throw new OldScoreError(code); };
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (v: Obj, k: string) => Object.prototype.hasOwnProperty.call(v, k);
const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : object(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
const canonical = (v: unknown) => JSON.stringify(stable(v));
export const oldScoreHash = (v: unknown): string => createHash('sha256').update(canonical(v)).digest('hex');
const textHash = (s: string) => createHash('sha256').update(s).digest('hex');
const pairId = (condition: string, ticket: string) => JSON.stringify([condition, ticket]);
const uniqueStrings = (v: unknown, code: string): string[] => {
  check(Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x.length > 0)
    && new Set(v).size === v.length, code); return v;
};
const terminal = new Set(['COMPLETED', 'COMPLETED_AFTER_DISCONNECT', 'SERVER_ERROR', 'INFRA_INTERRUPTED', 'NOT_STARTED_INFRA']);
// Exact service text only; a normal answer mentioning uncertainty is NOT a status-only answer.
const statusOnly = new Set(['本次尚未形成可直接采信的业务结论，需要继续核实。',
  '已查到的结果不完整，暂时无法确认全部情况，需要继续补查。']);

export function oldItemIds(rubric: unknown): string[] {
  check(object(rubric) && Array.isArray(rubric.items) && rubric.items.length > 0
    && rubric.items.every((v: unknown) => typeof v === 'string' && v.length > 0), 'INVALID_RUBRIC_ITEMS');
  const ids = rubric.items.map((s: string, i: number) => /^([A-Z]+\d+)\s/.exec(s)?.[1] || String(i + 1));
  check(new Set(ids).size === ids.length, 'DUPLICATE_ITEM_IDS'); return ids;
}
function selectRubrics(rubrics: unknown, tickets: string[]): Record<string, Obj> {
  check(object(rubrics), 'INVALID_RUBRICS');
  return Object.fromEntries(tickets.map(ticket => {
    check(own(rubrics, ticket) && object(rubrics[ticket]), 'MISSING_RUBRIC');
    oldItemIds(rubrics[ticket]); return [ticket, structuredClone(rubrics[ticket])];
  }));
}
export function formatOldAnswer(source: OldSource): { text: string; noAnswer: boolean } {
  const raw = source.publicAnswer;
  if (raw === null) {
    check(object(source.missingDelivery) && typeof source.missingDelivery.reason === 'string' && source.missingDelivery.reason.trim()
      && typeof source.missingDelivery.evidence === 'string' && source.missingDelivery.evidence.trim(), 'MISSING_DELIVERY_EVIDENCE');
    // Preserve the old formatter's empty-answer label; it is not proof of an actual answer.
    return { text: '结论：', noAnswer: true };
  }
  check(object(raw) && own(raw, 'conclusion') && typeof raw.conclusion === 'string', 'INVALID_PUBLIC_ANSWER');
  for (const k of ['businessData', 'evidenceSummary', 'pendingItems']) {
    check(raw[k] === undefined || Array.isArray(raw[k]), 'INVALID_PUBLIC_ARRAY');
  }
  check(raw.customerReply === undefined || typeof raw.customerReply === 'string', 'INVALID_PUBLIC_REPLY');
  const data = raw.businessData ?? [], evidence = raw.evidenceSummary ?? [], pending = raw.pendingItems ?? [];
  check(data.every((v: unknown) => object(v) && typeof v.label === 'string' && typeof v.value === 'string'), 'INVALID_PUBLIC_DATA');
  check([...evidence, ...pending].every(v => typeof v === 'string'), 'INVALID_PUBLIC_TEXT');
  const parts = ['结论：' + raw.conclusion];
  if (data.length) parts.push('业务数据：\n' + data.map((d: Obj) => '- ' + d.label + '：' + d.value).join('\n'));
  if (evidence.length) parts.push('依据：\n' + evidence.map((s: string) => '- ' + s).join('\n'));
  if (raw.customerReply) parts.push('给提问人的回复：' + raw.customerReply);
  if (pending.length) parts.push('待确认事项：\n' + pending.map((s: string) => '- ' + s).join('\n'));
  const reply = raw.customerReply || '';
  const emptyBody = !reply.trim() && !pending.length;
  const legacyUnavailable = raw.conclusion === '本次尚未形成可直接采信的业务结论，需要继续核实。'
    && reply === '您的问题仍在核实，请由二线人员继续跟进。'
    && pending.length === 1 && pending[0] === '当前结论未完成复核。';
  // A placeholder conclusion never erases substantive reply or pending text.
  const noAnswer = !data.length && !evidence.length && (legacyUnavailable
    || (emptyBody && (statusOnly.has(raw.conclusion) || !raw.conclusion.trim())));
  return { text: parts.join('\n\n'), noAnswer };
}
function indexSources(sources: unknown, conditions: string[], tickets: string[]): Map<string, OldSource> {
  check(Array.isArray(sources) && sources.length === conditions.length * tickets.length, 'SOURCE_CARDINALITY');
  const index = new Map<string, OldSource>(), runIds = new Set<string>();
  for (const s of sources) {
    check(object(s) && conditions.includes(s.condition) && tickets.includes(s.ticket), 'UNPLANNED_SOURCE');
    check(typeof s.runId === 'string' && s.runId.length > 0 && !runIds.has(s.runId), 'DUPLICATE_OR_MISSING_RUN');
    check(terminal.has(s.status), 'SOURCE_NOT_TERMINAL');
    check(own(s, 'publicAnswer'), 'MISSING_PUBLIC_ANSWER');
    const id = pairId(s.condition, s.ticket); check(!index.has(id), 'DUPLICATE_CASE');
    formatOldAnswer(s as OldSource); runIds.add(s.runId); index.set(id, s as OldSource);
  }
  for (const c of conditions) for (const t of tickets) check(index.has(pairId(c, t)), 'MISSING_CASE');
  return index;
}
export function prepareOldPack(rubrics: unknown, sources: OldSource[], conditions: string[], tickets: string[]): { pack: OldPack; key: OldKey } {
  conditions = [...uniqueStrings(conditions, 'INVALID_CONDITIONS')]; tickets = [...uniqueStrings(tickets, 'INVALID_TICKETS')];
  const selected = selectRubrics(rubrics, tickets), index = indexSources(sources, conditions, tickets);
  const answers: OldPack['answers'] = [], samples: OldKey['samples'] = [], ids = new Set<string>();
  for (const s of index.values()) {
    let blindId: string; do { blindId = 'S' + randomUUID().replaceAll('-', '').slice(0,16); } while (ids.has(blindId)); ids.add(blindId);
    const a = formatOldAnswer(s);
    answers.push({ blindId, ticket: s.ticket, answer: a.text });
    samples.push({ blindId, condition: s.condition, ticket: s.ticket, runId: s.runId, status: s.status,
      sourceSha256: oldScoreHash(s), answerSha256: textHash(a.text), noAnswer: a.noAnswer });
  }
  answers.sort((a,b) => a.blindId.localeCompare(b.blindId)); samples.sort((a,b) => a.blindId.localeCompare(b.blindId));
  return { pack: { rubrics: selected, answers }, key: { schema: 1, conditions, tickets, rubricSha256: oldScoreHash(selected), samples } };
}

const itemValue: Record<string, number> = { hit: 1, partial: 0.5, miss: 0 };
const correctValue: Record<string, number> = { correct: 1, partial: 0.5, wrong: 0, none: 0 };
const mean = (xs: number[]) => xs.reduce((n,x) => n + x, 0) / xs.length;
/** Validation completes BEFORE any aggregates are produced. Ratings are never mutated or reconciled to the higher score. */
export function validateOldScores(pack: OldPack, key: OldKey, reviewers: { reviewerId: string; records: unknown }[], sources: OldSource[]) {
  const conditions = uniqueStrings(key.conditions, 'INVALID_CONDITIONS'), tickets = uniqueStrings(key.tickets, 'INVALID_TICKETS');
  check(key.schema === 1 && canonical(Object.keys(pack.rubrics).sort()) === canonical([...tickets].sort()), 'PACK_RUBRIC_SET');
  const rubrics = selectRubrics(pack.rubrics, tickets); check(oldScoreHash(rubrics) === key.rubricSha256, 'RUBRIC_DRIFT');
  const index = indexSources(sources, conditions, tickets), n = index.size;
  check(Array.isArray(pack.answers) && Array.isArray(key.samples) && pack.answers.length === n && key.samples.length === n, 'PACK_CARDINALITY');
  const answerMap = new Map<string, OldPack['answers'][number]>(), keyMap = new Map<string, OldKey['samples'][number]>();
  for (const a of pack.answers) {
    check(object(a) && typeof a.blindId === 'string' && a.blindId && !answerMap.has(a.blindId)
      && tickets.includes(a.ticket) && typeof a.answer === 'string', 'INVALID_OR_DUPLICATE_SAMPLE'); answerMap.set(a.blindId, a);
  }
  const pairs = new Set<string>();
  for (const k of key.samples) {
    check(object(k) && !keyMap.has(k.blindId) && answerMap.has(k.blindId), 'INVALID_KEY_SAMPLE');
    const id = pairId(k.condition, k.ticket), s = index.get(id), a = answerMap.get(k.blindId)!;
    check(s && !pairs.has(id) && a.ticket === k.ticket, 'KEY_CASE_MAPPING');
    check(k.runId === s.runId && k.status === s.status && k.sourceSha256 === oldScoreHash(s), 'SOURCE_DRIFT');
    const expected = formatOldAnswer(s);
    check(a.answer === expected.text && k.answerSha256 === textHash(a.answer) && k.noAnswer === expected.noAnswer, 'ANSWER_DRIFT');
    pairs.add(id); keyMap.set(k.blindId,k);
  }
  check(reviewers.length === 2 && reviewers.every(r => typeof r.reviewerId === 'string' && r.reviewerId.trim())
    && reviewers[0].reviewerId !== reviewers[1].reviewerId, 'TWO_DISTINCT_REVIEWERS_REQUIRED');
  const records: Obj[] = [];
  for (const reviewer of reviewers) {
    check(Array.isArray(reviewer.records) && reviewer.records.length === n, 'RATING_CARDINALITY');
    const seen = new Set<string>();
    for (const r of reviewer.records) {
      check(object(r) && typeof r.blindId === 'string' && keyMap.has(r.blindId) && !seen.has(r.blindId), 'UNKNOWN_OR_DUPLICATE_RATING');
      const k = keyMap.get(r.blindId)!, a = answerMap.get(r.blindId)!; seen.add(r.blindId);
      check(r.ticket === k.ticket, 'RATING_TICKET');
      const ids = oldItemIds(rubrics[k.ticket]);
      check(object(r.items) && canonical(Object.keys(r.items).sort()) === canonical(ids.sort()), 'RATING_ITEMS');
      check(Object.values(r.items).every(v => typeof v === 'string' && own(itemValue,v)), 'INVALID_ITEM_GRADE');
      check(typeof r.correct === 'string' && own(correctValue,r.correct), 'INVALID_CORRECTNESS');
      for (const k of ['usable','clarity']) check(Number.isInteger(r[k]) && r[k] >= 1 && r[k] <= 5, 'INVALID_SCORE');
      check(['yes','partly','no'].includes(r.answersQuestion) && ['yes','no'].includes(r.saysWhatToDo), 'INVALID_COVERAGE');
      check(Array.isArray(r.issues) && r.issues.every((v: unknown) => typeof v === 'string') && typeof r.note === 'string', 'INVALID_NOTES');
      check(Array.isArray(r.wrongClaims), 'INVALID_WRONG_CLAIMS');
      for (const w of r.wrongClaims) check(object(w) && typeof w.quote === 'string' && w.quote.trim() && a.answer.includes(w.quote)
        && ['asserted','hedged'].includes(w.where), 'NONVERBATIM_OR_INVALID_QUOTE');
      if (k.noAnswer) check(r.usable === 1 && r.correct === 'none' && r.answersQuestion === 'no' && r.saysWhatToDo === 'no'
        && Object.values(r.items).every(v => v === 'miss') && !r.wrongClaims.length, 'NO_ANSWER_RULE');
      records.push({ ...structuredClone(r), reviewerId: reviewer.reviewerId, condition: k.condition });
    }
  }
  const aggregates = conditions.map(condition => {
    const rr = records.filter(r => r.condition === condition), samples = key.samples.filter(k => k.condition === condition);
    const both = (pred: (r: Obj) => boolean) => samples.filter(s => records.filter(r => r.blindId === s.blindId).every(pred)).length;
    return { condition, samples: tickets.length, ratings: rr.length,
      usable: mean(rr.map(r => r.usable)), pointScore: mean(rr.map(r => mean(Object.values(r.items).map(v => itemValue[v as string])))),
      correctnessScore: mean(rr.map(r => correctValue[r.correct])), wrongAssertedAverage: mean(rr.map(r => r.wrongClaims.filter((w: Obj) => w.where === 'asserted').length)),
      bothCorrectAndUsable: both(r => r.correct === 'correct' && r.usable >= 4) };
  });
  const disagreements = key.samples.flatMap(k => {
    const rr = records.filter(r => r.blindId === k.blindId);
    const fields = ['items','wrongClaims','usable','correct','clarity','answersQuestion','saysWhatToDo'].filter(f => canonical(rr[0][f]) !== canonical(rr[1][f]));
    return fields.length ? [{ blindId: k.blindId, condition: k.condition, ticket: k.ticket, fields }] : [];
  });
  return { valid: true, samples: n, ratings: records.length, aggregates, disagreements,
    notes: ['加权成因分不是准确率；两名评分者不是两次独立模型运行。', '基于冻结旧参考和实际公开答复；机械引文校验不证明断言判断在语义上正确。'] };
}
