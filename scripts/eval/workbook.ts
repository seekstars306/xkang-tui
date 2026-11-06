// M4-4：从运行记录与打分表计算 00-README.md §5 的全部指标，银标签与金标准分开输出。
// 二项比例一律用 S5 的精确区间（单侧 95% Clopper-Pearson + Wilson 双侧），不用正态近似。
import { clopperPearsonLower, clopperPearsonUpper, wilsonInterval } from '../../server/src/stats.ts';

export interface RunRecord {
  runId: string;
  caseId: string;
  variant: string;
  round: number;
  seconds: number;
  completed: boolean;
  /** 银标签：整答全对且可交付 */
  usable: boolean;
  /** 银标签：严重误导 */
  severeMisleading: boolean;
  /** 金标准标注（有则参与金标准表）：是否回答核心诉求 */
  coreDemandCovered?: boolean;
  /** 金标准结局（开发确认后填写） */
  goldVerdict?: 'delivered' | 'wrong' | 'severe';
  /** 违例次数（凭据/内部信息泄露等） */
  violations?: number;
}

export interface ProportionMetric {
  k: number;
  n: number;
  rate: number;
  cpLower: number;
  cpUpper: number;
  wilson: { lower: number; upper: number; center: number };
}

function proportion(k: number, n: number): ProportionMetric {
  return { k, n, rate: n ? k / n : 0, cpLower: n ? clopperPearsonLower(k, n) : 0, cpUpper: n ? clopperPearsonUpper(k, n) : 0, wilson: wilsonInterval(k, n) };
}

export interface MetricsReport {
  n: number;
  coverage: ProportionMetric & { source: string };
  deliveryCorrectness: ProportionMetric;
  severeRate: ProportionMetric;
  violationRate: ProportionMetric;
  timeP50: number;
  timeP90: number;
}

function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/**
 * 银标签指标：评分者是模型（ grades.json 的 usable / severeMisleading ）。
 * 本数据集（2026-10-09 受控运行）早于部分发布（R1），"交付"只有整答全对一种成功形态；
 * 未标注 coreDemandCovered 时覆盖率以 completed（正常结束）为代理并注明。
 */
export function computeSilverMetrics(records: readonly RunRecord[]): MetricsReport {
  const n = records.length;
  const withCoverage = records.filter(r => r.coreDemandCovered !== undefined);
  const coverageCount = withCoverage.length ? withCoverage.filter(r => r.coreDemandCovered).length : records.filter(r => r.completed).length;
  return {
    n,
    coverage: { ...proportion(coverageCount, n), source: withCoverage.length ? '金标准标注' : '代理：completed（正常结束）' },
    deliveryCorrectness: proportion(records.filter(r => r.usable).length, n),
    severeRate: proportion(records.filter(r => r.severeMisleading).length, n),
    violationRate: proportion(records.filter(r => (r.violations || 0) > 0).length, n),
    timeP50: percentile(records.map(r => r.seconds), 0.5),
    timeP90: percentile(records.map(r => r.seconds), 0.9),
  };
}

/** 金标准指标：仅统计有 goldVerdict 的记录；没有标注时返回 null */
export function computeGoldMetrics(records: readonly RunRecord[]): MetricsReport | null {
  const gold = records.filter(r => r.goldVerdict);
  if (!gold.length) return null;
  return {
    n: gold.length,
    coverage: { ...proportion(gold.filter(r => r.coreDemandCovered ?? r.goldVerdict === 'delivered').length, gold.length), source: '金标准标注' },
    deliveryCorrectness: proportion(gold.filter(r => r.goldVerdict === 'delivered').length, gold.length),
    severeRate: proportion(gold.filter(r => r.goldVerdict === 'severe').length, gold.length),
    violationRate: proportion(gold.filter(r => (r.violations || 0) > 0).length, gold.length),
    timeP50: percentile(gold.map(r => r.seconds), 0.5),
    timeP90: percentile(gold.map(r => r.seconds), 0.9),
  };
}

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;

export function formatMetrics(title: string, report: MetricsReport): string {
  return [
    `## ${title}（n=${report.n}）`,
    '',
    `- 覆盖率：${report.coverage.k}/${report.n} = ${pct(report.coverage.rate)}（CP 下界 ${pct(report.coverage.cpLower)}，Wilson [${pct(report.coverage.wilson.lower)}, ${pct(report.coverage.wilson.upper)}]；口径：${report.coverage.source}）`,
    `- 交付正确率（整答口径）：${report.deliveryCorrectness.k}/${report.n} = ${pct(report.deliveryCorrectness.rate)}（CP 下界 ${pct(report.deliveryCorrectness.cpLower)}，Wilson [${pct(report.deliveryCorrectness.wilson.lower)}, ${pct(report.deliveryCorrectness.wilson.upper)}]）`,
    `- 严重误导率：${report.severeRate.k}/${report.n} = ${pct(report.severeRate.rate)}（CP 上界 ${pct(report.severeRate.cpUpper)}，Wilson [${pct(report.severeRate.wilson.lower)}, ${pct(report.severeRate.wilson.upper)}]）`,
    `- 违例率：${report.violationRate.k}/${report.n} = ${pct(report.violationRate.rate)}（CP 上界 ${pct(report.violationRate.cpUpper)}）`,
    `- 耗时：P50 ${report.timeP50.toFixed(1)}s / P90 ${report.timeP90.toFixed(1)}s`,
  ].join('\n');
}
