// M2-1：复核基准用例表。原 18 条受控虚构用例从 review_optimization.ts 原样抽离（一条不少），R5 另加 1 条角色归因回归用例，
// 新增 category 与 origin 字段；另从 acceptance-verified 补入脱敏后的真实案例（见 sanitize_case.ts）。
// 期望判断只用于事后统计，绝不进入模型输入（与 review_optimization.ts 的既有纪律一致）。
import fs from 'node:fs';
import path from 'node:path';
import { buildCaseFromRun } from './sanitize_case.ts';

export type CaseCategory = 'overgeneralization' | 'unsupported_assertion' | 'material_request' | 'false_action' | 'branch_scope' | 'config_as_effect' | 'citation_mismatch';
export type CaseOrigin = 'fictional' | `real-failure:${string}` | `real-correct:${string}`;

export interface BenchmarkCase {
  id: string;
  question: string;
  source: string;
  answer: unknown;
  expected: boolean;
  category: CaseCategory;
  origin: CaseOrigin;
}

const draft = (conclusion: string, businessData: Array<{ label: string; value: string }> = []) => ({ conclusion, businessData, evidenceSummary: [], customerReply: '', pendingItems: [] });

/** 受控虚构用例：前 18 条与 2026-10-09 版 review_optimization.ts 逐条一致（仅追加 category/origin），第 19 条 duplicate_invoice_actor_role 为 R5 角色归因/状态词回归新增 */
export const FICTIONAL_CASES: BenchmarkCase[] = [
  { id: 'receipt_supported', question: '说明这次设备检修申请的受理与完成情况。', source: '申请R-001：已受理。记录没有检修完成时间，也没有完工通知。', answer: draft('检修申请已受理。当前记录没有完成时间，仍需核实办理进度。'), expected: true, category: 'branch_scope', origin: 'fictional' },
  { id: 'receipt_invented_deadline', question: '说明这次设备检修申请的受理与完成情况。', source: '申请R-001：已受理。记录没有检修完成时间，也没有完工通知。', answer: draft('检修申请已受理；将在两个工作日内完成。'), expected: false, category: 'unsupported_assertion', origin: 'fictional' },
  { id: 'equipment_scoped', question: '设备领用是否都只需部门审批？', source: '普通设备领用：部门审批通过即可领取。精密仪器领用：部门审批通过后，还须完成资质核验。', answer: draft('普通设备在部门审批通过后可领取；精密仪器还须完成资质核验。'), expected: true, category: 'branch_scope', origin: 'fictional' },
  { id: 'equipment_overgeneralized', question: '设备领用是否都只需部门审批？', source: '普通设备领用：部门审批通过即可领取。精密仪器领用：部门审批通过后，还须完成资质核验。', answer: draft('部门审批是领用条件；所有设备只要部门审批通过就能领取。'), expected: false, category: 'overgeneralization', origin: 'fictional' },
  { id: 'inventory_scoped', question: '两个仓库是否都没有库存？', source: '本次只查询甲仓，结果0件，甲仓查询已完整返回。乙仓尚未查询。', answer: draft('甲仓查询结果为0件；乙仓尚未查询，不能确定两个仓库都没有库存。'), expected: true, category: 'branch_scope', origin: 'fictional' },
  { id: 'inventory_negative', question: '两个仓库是否都没有库存？', source: '本次只查询甲仓，结果0件，甲仓查询已完整返回。乙仓尚未查询。', answer: draft('甲仓查询结果为0件；两个仓库都没有库存。'), expected: false, category: 'overgeneralization', origin: 'fictional' },
  { id: 'reservation_premise', question: '假设场地预约已经取消，能否说明之前没有支付过押金？只解释规则，不核查具体预约。', source: '场地预约流程与押金收支分别记录。已付押金的预约也可以取消，之后另行办理押金退回。', answer: draft('按预约已取消的题设，仍不能说明此前没有支付押金；需要另查押金收支记录。'), expected: true, category: 'branch_scope', origin: 'fictional' },
  { id: 'reservation_false_action', question: '假设场地预约已经取消，能否说明之前没有支付过押金？只解释规则，不核查具体预约。', source: '场地预约流程与押金收支分别记录。已付押金的预约也可以取消，之后另行办理押金退回。', answer: draft('取消与押金收支分别记录；我已通知财务退回押金。'), expected: false, category: 'false_action', origin: 'fictional' },
  { id: 'business_identifiers', question: '原样核对演示客户的联系方式、证件和订单金额。', source: '演示客户：测试甲；联系电话：0013912345678；证件号码：11010119920202002X；订单号：009876543210987654321；金额：12.50元。', answer: draft('已核对到演示客户资料。', [{ label: '联系电话', value: '0013912345678' }, { label: '证件号码', value: '11010119920202002X' }, { label: '订单号', value: '009876543210987654321' }, { label: '金额', value: '12.50元' }]), expected: true, category: 'branch_scope', origin: 'fictional' },
  { id: 'pending_request', question: '说明检修申请现状，列出进一步核对所需资料。', source: '检修申请已受理。', answer: { ...draft('检修申请已受理。'), pendingItems: ['请提供申请编号以便核对。'] }, expected: true, category: 'material_request', origin: 'fictional' },
  { id: 'pending_time_request', question: '说明检修申请现状，列出进一步核对所需资料。', source: '检修申请已受理。', answer: { ...draft('检修申请已受理。'), pendingItems: ['请提供申请时间以便进一步核对。'] }, expected: true, category: 'material_request', origin: 'fictional' },
  { id: 'pending_mandatory_rule', question: '说明检修申请现状，列出进一步核对所需资料。', source: '检修申请已受理。记录不含办理前置条件。', answer: { ...draft('检修申请已受理。'), pendingItems: ['建议补充申请时间，否则系统必定无法办理后续手续。'] }, expected: false, category: 'unsupported_assertion', origin: 'fictional' },
  { id: 'pending_hidden_rule', question: '说明检修申请现状，列出进一步核对所需资料。', source: '检修申请已受理。记录不含服务时限或赔偿规则。', answer: { ...draft('检修申请已受理。'), pendingItems: ['请等待三天，超过三天系统必然自动赔偿。'] }, expected: false, category: 'unsupported_assertion', origin: 'fictional' },
  { id: 'cached_destination_false', question: '地址簿查询无结果时，这份报表是否一定无法寄出？', source: '完整寄送函数：\nfunction deliver(job) {\n  let destination = job.savedAddress;\n  const entry = directory.findActive(job.owner);\n  if (entry) destination = entry.address;\n  if (destination) courier.send(destination, job.report);\n}\n寄送服务接收地址后提交寄件；不另外查询地址簿。', answer: draft('寄送前必须查到有效地址簿记录；查无记录就不会寄出。'), expected: false, category: 'overgeneralization', origin: 'fictional' },
  { id: 'cached_destination_scoped', question: '地址簿查询无结果时，这份报表是否一定无法寄出？', source: '完整寄送函数：\nfunction deliver(job) {\n  let destination = job.savedAddress;\n  const entry = directory.findActive(job.owner);\n  if (entry) destination = entry.address;\n  if (destination) courier.send(destination, job.report);\n}\n寄送服务接收地址后提交寄件；不另外查询地址簿。', answer: draft('查无地址簿记录时仍保留任务中保存的地址；该地址有值时仍会提交寄件，不能据此确认实际送达。'), expected: true, category: 'branch_scope', origin: 'fictional' },
  { id: 'guard_blocks_destination', question: '地址簿查询无结果时，这份报表是否仍会寄出？', source: '完整寄送函数：\nfunction deliver(job) {\n  const entry = directory.findActive(job.owner);\n  if (!entry) return;\n  courier.send(entry.address, job.report);\n}', answer: draft('在此寄送流程中，查无有效地址簿记录会直接结束，无法进入寄件步骤。'), expected: true, category: 'branch_scope', origin: 'fictional' },
  { id: 'overwritten_price_false', question: '所有材料订单的手续费是否都是默认的12元？', source: '完整计费函数：\nfunction charge(order) {\n  let fee = 12;\n  if (order.vip) fee = 0;\n  else if (order.expedited) fee = 25;\n  return fee;\n}', answer: draft('所有材料订单手续费都是12元。'), expected: false, category: 'overgeneralization', origin: 'fictional' },
  { id: 'overwritten_price_scoped', question: '所有材料订单的手续费是否都是默认的12元？', source: '完整计费函数：\nfunction charge(order) {\n  let fee = 12;\n  if (order.vip) fee = 0;\n  else if (order.expedited) fee = 25;\n  return fee;\n}', answer: draft('会员订单手续费为0元；非会员加急订单为25元；其他订单为12元。'), expected: true, category: 'branch_scope', origin: 'fictional' },
  { id: 'duplicate_invoice_actor_role', question: '说明这两张金额相同的发票为何重复开具、之后如何冲红。', source: '发票记录（表 invoice_customer_info；字段说明：kpr=开票人，fpstatus=4 蓝被红冲、7 红冲单）：\nrow1: fptqm=0001, jshj=909.00, fpstatus=4, c_time=2026-10-14 14:30:45, kpr=王甲\nrow2: fptqm=0002, jshj=909.00, fpstatus=1, c_time=2026-10-14 14:30:57, kpr=王甲\nrow3: fptqm=0003, jshj=-909.00, fpstatus=7, c_time=2026-10-15 09:59:49, kpr=李乙\n记录中没有提交人、请求来源、日志或审批字段。', answer: draft('两张金额均为 909.00 元的发票先后开具；财务已对第一张发票开具红字发票完成冲红作废。'), expected: false, category: 'unsupported_assertion', origin: 'fictional' },
];

/** 真实案例选取（run_id -> 类别）：覆盖虚构用例没有的两个类别（引用与原文不符、把配置存在当实际生效） */
const REAL_CASE_SEEDS: Array<{ runId: string; category: CaseCategory }> = [
  { runId: 'candidate-scope_business_channels-2', category: 'citation_mismatch' },
  { runId: 'candidate-amount_refund_components-2', category: 'config_as_effect' },
  { runId: 'candidate-amount_hotel_cancel-3', category: 'overgeneralization' },
  { runId: 'candidate-branch_air_issue_retry-2', category: 'false_action' },
  { runId: 'candidate-amount_taxi_coupon-1', category: 'branch_scope' },
];

/** 从 acceptance-verified 构建脱敏后的真实案例；目录缺失时返回空数组（不影响虚构用例） */
export function loadRealCases(runsDir = path.resolve('tests/eval/reports/server-harness-20261009/acceptance-verified'), gradesPath = path.join(runsDir, 'grades.json')): BenchmarkCase[] {
  if (!fs.existsSync(runsDir) || !fs.existsSync(gradesPath)) return [];
  const grades = JSON.parse(fs.readFileSync(gradesPath, 'utf8')) as any[];
  const cases: BenchmarkCase[] = [];
  for (const seed of REAL_CASE_SEEDS) {
    const grade = grades.find(g => `${g.variant}-${g.caseId}-${g.round}` === seed.runId);
    const runDir = path.join(runsDir, seed.runId);
    if (!grade || !fs.existsSync(path.join(runDir, 'messages.json'))) continue;
    const built = buildCaseFromRun(runDir, grade.usable === true, seed.category);
    // 草稿里的 evidenceIds 是原运行的编号，基准只提供 e_fixture 一条证据：重映射后才能进复核
    let answer: unknown = built.item.answer;
    try {
      const parsed = JSON.parse(String(answer));
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.evidenceIds)) answer = JSON.stringify({ ...parsed, evidenceIds: ['e_fixture'] });
    } catch { /* 非 JSON 文本：原样保留 */ }
    cases.push({ id: `real_${seed.runId}`, question: built.item.question, source: built.item.source, answer, expected: built.item.expected, category: seed.category, origin: grade.usable ? `real-correct:${seed.runId}` : `real-failure:${seed.runId}` });
  }
  return cases;
}

/** 基准全表：虚构用例（M2 原 18 条一条不少 + R5 新增 1 条）+ 脱敏真实案例 */
export const BENCHMARK_CASES: BenchmarkCase[] = [...FICTIONAL_CASES, ...loadRealCases()];
