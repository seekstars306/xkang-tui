// xkang vs xkang-jev 对照运行：同一输入，两臂独立完整执行，结果分开收集。
// 用法（项目根目录）：node tests/eval/reports/_retest/ab_batch.mjs <ticketId...>
// 每臂一个独立子进程，配置通过环境变量显式传入，并写进产物用于自证两臂确实不同。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const RETEST = 'tests/eval/reports/_retest';
const tickets = process.argv.slice(2);
if (!tickets.length) { console.error('用法：node ab_batch.mjs T001 T002 ...'); process.exit(2); }

const ARMS = [
  { name: 'xkang',     env: { REVIEWER: 'llm', OBSERVE_INTENT_ROUTER: '0' } },
  { name: 'xkang-jev', env: { REVIEWER: 'jev', OBSERVE_INTENT_ROUTER: '1' } },
];

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const batchDir = path.resolve(`${RETEST}/ab-batch-${stamp}`);
fs.mkdirSync(batchDir, { recursive: true });

function runArm(ticket, arm) {
  return new Promise((resolve) => {
    const inputFile = `${RETEST}/tickets/${ticket}/${ticket}.json`;
    if (!fs.existsSync(inputFile)) return resolve({ ticket, arm: arm.name, error: 'missing input' });
    const label = `${ticket}-${arm.name}`;
    const logFile = path.join(batchDir, label + '.log');
    const fd = fs.openSync(logFile, 'w');
    const env = { ...process.env, ...arm.env, ARM: 'new', RUN_LABEL: label, INPUT_FILE: inputFile, SOURCE_SESSION: ticket, SKIP_ARM_PROOF: '1', RUN_TOKEN_CAP: '8000000' };
    delete env.DRY; delete env.WITH_SECOND_TURN;
    const child = spawn(process.execPath, ['--import', 'tsx', `${RETEST}/full_ticket_run.ts`], { cwd: process.cwd(), env, stdio: ['ignore', fd, fd], windowsHide: true });
    const timer = setTimeout(async () => {
      try { (await import('node:child_process')).execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
    }, 25 * 60 * 1000);
    child.on('exit', (code) => { clearTimeout(timer); fs.closeSync(fd); resolve({ ticket, arm: arm.name, label, code, logFile }); });
  });
}

const summary = [];
for (const ticket of tickets) {
  for (const arm of ARMS) {
    const t0 = Date.now();
    console.log(`[${new Date().toISOString()}] start ${ticket} / ${arm.name}`);
    const r = await runArm(ticket, arm);
    const log = fs.existsSync(r.logFile) ? fs.readFileSync(r.logFile, 'utf8') : '';
    const outDir = log.match(/^输出目录 (.+)$/m)?.[1]?.trim() || null;
    let result = null, answer = null, manifest = null;
    if (outDir) {
      try { result = JSON.parse(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8')); } catch {}
      try { answer = JSON.parse(fs.readFileSync(path.join(outDir, 'answer.txt'), 'utf8')); } catch {}
      try { manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')); } catch {}
    }
    const row = {
      ticket, arm: arm.name, config: arm.env, exitCode: r.code, seconds: Math.round((Date.now() - t0) / 1000),
      outDir: outDir ? path.basename(outDir) : null,
      reviewStatus: result?.reviewStatus ?? null,
      reviewRecords: result?.reviewRecords ?? null,
      toolCalls: result?.toolCalls ?? null,
      tokens: result?.tokens ?? null,
      conclusion: answer?.conclusion ?? null,
      evidenceSummary: answer?.evidenceSummary ?? null,
      pendingItems: answer?.pendingItems ?? null,
      error: result?.error ?? null,
    };
    summary.push(row);
    fs.writeFileSync(path.join(batchDir, 'summary.json'), JSON.stringify(summary, null, 1));
    console.log(`[${new Date().toISOString()}] done ${ticket}/${arm.name} status=${row.reviewStatus} tools=${row.toolCalls} ${row.seconds}s`);
  }
}
console.log('');
console.log('batchDir=' + batchDir);
