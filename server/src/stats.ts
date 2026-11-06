// 二项比例的精确区间与样本量工具。全部用对数伽马 + 不完全贝塔/伽马实现，不用正态近似。
// 锚点值见 tests/server/stats.test.ts（由独立数值积分脚本复算，容差 0.01 个百分点）。

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
const ITMAX = 500;
const EPS = 1e-16;
const FPMIN = 1e-300;

/** Lanczos 逼近的对数伽马函数 */
export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7 + 0.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 正则化不完全贝塔函数 I_x(a, b)（连分式展开 + 对称性） */
export function regularizedBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lnBt);
  if (x < (a + 1) / (a + b + 2)) return (bt * betaContinuedFraction(a, b, x)) / a;
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** 不完全贝塔的连分式（Lentz 算法） */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= ITMAX; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) <= EPS) break;
  }
  return h;
}

/** 正则化上不完全伽马 Q(a, x)（级数 + 连分式） */
function gammaUpper(a: number, x: number): number {
  if (x <= 0) return 1;
  const lnPrefactor = -x + a * Math.log(x) - logGamma(a);
  if (x < a + 1) {
    // 级数求 P(a, x)，再取 1-P
    let ap = a, sum = 1 / a, del = sum;
    for (let i = 0; i < ITMAX; i++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) break;
    }
    return 1 - sum * Math.exp(lnPrefactor);
  }
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) <= EPS) break;
  }
  return h * Math.exp(lnPrefactor);
}

/** erfc(x) = Q(1/2, x²)；x<0 时用 erfc(-x) = 2 - erfc(x) */
function erfc(x: number): number {
  const q = gammaUpper(0.5, x * x);
  return x >= 0 ? q : 2 - q;
}

/** 标准正态分布 CDF */
export function normalCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** 标准正态分布分位数（二分，单调精确到双精度） */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`p 必须在 (0,1) 内: ${p}`);
  let lo = -40, hi = 40;
  for (let i = 0; i < 200 && hi - lo > 1e-15; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function assertCounts(n: number, k: number, fullRange = false): void {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`n 必须是非负整数: ${n}`);
  if (!Number.isInteger(k)) throw new RangeError(`k 必须是整数: ${k}`);
  if (fullRange && (n < 1 || k < 0 || k > n)) throw new RangeError(`k/n 不合法: ${k}/${n}`);
}
function assertAlpha(alpha: number): void {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`alpha 必须在 (0,1) 内: ${alpha}`);
}

/** 二项分布上尾概率 P(X >= k)，X ~ Binomial(n, p) */
export function binomialTailGE(n: number, k: number, p: number): number {
  assertCounts(n, k);
  if (!(p >= 0 && p <= 1)) throw new RangeError(`p 必须在 [0,1] 内: ${p}`);
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return regularizedBeta(k, n - k + 1, p);
}

/** 在 [0,1] 上二分求解单调递增函数 f(p) = target */
function bisectIncreasing(f: (p: number) => number, target: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 单侧下界：解 P(X >= k | p) = alpha（“正确率下界 ≥ 门槛”用） */
export function clopperPearsonLower(k: number, n: number, alpha = 0.05): number {
  assertCounts(n, k, true);
  assertAlpha(alpha);
  if (k === 0) return 0;
  return bisectIncreasing(p => binomialTailGE(n, k, p), alpha);
}

/** 单侧上界：解 P(X <= k | p) = alpha（“0 例严重误导”用） */
export function clopperPearsonUpper(k: number, n: number, alpha = 0.05): number {
  assertCounts(n, k, true);
  assertAlpha(alpha);
  if (k === n) return 1;
  return bisectIncreasing(p => binomialTailGE(n, k + 1, p), 1 - alpha);
}

export interface WilsonInterval {
  lower: number;
  upper: number;
  center: number;
}

/** Wilson 双侧置信区间（摸底报告与 CP 并列给出） */
export function wilsonInterval(k: number, n: number, alpha = 0.05): WilsonInterval {
  assertCounts(n, k, true);
  assertAlpha(alpha);
  const pHat = k / n;
  const z = normalQuantile(1 - alpha / 2);
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (pHat + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n))) / denom;
  return { lower: center - half, upper: center + half, center };
}
