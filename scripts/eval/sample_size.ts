// 正式验收样本量推导：给定门槛下界、真实正确率与单次通过概率要求，输出所需样本量。
// 用法: npx tsx scripts/eval/sample_size.ts --lower=0.90 --accuracy=0.96 --power=0.90 [--alpha=0.05] [--max-n=20000] [--at-n=105]
// 判定口径与 00-README.md §5 一致：交付工单的整答正确率单侧 95% Clopper-Pearson 下界 ≥ lower 才算通过。
import { binomialTailGE } from '../../server/src/stats.ts';

function argNumber(name: string, fallback: number): number {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  const value = hit === undefined ? fallback : Number(hit.slice(name.length + 3));
  if (!Number.isFinite(value)) throw new Error(`参数 --${name} 不是有效数字: ${hit}`);
  return value;
}

const lower = argNumber('lower', 0.9);
const accuracy = argNumber('accuracy', 0.96);
const requiredPower = argNumber('power', 0.9);
const alpha = argNumber('alpha', 0.05);
const maxN = Math.floor(argNumber('max-n', 20000));
const atN = process.argv.find(a => a.startsWith('--at-n='));
for (const [name, value] of [['lower', lower], ['accuracy', accuracy], ['power', requiredPower], ['alpha', alpha]] as const) {
  if (!(value > 0 && value < 1)) throw new Error(`参数 --${name} 必须在 (0,1) 内: ${value}`);
}

/**
 * 最小通过交付数：clopperPearsonLower(d, n) >= lower 等价于 P(Bin(n, lower) >= d) <= alpha（尾部关于 p 单调递增）。
 * 全对仍不满足时返回 n + 1。
 */
function minPassingDeliveries(n: number): number {
  if (binomialTailGE(n, n, lower) > alpha) return n + 1;
  let lo = 0, hi = n;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (binomialTailGE(n, mid, lower) <= alpha) hi = mid; else lo = mid;
  }
  return hi;
}

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
console.log(`样本量推导: 门槛下界 ${pct(lower)}（单侧 ${pct(1 - alpha)} Clopper-Pearson），真实正确率 ${pct(accuracy)}，要求单次通过概率 ≥ ${pct(requiredPower)}`);
console.log('说明: 覆盖率下限另行计算——交付数还需同时满足 ≥ 覆盖率下限 × n；本工具只推导正确率门槛。');

if (atN !== undefined) {
  const n = Math.floor(Number(atN.slice(7)));
  const dMin = minPassingDeliveries(n);
  const power = binomialTailGE(n, dMin, accuracy);
  console.log(`n=${n}: 需 ≥${dMin > n ? n + 1 + '（无解）' : dMin} 单交付且整答正确，通过概率 ${pct(power)}`);
} else {
  for (let n = 1; n <= maxN; n++) {
    const dMin = minPassingDeliveries(n);
    if (dMin > n) continue;
    const power = binomialTailGE(n, dMin, accuracy);
    if (power >= requiredPower) {
      console.log(`结果: 最小样本量 n=${n}（需 ≥${dMin} 单交付且整答正确，通过概率 ${pct(power)}）`);
      const previous = minPassingDeliveries(n - 1);
      if (previous <= n - 1) console.log(`对照: n=${n - 1} 时需 ≥${previous} 单，通过概率 ${pct(binomialTailGE(n - 1, previous, accuracy))}`);
      break;
    }
    if (n === maxN) console.log(`未找到: max-n=${maxN} 内最高通过概率仅 ${pct(power)}（n=${maxN}），请调低 power 或提高 accuracy 预期。`);
  }
}
