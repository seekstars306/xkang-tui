
// 四题重跑：验证起步轮次 50→120 的效果。串行，每题独立进程，避免互相污染。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const RETEST = 'tests/eval/reports/_retest';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const batchDir = path.resolve(`${RETEST}/turns120-batch-${stamp}`);
fs.mkdirSync(batchDir, { recursive: true });

const RUNS = [
  { q: 'Q1', file: `${RETEST}/regression-inputs/Q1.json`, label: 'T120-Q1' },
  { q: 'Q2', file: `${RETEST}/regression-inputs/Q2.json`, label: 'T120-Q2' },
  { q: 'Q3', file: `${RETEST}/regression-inputs/Q3.json`, label: 'T120-Q3' },
  { q: 'T1', file: `${RETEST}/regression-inputs/T1.json`, label: 'T120-T1' },
];
fs.writeFileSync(path.join(batchDir, 'plan.json'), JSON.stringify({ runs: RUNS, turnBudget: 120 }, null, 1));

function runChild(label, file) {
  return new Promise((resolve) => {
    const logFile = path.join(batchDir, label + '.log');
    const fd = fs.openSync(logFile, 'w');
    const env = { ...process.env, ARM: 'new', RUN_LABEL: label, INPUT_FILE: file, SOURCE_SESSION: 'turns120', SKIP_ARM_PROOF: '1', RUN_TOKEN_CAP: '8000000' };
    const child = spawn(process.execPath, ['--import', 'tsx', `${RETEST}/full_ticket_run.ts`], { cwd: process.cwd(), env, stdio: ['ignore', fd, fd], windowsHide: true });
    const timer = setTimeout(async () => {
      try { (await import('node:child_process')).execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
    }, 25 * 60 * 1000);
    child.on('exit', (code) => { clearTimeout(timer); fs.closeSync(fd); resolve(code); });
  });
}

const summary = [];
for (const r of RUNS) {
  const t0 = Date.now();
  console.log(`[${new Date().toISOString()}] start ${r.label}`);
  fs.appendFileSync(path.join(batchDir, 'progress.log'), `start ${r.label} ${new Date().toISOString()}\n`);
  const code = await runChild(r.label, r.file);
  const log = fs.readFileSync(path.join(batchDir, r.label + '.log'), 'utf8');
  const outDir = log.match(/^输出目录 (.+)$/m)?.[1]?.trim() || null;
  let result = null;
  if (outDir) { try { result = JSON.parse(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8')); } catch {} }
  const row = { label: r.label, q: r.q, exitCode: code, seconds: Math.round((Date.now() - t0) / 1000), outDir: outDir ? path.basename(outDir) : null,
    toolCalls: result?.toolCalls ?? null, modelCalls: result?.modelCalls ?? null, reviewStatus: result?.reviewStatus ?? null,
    tokens: result?.tokens ?? null, error: result?.error ?? null, records: result?.reviewRecords ?? null };
  summary.push(row);
  fs.writeFileSync(path.join(batchDir, 'summary.json'), JSON.stringify(summary, null, 1));
  console.log(`[${new Date().toISOString()}] done ${r.label} exit=${code} toolCalls=${row.toolCalls} status=${row.reviewStatus}`);
}
console.log('\n=== SUMMARY ===');
for (const s of summary) console.log(`${s.label} | ${s.seconds}s | toolCalls=${s.toolCalls} | ${s.reviewStatus} | records=${JSON.stringify(s.records)}`);
console.log('batchDir=' + batchDir);
