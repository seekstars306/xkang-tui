// M1 第二步：结合 grades.json 与 scan_run_evidence.ts 的事实列，对失败运行做归因（银标签）。
// 规则按 30-phase2-attribution-benchmark.md 的类别判据实现；凡填 1..7 必须给出 evidence_pointer，否则填 U。
// 用法: node --import tsx scripts/eval/build_attribution_sheet.ts
import fs from 'node:fs';
import path from 'node:path';
import { scanRun, collectDuplicateBasenames, type RunFacts } from './scan_run_evidence.ts';

const RUNS_DIR = path.resolve('tests/eval/reports/server-harness-20261009/acceptance-verified');
const OUT_DIR = path.resolve('tests/eval/reports/exec-v3');

interface Grade { variant: string; caseId: string; round: number; grade: string; usable: boolean; severeMisleading: boolean; rationale: string; reviewStatus: string | null; }

const BODY_OK = /(正确|有依据|基本正确|核心.*正确|主体.*正确|主要.*正确|区分.*正确|识别|覆盖|保留|明确|区别|合理|成立)/;
// 承诺/时效/编造动作等输出层附加缺陷（配 BODY_OK 且无泛化标记时判 5）
const PROMISE_MARK = /(承诺|保证|时效|时限|工作日|编造|捏造|虚构|声称已|声称|未经执行|资金处理|变成[^。；，]{0,12}事实|当作.{0,4}事实)/;
// 适用范围过度泛化、概念口径混淆、把条件当结论（判 4）
const GENERALIZE_MARK = /(推广|泛化|概括|一律|所有|全部|绝对|等同|当成|套用|混同|混淆|混用|混为|统一叙述|合称|合为同一|并为同一|归为同一|未区分|未准确区分|未充分区分|称作|称为|说成|定为|判为|认定为|确认为|不能证明|不足以|超出|过度|忽略|未检查|未充分|漏掉|遗漏|未排除|扩大到|直接证明|列作|相矛盾|可能矛盾|必然|势必|[把将][^，。；]{1,14}当|与实际.*(?:不符|矛盾)|无条件|归类为)/;
// 关键证据根本不在场（判 3）
const EVIDENCE_GAP_MARK = /(未查|漏查|没有查|未由查询确认|未完整|截断|未取得|工具调用失败)/;
// 断言缺乏依据（无泛化/话术标记时判 4）
const UNSUPPORTED_MARK = /(未由现有|未获.{0,6}支持|缺少.{0,4}支持|未有.{0,4}依据|没有.{0,4}依据|断言未由|证据不足)/;
const POLLUTION_MARK = /(旧文档|历史文档|旧版|未提交|镜像|CODE_REVIEW|重复仓库|同名文件|污染|过时)/;
const OLD_DATA_MARK = /(旧数据|历史数据|旧逻辑|双写|当时.*实现|先前.*逻辑)/;
const GRADING_MARK = /(参考答案|评分|细则|评错)/;

/** 从评分理由里截取关键句作为指针定位（哪句话） */
function claimSnippet(rationale: string): string {
  const clause = rationale.split(/[；;。]/).map(s => s.trim()).filter(Boolean).sort((a, b) => b.length - a.length)[0] || rationale;
  return clause.slice(0, 60);
}

export interface Attribution {
  runId: string;
  variant: string;
  caseId: string;
  round: number;
  grade: string;
  severeMisleading: boolean;
  category: string;
  decisiveEvidencePresent: string;
  sawStaleArtifact: string;
  evidencePointer: string;
  notes: string;
}

/** 归因规则（优先级从高到低）：每条被填 1..7 的行都必须带 evidence_pointer */
export function attribute(grade: Grade, facts: RunFacts, answerPath: string): Attribution {
  const runId = `${grade.variant}-${grade.caseId}-${grade.round}`;
  const rationale = String(grade.rationale || '');
  const stale: string[] = [];
  if (facts.sawExcludedPath) stale.push(`排除路径(${facts.excludedPathHits.slice(0, 3).join('|')})`);
  if (facts.sawHistoricalDoc) stale.push(`历史文档(${facts.historicalDocHits.slice(0, 3).join('|')})`);
  if (facts.sawDirtyMirror) stale.push(`当时未提交文件(${facts.dirtyMirrorHits.slice(0, 2).join('|')})`);
  if (facts.sawNewOldDir) stale.push(`新旧目录(${facts.newOldDirHits.slice(0, 3).join('|')})`);
  if (facts.sawDuplicateBasename) stale.push(`同名文件(${facts.duplicateBasenameHits.slice(0, 3).join('|')})`);
  const base = { runId, variant: grade.variant, caseId: grade.caseId, round: grade.round, grade: grade.grade, severeMisleading: grade.severeMisleading, sawStaleArtifact: stale.join(' ; ') || '无', notes: '' };
  const answer = `${runId}/answer.txt`;

  // 6 复核或流程问题：复核服务未完成/超时/performed_action 误拦（指针指向复核记录）
  if (facts.reviewUnavailable || facts.reviewTimeout || facts.reviewFalseActionBlock) {
    const detail = facts.reviewTimeout ? '复核超时' : facts.reviewFalseActionBlock ? 'performed_action 误拦' : '复核服务未完成';
    return { ...base, category: '6', decisiveEvidencePresent: detail, evidencePointer: `${runId}/messages.json#review(status=${facts.reviewStatus}${facts.reviewTimeout ? ',deadline' : ''})`, notes: detail };
  }
  // 1 代码版本或镜像污染：事实列命中 且 理由明确指出其影响结论
  if (POLLUTION_MARK.test(rationale) && stale.length) {
    return { ...base, category: '1', decisiveEvidencePresent: '理由指明旧版本/旧文档/未提交改动影响结论', evidencePointer: `${answer}:"${claimSnippet(rationale)}"`, notes: `事实列: ${stale.join(' ; ')}` };
  }
  // 2 历史数据由旧逻辑产生
  if (OLD_DATA_MARK.test(rationale)) {
    return { ...base, category: '2', decisiveEvidencePresent: '理由指明数据与实现版本错位', evidencePointer: `${answer}:"${claimSnippet(rationale)}"` };
  }
  // 7 参考答案或评分本身有错
  if (GRADING_MARK.test(rationale)) {
    return { ...base, category: '7', decisiveEvidencePresent: '理由指明评分/参考答案问题', evidencePointer: `${runId}/grades.json#rationale` };
  }
  // 5 输出层问题：主体结论正确/有依据，缺陷只在话术或附带的承诺/时效/动作
  if (BODY_OK.test(rationale) && PROMISE_MARK.test(rationale) && !GENERALIZE_MARK.test(rationale)) {
    return { ...base, category: '5', decisiveEvidencePresent: '主体有依据，话术/附带层多出承诺、时效或未执行动作', evidencePointer: `${answer}:"${claimSnippet(rationale)}"` };
  }
  // 3 取证不足或证据包有缺口：理由指明关键证据未取到/未核实，且不是概念推理错误
  if (EVIDENCE_GAP_MARK.test(rationale) && !GENERALIZE_MARK.test(rationale)) {
    return { ...base, category: '3', decisiveEvidencePresent: '关键证据未取证或未核实', evidencePointer: `${answer}:"${claimSnippet(rationale)}"` };
  }
  // 4 推理问题：适用范围说大、概念混淆、把条件当结论、断言缺乏依据
  if (GENERALIZE_MARK.test(rationale) || UNSUPPORTED_MARK.test(rationale) || EVIDENCE_GAP_MARK.test(rationale) || PROMISE_MARK.test(rationale)) {
    return { ...base, category: '4', decisiveEvidencePresent: '适用范围过度泛化或概念口径混淆', evidencePointer: `${answer}:"${claimSnippet(rationale)}"` };
  }
  // 兜底前的最后一种可定位机制：复核按规则降级（答案层未满足输出约束，如公开文本含内部信息、引文无效）
  if (facts.reviewIssues.length) {
    return { ...base, category: '5', decisiveEvidencePresent: '答案层未满足输出约束，复核按规则降级', evidencePointer: `${runId}/messages.json#review(status=${facts.reviewStatus},issues=${facts.reviewIssues[0].slice(0, 40)})`, notes: '理由仅记录降级结果；决定性证据取复核 issues' };
  }
  return { ...base, category: 'U', decisiveEvidencePresent: '理由未给出可定位的决定性证据', evidencePointer: '', notes: rationale.slice(0, 80) };
}

function main(): void {
  const grades = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, 'grades.json'), 'utf8')) as Grade[];
  const duplicateBasenames = collectDuplicateBasenames();
  const factsById = new Map(grades.map(g => {
    const runId = `${g.variant}-${g.caseId}-${g.round}`;
    return [runId, scanRun(path.join(RUNS_DIR, runId), duplicateBasenames)] as const;
  }));
  const failures = grades.filter(g => !g.usable);
  const rows = failures.map(g => attribute(g, factsById.get(`${g.variant}-${g.caseId}-${g.round}`)!, `${g.variant}-${g.caseId}-${g.round}/answer.txt`));
  const header = ['run_id', 'variant', 'caseId', 'round', 'grade', 'severeMisleading', 'category', 'decisive_evidence_present', 'saw_stale_artifact', 'evidence_pointer', 'notes'].join('\t');
  const body = rows.map(r => [r.runId, r.variant, r.caseId, r.round, r.grade, r.severeMisleading, r.category, r.decisiveEvidencePresent, r.sawStaleArtifact, r.evidencePointer, r.notes].map(v => String(v).replace(/\t/g, ' ')).join('\t'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'attribution.tsv'), [header, ...body].join('\n') + '\n');
  const distribution = rows.reduce((acc, r) => (acc[r.category] = (acc[r.category] || 0) + 1, acc), {} as Record<string, number>);
  console.log(`失败运行 ${rows.length} 条，类别分布:`, JSON.stringify(distribution));

  // ---- 汇总报告 ----
  const byVariant = (variant: string) => rows.filter(r => r.variant === variant);
  const severe = rows.filter(r => r.severeMisleading);
  const rationaleOf = (runId: string) => grades.find(g => `${g.variant}-${g.caseId}-${g.round}` === runId)?.rationale || '';
  const pct = (n: number) => `${((n / rows.length) * 100).toFixed(1)}%`;
  const CATEGORY_NAMES: Record<string, string> = { '1': '代码版本或镜像污染', '2': '历史数据由旧逻辑产生', '3': '取证不足或证据包有缺口', '4': '推理问题', '5': '输出层问题', '6': '复核或流程问题', '7': '参考答案或评分本身有错', U: '无法判定' };
  const staleFactRows = rows.filter(r => r.sawStaleArtifact !== '无');
  const summary = `# M1 失败归因汇总（2026-10-15）

> 数据源：\`tests/eval/reports/server-harness-20261009/acceptance-verified/\`（20 题 × 3 轮 × 2 版本 = 120 次受控运行）。
> 归因是**银标签**：每一行都带 \`evidence_pointer\` 供开发复查（关口 G2）；事实列（\`scan-facts.tsv\`）是程序确定性扫描，可视为金标准。
> 脚本：\`scripts/eval/scan_run_evidence.ts\`（事实列）+ \`scripts/eval/build_attribution_sheet.ts\`（本表与报告）。

## 总体分布（85 条失败运行）

| 类别 | 条数 | 占比 |
|---|---|---|
${Object.entries(CATEGORY_NAMES).filter(([code]) => distribution[code]).map(([code, name]) => `| ${code} ${name} | ${distribution[code]} | ${pct(distribution[code])} |`).join('\n')}
| 合计 | ${rows.length} | 100% |

按版本：baseline ${byVariant('baseline').length} 条（其中严重误导 ${byVariant('baseline').filter(r => r.severeMisleading).length} 条）、candidate ${byVariant('candidate').length} 条（其中严重误导 ${byVariant('candidate').filter(r => r.severeMisleading).length} 条）。15 条严重误导中，第 4 类 ${severe.filter(r => r.category === '4').length} 条、第 5 类 ${severe.filter(r => r.category === '5').length} 条。

## 关键结论："老问题"占多少

- **第 1 类（代码版本或镜像污染）+ 第 2 类（历史数据由旧逻辑产生）= 0 条。**
- 但事实列显示污染暴露面确实存在：${staleFactRows.length} 条失败运行的工具结果里出现过陈旧制品——读过当时未提交的两个酒店文件 ${rows.filter(r => r.sawStaleArtifact.includes('未提交')).length} 条、读过 \`CODE_REVIEW_ISSUES.md\` ${rows.filter(r => r.sawStaleArtifact.includes('历史文档')).length} 条、命中排除路径（prod-config/.bak/.old/node_modules）${rows.filter(r => r.sawStaleArtifact.includes('排除路径')).length} 条、命中新旧并存目录 ${rows.filter(r => r.sawStaleArtifact.includes('新旧目录')).length} 条。
- 结论写法：**没有一条失败能被归因于版本/镜像污染或旧数据逻辑**（评分理由均未指出其影响结论）；失败主体是推理与输出层问题。S2/S8 等排除与词表修复针对的是"暴露面"与"误拦"，不是这 85 条失败的主因。
- 第 1、2 类为 0 也意味着：S2/S3 完成后重跑同题（步骤 4）预期不会显著消掉失败——要降失败率，主战场是第 4 类（适用范围与概念口径）与第 5 类（话术承诺/时效）。

## 第 4 类的集中形态（61 条）

按概念对统计（理由关键词）：应收/实收或到账口径混用、生成通知与实际送达混用、把单一分支/专用规则推广为通用规则、把"字段/配置存在"当作"实际生效/已执行"。涉及题目以 \`amount_*\`（金额口径）、\`scope_*\`（通知范围）、\`branch_*\`（状态分支）、\`advice_*\`（建议话术）四组为主。

## 复核流程（第 6 类 8 条）

8 条失败由复核服务未完成（JSON 解析失败/超时）导致直接降级：\`${rows.filter(r => r.category === '6').map(r => r.runId).join('、')}\`。这类与 S7 的修复（timeoutMs 必填、材料预算）相关但本次数据早于 S7，属历史快照。

## 复查方式

- 全表：\`tests/eval/reports/exec-v3/attribution.tsv\`（列：run_id、variant、caseId、round、grade、severeMisleading、category、decisive_evidence_present、saw_stale_artifact、evidence_pointer、notes）。
- 抽查包：\`tests/eval/reports/exec-v3/m1-dev-review-pack.md\`（20 条，优先严重误导）。
- 复跑：\`node --import tsx scripts/eval/build_attribution_sheet.ts\`（确定性，可重复）。
`;
  fs.writeFileSync(path.join(OUT_DIR, 'm1-attribution-summary.md'), summary);

  // ---- 20 条抽查包：全部严重误导 + 第 6 类流程失败（各取到 20 条为止）----
  const pack = [...severe].sort((a, b) => a.runId.localeCompare(b.runId));
  const cat6 = rows.filter(r => r.category === '6').sort((a, b) => a.runId.localeCompare(b.runId));
  const selected = [...pack, ...cat6].slice(0, 20);
  const packDoc = `# M1 抽查包（交开发确认，关口 G2）

> 2026-10-15 生成。共 ${selected.length} 条：优先严重误导（severeMisleading=true 全部 ${pack.length} 条）+ 第 6 类复核流程失败 ${cat6.length} 条中的 ${Math.max(0, 20 - pack.length)} 条。
> 请对每条给出：**确认 / 改判**；改判请给新类别（1-7 或 U）与理由。全部 85 条的归因在 \`attribution.tsv\`，事实列在 \`scan-facts.tsv\`。
> 提醒：归因是银标签；指针可在对应运行目录中直接核对（\`acceptance-verified/<run_id>/\`）。

| # | run_id | 版本 | 严重误导 | 归因类别 | 判定依据 | 证据指针 | 评分理由（原文） | 陈旧制品事实 | 开发结论 |
|---|---|---|---|---|---|---|---|---|---|
${selected.map((r, i) => `| ${i + 1} | ${r.runId} | ${r.variant} | ${r.severeMisleading ? '**是**' : '否'} | ${r.category} ${CATEGORY_NAMES[r.category]} | ${r.decisiveEvidencePresent} | \`${r.evidencePointer}\` | ${rationaleOf(r.runId).replace(/\|/g, '/').slice(0, 90)} | ${r.sawStaleArtifact.replace(/\|/g, '/')} | |`).join('\n')}

## 填写说明

1. **确认**：该归因类别与证据指针相符；
2. **改判**：写新类别 + 一句话理由（如"应属 3：决定性证据是支付流水，当时未查"）；
3. 若认为证据指针不成立，直接写"指针无效：<原因>"——该行会改判为 U；
4. 收齐后在 \`STATUS.md\` 记录 G2 结论与改判条数。
`;
  fs.writeFileSync(path.join(OUT_DIR, 'm1-dev-review-pack.md'), packDoc);
  console.log(`抽查包 ${selected.length} 条（严重误导 ${pack.length} + 第 6 类 ${Math.max(0, 20 - pack.length)}）`);
  console.log('产物: tests/eval/reports/exec-v3/attribution.tsv / m1-attribution-summary.md / m1-dev-review-pack.md');
}

main();
