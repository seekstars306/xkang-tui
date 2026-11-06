import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appendUsageLedger, readUsageLedger, summarizeUsageLedger, usageLedgerPath, type UsageLedgerEntry } from '../../server/src/usage_ledger.ts';

const REQUIRED_FIELDS: Array<keyof UsageLedgerEntry> = ['ts', 'task', 'model', 'purpose', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cachedTokens', 'durationMs', 'ok'];

function withTempLedger(fn: (file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-usage-ledger-'));
  const file = path.join(dir, 'usage-ledger.jsonl');
  const previous = process.env.USAGE_LEDGER_PATH;
  process.env.USAGE_LEDGER_PATH = file;
  try { fn(file); } finally {
    if (previous === undefined) delete process.env.USAGE_LEDGER_PATH; else process.env.USAGE_LEDGER_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('台账写入 JSONL：至少产生一条记录且字段齐全', () => {
  withTempLedger(file => {
    assert.equal(usageLedgerPath(), file);
    appendUsageLedger({ ts: new Date().toISOString(), task: 'S5', model: 'gemini-3.8-flash-high', purpose: 'investigation', inputTokens: 1000, outputTokens: 200, reasoningTokens: 50, cachedTokens: 300, durationMs: 4200, ok: true });
    appendUsageLedger({ ts: new Date().toISOString(), task: 'S5', model: 'gemini-3.8-flash-high', purpose: 'answer_review', inputTokens: 800, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, durationMs: 61000, ok: false, error: 'timeout' });
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    const records = readUsageLedger(file);
    assert.ok(records.length >= 1);
    for (const record of records) {
      for (const field of REQUIRED_FIELDS) assert.notEqual(record[field], undefined, `缺少字段 ${field}`);
      assert.equal(typeof record.ts, 'string');
      assert.equal(typeof record.task, 'string');
      assert.equal(typeof record.model, 'string');
      assert.ok(['investigation', 'answer_review', 'grading', 'other'].includes(record.purpose));
      for (const field of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedTokens', 'durationMs'] as const) assert.equal(typeof record[field], 'number', field);
      assert.equal(typeof record.ok, 'boolean');
      assert.ok(!JSON.stringify(record).includes('sk-'), '台账不得包含密钥样式内容');
    }
    const summary = summarizeUsageLedger(records);
    assert.equal(summary.length, 1);
    assert.equal(summary[0].calls, 2);
    assert.equal(summary[0].inputTokens, 1800);
    assert.equal(summary[0].failures, 1);
  });
});

test('默认台账路径落在 git 忽略的 exec-v3 报告目录', () => {
  const previous = process.env.USAGE_LEDGER_PATH;
  delete process.env.USAGE_LEDGER_PATH;
  try {
    const resolved = usageLedgerPath().replaceAll('\\', '/');
    assert.ok(resolved.endsWith('tests/eval/reports/exec-v3/usage-ledger.jsonl'), resolved);
  } finally {
    if (previous !== undefined) process.env.USAGE_LEDGER_PATH = previous;
  }
});

test('读取不存在的台账返回空数组', () => {
  assert.deepEqual(readUsageLedger(path.join(os.tmpdir(), `xk-missing-${Date.now()}`, 'usage-ledger.jsonl')), []);
});
