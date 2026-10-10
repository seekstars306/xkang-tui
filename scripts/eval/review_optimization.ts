import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Message } from '@xkang/agent-core';
import { reviewAnswer } from '../../server/src/agent/review.ts';
import { BusinessModel } from '../../server/src/agent/model.ts';
import { loadServerEnv } from '../../tests/helpers/isolated_server.ts';

// Controlled fictional policies. Expected verdicts are registered but never sent to the reviewer.
const draft = (conclusion: string, businessData: Array<{ label: string; value: string }> = []) => ({ conclusion, businessData, evidenceSummary: [], customerReply: '', pendingItems: [] });
const cases = [
  { id: 'receipt_supported', question: '说明这次设备检修申请的受理与完成情况。', source: '申请R-001：已受理。记录没有检修完成时间，也没有完工通知。', answer: draft('检修申请已受理。当前记录没有完成时间，仍需核实办理进度。'), expected: true },
  { id: 'receipt_invented_deadline', question: '说明这次设备检修申请的受理与完成情况。', source: '申请R-001：已受理。记录没有检修完成时间，也没有完工通知。', answer: draft('检修申请已受理；将在两个工作日内完成。'), expected: false },
  { id: 'equipment_scoped', question: '设备领用是否都只需部门审批？', source: '普通设备领用：部门审批通过即可领取。精密仪器领用：部门审批通过后，还须完成资质核验。', answer: draft('普通设备在部门审批通过后可领取；精密仪器还须完成资质核验。'), expected: true },
  { id: 'equipment_overgeneralized', question: '设备领用是否都只需部门审批？', source: '普通设备领用：部门审批通过即可领取。精密仪器领用：部门审批通过后，还须完成资质核验。', answer: draft('部门审批是领用条件；所有设备只要部门审批通过就能领取。'), expected: false },
  { id: 'inventory_scoped', question: '两个仓库是否都没有库存？', source: '本次只查询甲仓，结果0件，甲仓查询已完整返回。乙仓尚未查询。', answer: draft('甲仓查询结果为0件；乙仓尚未查询，不能确定两个仓库都没有库存。'), expected: true },
  { id: 'inventory_negative', question: '两个仓库是否都没有库存？', source: '本次只查询甲仓，结果0件，甲仓查询已完整返回。乙仓尚未查询。', answer: draft('甲仓查询结果为0件；两个仓库都没有库存。'), expected: false },
  { id: 'reservation_premise', question: '假设场地预约已经取消，能否说明之前没有支付过押金？只解释规则，不核查具体预约。', source: '场地预约流程与押金收支分别记录。已付押金的预约也可以取消，之后另行办理押金退回。', answer: draft('按预约已取消的题设，仍不能说明此前没有支付押金；需要另查押金收支记录。'), expected: true },
  { id: 'reservation_false_action', question: '假设场地预约已经取消，能否说明之前没有支付过押金？只解释规则，不核查具体预约。', source: '场地预约流程与押金收支分别记录。已付押金的预约也可以取消，之后另行办理押金退回。', answer: draft('取消与押金收支分别记录；我已通知财务退回押金。'), expected: false },
  { id: 'business_identifiers', question: '原样核对演示客户的联系方式、证件和订单金额。', source: '演示客户：测试甲；联系电话：0013912345678；证件号码：11010119920202002X；订单号：009876543210987654321；金额：12.50元。', answer: draft('已核对到演示客户资料。', [{ label: '联系电话', value: '0013912345678' }, { label: '证件号码', value: '11010119920202002X' }, { label: '订单号', value: '009876543210987654321' }, { label: '金额', value: '12.50元' }]), expected: true },
  { id: 'pending_request', question: '说明检修申请现状，列出进一步核对所需资料。', source: '检修申请已受理。', answer: { ...draft('检修申请已受理。'), pendingItems: ['请提供申请编号以便核对。'] }, expected: true },
  { id: 'pending_time_request', question: '说明检修申请现状，列出进一步核对所需资料。', source: '检修申请已受理。', answer: { ...draft('检修申请已受理。'), pendingItems: ['请提供申请时间以便进一步核对。'] }, expected: true },
  { id: 'pending_mandatory_rule', question: '说明检修申请现状，列出进一步核对所需资料。', source: '检修申请已受理。记录不含办理前置条件。', answer: { ...draft('检修申请已受理。'), pendingItems: ['建议补充申请时间，否则系统必定无法办理后续手续。'] }, expected: false },
  { id: 'pending_hidden_rule', question: '说明检修申请现状，列出进一步核对所需资料。', source: '检修申请已受理。记录不含服务时限或赔偿规则。', answer: { ...draft('检修申请已受理。'), pendingItems: ['请等待三天，超过三天系统必然自动赔偿。'] }, expected: false },
  { id: 'cached_destination_false', question: '地址簿查询无结果时，这份报表是否一定无法寄出？', source: '完整寄送函数：\nfunction deliver(job) {\n  let destination = job.savedAddress;\n  const entry = directory.findActive(job.owner);\n  if (entry) destination = entry.address;\n  if (destination) courier.send(destination, job.report);\n}\n寄送服务接收地址后提交寄件；不另外查询地址簿。', answer: draft('寄送前必须查到有效地址簿记录；查无记录就不会寄出。'), expected: false },
  { id: 'cached_destination_scoped', question: '地址簿查询无结果时，这份报表是否一定无法寄出？', source: '完整寄送函数：\nfunction deliver(job) {\n  let destination = job.savedAddress;\n  const entry = directory.findActive(job.owner);\n  if (entry) destination = entry.address;\n  if (destination) courier.send(destination, job.report);\n}\n寄送服务接收地址后提交寄件；不另外查询地址簿。', answer: draft('查无地址簿记录时仍保留任务中保存的地址；该地址有值时仍会提交寄件，不能据此确认实际送达。'), expected: true },
  { id: 'guard_blocks_destination', question: '地址簿查询无结果时，这份报表是否仍会寄出？', source: '完整寄送函数：\nfunction deliver(job) {\n  const entry = directory.findActive(job.owner);\n  if (!entry) return;\n  courier.send(entry.address, job.report);\n}', answer: draft('在此寄送流程中，查无有效地址簿记录会直接结束，无法进入寄件步骤。'), expected: true },
  { id: 'overwritten_price_false', question: '所有材料订单的手续费是否都是默认的12元？', source: '完整计费函数：\nfunction charge(order) {\n  let fee = 12;\n  if (order.vip) fee = 0;\n  else if (order.expedited) fee = 25;\n  return fee;\n}', answer: draft('所有材料订单手续费都是12元。'), expected: false },
  { id: 'overwritten_price_scoped', question: '所有材料订单的手续费是否都是默认的12元？', source: '完整计费函数：\nfunction charge(order) {\n  let fee = 12;\n  if (order.vip) fee = 0;\n  else if (order.expedited) fee = 25;\n  return fee;\n}', answer: draft('会员订单手续费为0元；非会员加急订单为25元；其他订单为12元。'), expected: true },
];

const out = path.resolve(process.argv[2] || 'tests/eval/reports/review-optimization-20261009');
if (fs.existsSync(path.join(out, 'manifest.json'))) throw new Error('Use a new output directory; preserve previous evidence');
fs.mkdirSync(out, { recursive: true });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const files = ['server/src/agent/review.ts', 'server/src/agent/publication.ts', 'server/src/agent/service.ts', 'scripts/eval/review_optimization.ts'];
const baselinePath = path.resolve(process.argv[3] || 'tests/eval/reports/server-harness-20261009/acceptance-verified/frozen-source/server/src/agent/review.ts');
const legacyReview = (await import(pathToFileURL(baselinePath).href)).reviewAnswer as typeof reviewAnswer;
const sourceHashes = Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(file))]));
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ registeredAt: new Date().toISOString(), cases, rounds: 2, sourceHashes, baselinePath, baselineHash: hash(fs.readFileSync(baselinePath)), purpose: '虚构规则受控验证，不代表实际业务完整可用率；期望判断不进入模型输入。' }, null, 2));
for (const file of files) { const to = path.join(out, 'source', file); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(file, to); }
for (const [key, value] of Object.entries(loadServerEnv())) process.env[key] = value;
const { loadServerConfig } = await import('../../server/src/config.ts');
const config = loadServerConfig();
const tasks = cases.flatMap(c => [1, 2].flatMap(round => (['baseline', 'candidate'] as const).map(variant => ({ ...c, round, variant }))));
let cursor = 0; const results: any[] = [];
async function run(job: typeof tasks[number]) {
  const audit: unknown[] = [], requests: unknown[] = [];
  const model = new BusinessModel(config, 'gemini', { log: (entry: unknown) => audit.push(entry) } as any, 'review-optimization');
  const gateway: any = { streamChat: async (...args: Parameters<BusinessModel['streamChat']>) => {
    requests.push(args[0]); return model.streamChat(...args);
  } };
  const history: Message[] = [{ role: 'user', content: job.question }, { role: 'tool', name: 'company_db_query', content: job.source,
    evidence: { id: 'e_fixture', observedAt: '2026-10-09T00:00:00Z', arguments: {}, outcome: 'success', completeness: 'complete' } }];
  const started = Date.now();
  const decision = await (job.variant === 'candidate' ? reviewAnswer : legacyReview)(gateway, { role: 'assistant', content: JSON.stringify(job.answer) }, history, 1, 'r_fixture', () => {});
  const status = (decision.record as any).status;
  const judgmentCompleted = status === 'passed' || status === 'needs_revision';
  const result = { id: job.id, round: job.round, variant: job.variant, expected: job.expected, accepted: decision.accepted, judgmentCompleted, matchesExpected: judgmentCompleted && decision.accepted === job.expected, seconds: Math.round((Date.now() - started) / 1000), modelCalls: requests.length, status };
  const key = `${job.variant}-${job.id}-${job.round}`;
  fs.writeFileSync(path.join(out, key + '.json'), JSON.stringify({ result, decision, history, requests, audit }, null, 2));
  results.push(result); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ finished: results.length, ...result }));
}
await Promise.all(Array.from({ length: 2 }, async () => { while (cursor < tasks.length) await run(tasks[cursor++]); }));
const changed = files.filter(file => sourceHashes[file] !== hash(fs.readFileSync(file)));
fs.writeFileSync(path.join(out, 'integrity.json'), JSON.stringify({ sourceUnchanged: !changed.length, changed }, null, 2));
