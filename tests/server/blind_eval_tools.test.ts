import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildBlindPack, mulberry32, shuffle } from '../../scripts/eval/make_blind_pack.ts';
import { GRADE_COLUMNS, candidateRejected, parseGradeSheet, templateFromKey } from '../../scripts/eval/grade_sheet.ts';
import { cohensKappa, selfReAgreement, summarizeAgreement } from '../../scripts/eval/agreement.ts';
import { computeGoldMetrics, computeSilverMetrics, formatMetrics, type RunRecord } from '../../scripts/eval/workbook.ts';

const GRADES_PATH = path.resolve('tests/eval/reports/server-harness-20261009/acceptance-verified/grades.json');
const SAMPLE_DIR = path.resolve('tests/eval/reports/exec-v3/blind-sample');

function loadRecords(): RunRecord[] {
  const grades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8')) as any[];
  return grades.map(g => ({ runId: `${g.variant}-${g.caseId}-${g.round}`, caseId: g.caseId, variant: g.variant, round: g.round, seconds: g.seconds, completed: g.completed, usable: g.usable, severeMisleading: g.severeMisleading }));
}

test('workbook：120 次受控运行的银标签指标与 CP/Wilson 区间（candidate 22/60、严重误导 3/60）', () => {
  const records = loadRecords();
  assert.equal(records.length, 120);
  const silver = computeSilverMetrics(records);
  assert.equal(silver.n, 120);
  assert.equal(silver.deliveryCorrectness.k, 35, '两版本合计整答全对 13+22');
  assert.equal(silver.severeRate.k, 15, '两版本合计严重误导 12+3');
  const candidate = computeSilverMetrics(records.filter(r => r.variant === 'candidate'));
  assert.equal(candidate.n, 60);
  assert.equal(candidate.deliveryCorrectness.k, 22, 'candidate 完整可用 22/60');
  assert.ok(Math.abs(candidate.deliveryCorrectness.rate - 22 / 60) < 1e-12);
  assert.ok(Math.abs(candidate.deliveryCorrectness.cpLower - 0.2629) < 0.0005, `CP 下界 ${candidate.deliveryCorrectness.cpLower}`);
  assert.ok(Math.abs(candidate.deliveryCorrectness.wilson.lower - 0.2562) < 0.0005 && Math.abs(candidate.deliveryCorrectness.wilson.upper - 0.4932) < 0.0005, 'Wilson 区间');
  assert.equal(candidate.severeRate.k, 3, 'candidate 严重误导 3/60');
  assert.ok(Math.abs(candidate.severeRate.cpUpper - 0.1242) < 0.0005, `CP 上界 ${candidate.severeRate.cpUpper}`);
  const baseline = computeSilverMetrics(records.filter(r => r.variant === 'baseline'));
  assert.equal(baseline.deliveryCorrectness.k, 13, 'baseline 完整可用 13/60');
  assert.equal(baseline.severeRate.k, 12, 'baseline 严重误导 12/60');
  assert.ok(baseline.severeRate.cpUpper > candidate.severeRate.cpUpper, 'baseline 严重误导率上界更高');
  assert.ok(candidate.timeP50 > 0 && candidate.timeP90 >= candidate.timeP50);
  // 金标准表：无标注时为 null，不冒充金标准
  assert.equal(computeGoldMetrics(records), null);
  const gold = computeGoldMetrics([...records.slice(0, 5).map((r, i) => ({ ...r, goldVerdict: i < 2 ? 'delivered' as const : 'wrong' as const, coreDemandCovered: i < 3 }))]);
  assert.equal(gold!.n, 5);
  assert.equal(gold!.deliveryCorrectness.k, 2);
  assert.match(formatMetrics('银标签', candidate), /交付正确率（整答口径）：22\/60/);
});

test('make_blind_pack：盲评文本无身份字样，blind-key 100% 还原，同种子可复现', () => {
  const tickets = [
    { ticketId: 't1', question: '问题一', candidates: [
      { candidateId: 'baseline-amount_hotel_cancel-1', answer: '这是基线版本的答案内容。' },
      { candidateId: 'candidate-amount_hotel_cancel-1', answer: '这是新版本的答案内容。' },
    ] },
    { ticketId: 't2', question: '问题二', candidates: [
      { candidateId: 'run-x', answer: '答案 X' },
      { candidateId: 'run-y', answer: '答案 Y' },
      { candidateId: 'run-z', answer: '答案 Z' },
    ] },
  ];
  const { seed, packText, key } = buildBlindPack(tickets, 20261015);
  for (const token of ['baseline', 'candidate', 'gemini', 'flash', 'deepseek', 'traceId', 'reviewStatus']) {
    assert.equal(packText.toLowerCase().includes(token.toLowerCase()), false, token);
  }
  assert.match(packText, /候选 A/);
  assert.match(packText, /候选 B/);
  assert.match(packText, /候选 C/);
  // 身份还原：每个字母都能映射回唯一候选，且覆盖全部候选
  for (const ticket of key.tickets) {
    const source = tickets.find(t => t.ticketId === ticket.ticketId)!;
    assert.deepEqual([...new Set(Object.values(ticket.key))].sort(), source.candidates.map(c => c.candidateId).sort());
  }
  // 确定性：同种子输出一致；打乱函数可复现
  const again = buildBlindPack(tickets, 20261015);
  assert.equal(again.packText, packText);
  assert.deepEqual(shuffle([1, 2, 3, 4, 5], mulberry32(7)), shuffle([1, 2, 3, 4, 5], mulberry32(7)));
  assert.throws(() => buildBlindPack([{ ticketId: 't', question: 'q', candidates: [{ candidateId: 'x', answer: 'gemini 生成的答案' }] }]), /身份字样/);
});

test('grade_sheet：模板生成与填写解析往返一致，一栏否决即整体否决', () => {
  const key = { seed: 1, tickets: [{ ticketId: 't1', key: { A: 'run-a', B: 'run-b' } }] };
  const template = templateFromKey(key);
  assert.match(template, /候选 A/);
  for (const column of GRADE_COLUMNS) assert.ok(template.includes(column));
  const filled = template
    .replace('| 候选 A |  |  |  |  |  |', '| 候选 A | 符合 | 符合 | 否决 | 修改 | 备注一 |')
    .replace('| 候选 B |  |  |  |  |  |', '| 候选 B | 符合 | 符合 | 符合 | 符合 | 备注二 |');
  const grades = parseGradeSheet(filled);
  assert.equal(grades.length, 2);
  assert.deepEqual(grades[0].verdicts, { '参考答案要点': '符合', '禁止断言': '符合', '核心诉求': '否决', '适用范围': '修改' });
  assert.equal(grades[0].note, '备注一');
  assert.equal(candidateRejected(grades[0]), true);
  assert.equal(candidateRejected(grades[1]), false);
  assert.equal(parseGradeSheet('# 空表').length, 0);
});

test('agreement：原始一致率、Cohen Kappa 与复评一致性，区间用精确法', () => {
  const a = ['符合', '符合', '否决', '修改', '符合'];
  const b = ['符合', '否决', '否决', '修改', '符合'];
  const summary = summarizeAgreement(a, b);
  assert.equal(summary.n, 5);
  assert.equal(summary.agreements, 4);
  assert.ok(Math.abs(summary.rawAgreement - 0.8) < 1e-12);
  assert.ok(summary.kappa! > 0.6 && summary.kappa! < 0.75, `kappa=${summary.kappa}`);
  assert.ok(summary.rawAgreementCpLower > 0.3 && summary.rawAgreementCpLower < 0.45);
  assert.ok(summary.rawAgreementWilson.lower < summary.rawAgreement && summary.rawAgreementWilson.upper > summary.rawAgreement);
  // 完全一致时 kappa 无定义（pe=1）
  assert.equal(cohensKappa(['符合', '符合'], ['符合', '符合']).kappa, null);
  // 同一评分者 20% 复评
  const first = new Map([['r1', '符合'], ['r2', '否决'], ['r3', '符合'], ['r4', '修改'], ['r5', '符合']]);
  const second = new Map([['r1', '符合'], ['r3', '否决']]);
  const re = selfReAgreement(first, second);
  assert.equal(re.n, 2);
  assert.equal(re.agreements, 1);
});

test('样例产物：盲评包 + 密钥 + 打分表模板写入 git 忽略目录', () => {
  const records = loadRecords();
  const byId = new Map(records.map(r => [r.runId, r]));
  const answers = (runId: string) => {
    const dir = path.resolve('tests/eval/reports/server-harness-20261009/acceptance-verified', runId);
    return fs.existsSync(path.join(dir, 'answer.txt')) ? fs.readFileSync(path.join(dir, 'answer.txt'), 'utf8').slice(0, 400) : '（无答案文件）';
  };
  const tickets = ['amount_hotel_cancel', 'scope_overlap_rules'].flatMap(caseId => {
    const pair = [`baseline-${caseId}-1`, `candidate-${caseId}-1`].filter(id => byId.has(id));
    return pair.length === 2 ? [{ ticketId: caseId, question: `工单 ${caseId}（样例）`, candidates: pair.map(id => ({ candidateId: id, answer: answers(id) })) }] : [];
  });
  assert.ok(tickets.length >= 1);
  const { packText, key } = buildBlindPack(tickets, 20261015);
  fs.mkdirSync(SAMPLE_DIR, { recursive: true });
  fs.writeFileSync(path.join(SAMPLE_DIR, 'blind-pack.md'), packText);
  fs.writeFileSync(path.join(SAMPLE_DIR, 'blind-key.json'), JSON.stringify(key, null, 2));
  fs.writeFileSync(path.join(SAMPLE_DIR, 'grade-sheet.md'), templateFromKey(key));
  assert.ok(fs.readFileSync(path.join(SAMPLE_DIR, 'blind-pack.md'), 'utf8').includes('候选 A'));
  assert.equal(parseGradeSheet(templateFromKey(key)).length, tickets.reduce((n, t) => n + t.candidates.length, 0));
});
