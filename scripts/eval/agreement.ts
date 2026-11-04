// M4-3：评分者间一致率（原始一致率 + Cohen's Kappa）与不确定度（复用 S5 的区间函数）。
// 支持同一评分者对 20% 子集的复评一致性。
import { clopperPearsonLower, wilsonInterval } from '../../server/src/stats.ts';

export interface AgreementSummary {
  n: number;
  agreements: number;
  rawAgreement: number;
  kappa: number | null;
  rawAgreementCpLower: number;
  rawAgreementWilson: { lower: number; upper: number; center: number };
}

/** 原始一致率 */
export function rawAgreement(raterA: readonly string[], raterB: readonly string[]): { n: number; agreements: number; rate: number } {
  if (raterA.length !== raterB.length) throw new Error('两位评分者的条目数不一致');
  let agreements = 0;
  for (let i = 0; i < raterA.length; i++) if (raterA[i] === raterB[i]) agreements++;
  return { n: raterA.length, agreements, rate: raterA.length ? agreements / raterA.length : 0 };
}

/** Cohen's Kappa：po 为观测一致率，pe 为随机期望一致率；类别单一（pe=1）时返回 null */
export function cohensKappa(raterA: readonly string[], raterB: readonly string[]): { po: number; pe: number; kappa: number | null } {
  const { rate: po } = rawAgreement(raterA, raterB);
  const categories = [...new Set([...raterA, ...raterB])];
  const countA = new Map(categories.map(c => [c, 0])), countB = new Map(categories.map(c => [c, 0]));
  for (const value of raterA) countA.set(value, (countA.get(value) || 0) + 1);
  for (const value of raterB) countB.set(value, (countB.get(value) || 0) + 1);
  const n = raterA.length;
  if (!n) return { po, pe: 0, kappa: null };
  let pe = 0;
  for (const category of categories) pe += ((countA.get(category) || 0) / n) * ((countB.get(category) || 0) / n);
  if (pe >= 1) return { po, pe, kappa: null };
  return { po, pe, kappa: (po - pe) / (1 - pe) };
}

/** 汇总一致率并给出单侧 95% 下界与 Wilson 双侧区间 */
export function summarizeAgreement(raterA: readonly string[], raterB: readonly string[]): AgreementSummary {
  const { n, agreements, rate } = rawAgreement(raterA, raterB);
  const { kappa } = cohensKappa(raterA, raterB);
  return { n, agreements, rawAgreement: rate, kappa, rawAgreementCpLower: n ? clopperPearsonLower(agreements, n) : 0, rawAgreementWilson: wilsonInterval(agreements, n) };
}

/** 同一评分者的复评一致性：传入全量首评与 20% 子集的复评（按 runId 对齐） */
export function selfReAgreement(firstPass: ReadonlyMap<string, string>, secondPass: ReadonlyMap<string, string>): AgreementSummary {
  const overlap = [...secondPass.keys()].filter(id => firstPass.has(id));
  return summarizeAgreement(overlap.map(id => firstPass.get(id)!), overlap.map(id => secondPass.get(id)!));
}
