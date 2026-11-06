import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appendDailyTicket, ensureDailyTicketSheet, parseDailyTickets, summarizeDailyTickets } from '../../scripts/eval/daily_tickets.ts';

test('daily_tickets：初始化、追加、解析与 CP/Wilson 指标汇总', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-daily-'));
  const file = path.join(dir, 'daily-tickets.tsv');
  try {
    ensureDailyTicketSheet(file);
    assert.equal(parseDailyTickets(file).length, 0);

    for (let i = 1; i <= 9; i++) {
      appendDailyTicket({
        date: '2026-10-15',
        businessLine: '机票',
        questionType: '具体订单排障',
        answerable: true,
        coreDemand: `核心诉求 ${i}`,
        question: `问题 ${i}`,
        groundTruth: `真实结果 ${i}`,
        verdict: 'delivered_correct',
        failureCategory: '',
        notes: '',
      }, file);
    }
    appendDailyTicket({
      date: '2026-10-15',
      businessLine: '酒店',
      questionType: '现行规则',
      answerable: true,
      coreDemand: '核对取消规则',
      question: '问题 10',
      groundTruth: '阶梯扣费',
      verdict: 'delivered_partial',
      failureCategory: '4 推理问题（范围泛化）',
      notes: '漏了特价房例外',
    }, file);
    appendDailyTicket({
      date: '2026-10-15',
      businessLine: '打车',
      questionType: '历史事件',
      answerable: false,
      coreDemand: '第三方供应商内部延迟原因',
      question: '问题 11',
      groundTruth: '外部无日志',
      verdict: 'unresolved_honest',
      failureCategory: '',
      notes: '诚实降级',
    }, file);

    const rows = parseDailyTickets(file);
    assert.equal(rows.length, 11);
    assert.equal(rows[0].ticketId, 'D001');
    assert.equal(rows[10].answerable, false);

    const summary = summarizeDailyTickets(rows);
    assert.equal(summary.total, 11);
    assert.equal(summary.answerableCount, 10);
    assert.equal(summary.deliveredCount, 10);
    assert.equal(summary.deliveredCorrectCount, 9);
    assert.equal(summary.deliveredPartialCount, 1);
    assert.equal(summary.unresolvedHonestCount, 1);
    assert.equal(summary.severeCount, 0);
    assert.equal(summary.coverage, 1);
    assert.equal(summary.deliveredAccuracy, 0.9);
    assert.ok(summary.accuracyCpLower > 0.6 && summary.accuracyCpLower < 0.9);
    assert.equal(summary.byFailureCategory['4 推理问题（范围泛化）'], 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
