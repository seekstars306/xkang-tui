/**
 * 用本机真实会话检查网页端回放：把 sessions.db 复制到临时目录，启动隔离的网页端实例，逐个打开会话，
 * 统计渲染结果并收集页面脚本错误。只输出汇总数字，不输出会话内容；结束后删除会话库副本。
 * 用法：node tests/ui/real_sessions_check.mjs [sessions.db 路径] [--shots N]
 *   --shots N  另外把最近 N 个有结构化回答（优先有印章）的会话截图保存到临时目录（含客户信息，看完请删除）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from '../helpers/cdp_browser.mjs';
import { startPreview } from '../helpers/preview_process.mjs';

const argv = process.argv.slice(2);
const shotsIdx = argv.indexOf('--shots');
const shotCount = shotsIdx >= 0 ? Number(argv[shotsIdx + 1] || 3) : 0;
const src = argv.find((a, i) => !a.startsWith('--') && (shotsIdx < 0 || i !== shotsIdx + 1)) || path.join(os.homedir(), '.xkang', 'sessions.db');

if (!fs.existsSync(src)) {
  console.log(`没有找到会话库 ${src}，跳过`);
  process.exit(0);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-real-sessions-'));
fs.mkdirSync(path.join(home, '.xkang'));
for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, path.join(home, '.xkang', `sessions.db${suffix}`));
}

const COLLECT = `(async () => {
  const list = (await (await fetch('/api/sessions')).json()).sessions || [];
  const stats = {
    sessions: list.length, opened: 0, turns: 0, answers: 0, structured: 0, plain: 0,
    seals: { confirmed: 0, inferred: 0, unknown: 0 }, conclusionWithoutLabel: 0, otherSections: 0,
    noAnswerTurns: 0, steps: 0, stepStates: {}, notes: 0, thinks: 0,
    verdictMismatch: 0, slowestMs: 0, totalMs: 0,
  };
  const forShots = [];
  for (const s of list) {
    const t0 = performance.now();
    await selectSession(s.id);
    const dt = performance.now() - t0;
    stats.slowestMs = Math.max(stats.slowestMs, Math.round(dt));
    stats.totalMs += Math.round(dt);
    if (state.sessionId !== s.id) continue;
    stats.opened++;
    const log = document.getElementById('log');
    stats.turns += log.querySelectorAll('.turn').length;
    const answers = log.querySelectorAll('.answer');
    stats.answers += answers.length;
    for (const a of answers) {
      if (a.classList.contains('is-plain')) stats.plain++;
      else stats.structured++;
      if (a.dataset.verdict) stats.seals[a.dataset.verdict]++;
      else if (a.querySelector('.row-conclusion')) stats.conclusionWithoutLabel++;
      stats.otherSections += a.querySelectorAll('.row-other').length;
    }
    stats.noAnswerTurns += [...log.querySelectorAll('.turn')].filter((t) => !t.querySelector('.answer')).length;
    for (const st of log.querySelectorAll('.step:not(.step-note):not(.step-think)')) {
      stats.steps++;
      stats.stepStates[st.dataset.state] = (stats.stepStates[st.dataset.state] || 0) + 1;
    }
    stats.notes += log.querySelectorAll('.step-note').length;
    stats.thinks += log.querySelectorAll('.step-think').length;
    // 左侧列表的标记（服务端识别）与最后一个回答的印章（网页端识别）应当一致
    const last = answers[answers.length - 1];
    const clientVerdict = last ? last.dataset.verdict || null : null;
    if (clientVerdict !== (s.verdict || null)) stats.verdictMismatch++;
    if (clientVerdict) forShots.unshift(s.id);
    else if (log.querySelector('.answer:not(.is-plain)')) forShots.push(s.id);
  }
  return { stats, forShots };
})()`;

let exitCode = 0;
let browser;
let preview;
try {
  preview = await startPreview({ port: 8695, home });
  browser = await launchBrowser();
  const page = await browser.newPage({ width: 1280, height: 900 });
  await page.goto(preview.url);
  await page.eval('new Promise((r) => setTimeout(r, 500))');
  const { stats, forShots } = await page.eval(COLLECT);
  console.log(JSON.stringify({ ...stats, pageErrors: page.errors.length }, null, 2));
  if (page.errors.length) {
    console.log('页面脚本错误（前 5 条）:');
    for (const e of page.errors.slice(0, 5)) console.log(' -', String(e).split('\n')[0].slice(0, 200));
    exitCode = 1;
  }
  if (stats.opened !== stats.sessions || stats.verdictMismatch) exitCode = 1;

  if (shotCount > 0) {
    const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-real-shots-'));
    await page.setViewport(1280, 1300);
    for (const id of forShots.slice(0, shotCount)) {
      await page.eval(`selectSession(${JSON.stringify(id)}).then(() => new Promise((r) => setTimeout(r, 300)))`);
      await page.screenshot(path.join(shotDir, `${id}.png`));
    }
    console.log(`截图目录（含客户信息，看完请删除）: ${shotDir}`);
  }
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  if (browser) await browser.close();
  const removed = preview ? await preview.stop() : (fs.rmSync(home, { recursive: true, force: true }), true);
  console.log(removed ? '会话库副本已删除' : `会话库副本未能删除，请手动删除: ${home}`);
}
process.exit(exitCode);
