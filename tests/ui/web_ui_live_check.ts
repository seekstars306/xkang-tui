/**
 * 网页端端到端检查：隔离服务端（关闭代码同步）+ 隔离网页端实例 + 真实模型，用无头浏览器像客服一样提问，
 * 检查实时流式渲染，再刷新页面检查历史回放与实时渲染一致（步骤数、步骤状态、印章）。
 * 会调用模型，产生少量费用；公司数据库/日志不可达时相关步骤会显示"没查成"，不影响界面检查。
 * 用法：node --import tsx tests/ui/web_ui_live_check.ts ["问题"]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startIsolatedServer } from '../helpers/isolated_server.ts';

// 纯 JS 的 CDP 小工具，按路径动态加载，避免类型检查要求声明文件
const cdpModule: string = '../helpers/cdp_browser.mjs';
const { launchBrowser } = (await import(cdpModule)) as { launchBrowser: () => Promise<any> };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_PORT = 8696;
const question =
  process.argv[2] ||
  '请查询订单1541491413412347905的当前状态和入住离店日期，只核对这些基本信息，不分析异常原因。';
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-ui-live-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SNAPSHOT = `(() => {
  const turn = [...document.querySelectorAll('#log .turn')].pop();
  if (!turn) return null;
  const steps = [...turn.querySelectorAll('.step:not(.step-note):not(.step-think)')].map((s) => s.dataset.state);
  const answer = turn.querySelector('.answer');
  return {
    steps,
    notes: turn.querySelectorAll('.step-note').length,
    answer: answer ? { structured: !answer.classList.contains('is-plain'), verdict: answer.dataset.verdict || null, labels: [...answer.querySelectorAll('.row-label')].map((l) => l.textContent), footer: !!answer.querySelector('.answer-foot') } : null,
    notices: [...turn.querySelectorAll('.notice')].map((n) => n.textContent),
    processOpen: turn.querySelector('.process-head')?.getAttribute('aria-expanded'),
  };
})()`;

const server = await startIsolatedServer(8691, 'gemini');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-ui-live-home-'));
const tsx = pathToFileURL(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const web = spawn(
  process.execPath,
  ['--import', tsx, path.join(ROOT, 'tests', 'helpers', 'web_ui_preview.ts'), String(WEB_PORT), '--server', server.url, '--token', server.token],
  { cwd: ROOT, env: { ...process.env, XK_PREVIEW_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
);
const webLogs: string[] = [];
web.stdout?.on('data', (d) => webLogs.push(String(d)));
web.stderr?.on('data', (d) => webLogs.push(String(d)));

let browser: any;
let failed = false;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failed = true;
};

try {
  // 等网页端起来并连上隔离服务端的远程工具
  const deadline = Date.now() + 120000;
  for (;;) {
    try {
      const info = (await (await fetch(`http://localhost:${WEB_PORT}/api/bootstrap`)).json()) as { mcpConnected?: boolean };
      if (info.mcpConnected) break;
    } catch {
      /* 还没启动 */
    }
    if (Date.now() > deadline) throw new Error(`网页端没有连上隔离服务端:\n${webLogs.join('').slice(-2000)}`);
    await sleep(1000);
  }

  browser = await launchBrowser();
  const page = await browser.newPage({ width: 1280, height: 1000 });
  await page.goto(`http://localhost:${WEB_PORT}/`);
  await sleep(800);
  check((await page.eval(`document.getElementById('conn').dataset.state`)) === 'ready', '连接状态显示"已连接"');

  await page.eval(`(() => { els.input.value = ${JSON.stringify(question)}; autosize(); els.sendBtn.click(); })()`);
  const started = Date.now();
  let midShot = false;
  let sawRunningStep = false;
  let sawStatus = false;
  for (;;) {
    await sleep(1500);
    const s = await page.eval(`({ busy: state.busy, running: document.querySelectorAll('#log .step[data-state="running"]').length, status: !document.querySelector('#log .turn:last-child .status')?.hidden })`);
    if (s.running) sawRunningStep = true;
    if (s.status) sawStatus = true;
    if (!midShot && Date.now() - started > 15000) {
      await page.screenshot(path.join(outDir, '1-running.png'));
      midShot = true;
    }
    if (!s.busy) break;
    if (Date.now() - started > 8 * 60 * 1000) throw new Error('8 分钟内没有完成');
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  await sleep(500);
  await page.screenshot(path.join(outDir, '2-done.png'));
  const live = await page.eval(SNAPSHOT);
  const sessionId = await page.eval('state.sessionId');
  console.log(`用时 ${seconds} 秒；实时渲染结果:`, JSON.stringify(live));

  check(sawStatus, '排查过程中显示进度提示');
  check(sawRunningStep || live.steps.length === 0, '工具执行时步骤显示为进行中');
  check(live.steps.length === 0, '业务端不接收或展示原始工具步骤');
  check(!live.steps.includes('running'), '结束后没有停在"进行中"的步骤');
  check(Boolean(live.answer), '有回答卡片');
  check(Boolean(live.answer?.footer), '回答下方有"复制回答 / 回答有误"');
  check(live.processOpen === 'false', '有回答后排查过程自动收起');

  // 刷新页面：从服务端历史回放，应与实时渲染一致
  await page.goto(`http://localhost:${WEB_PORT}/?reload=1#${sessionId}`);
  await sleep(1200);
  const replay = await page.eval(SNAPSHOT);
  await page.screenshot(path.join(outDir, '3-replay.png'));
  console.log('历史回放结果:', JSON.stringify(replay));
  check(JSON.stringify(replay?.steps) === JSON.stringify(live.steps), '回放的步骤数和每步状态与实时一致');
  check(replay?.answer?.verdict === live.answer?.verdict, `回放的印章与实时一致（${live.answer?.verdict ?? '无印章'}）`);
  check(JSON.stringify(replay?.answer?.labels) === JSON.stringify(live.answer?.labels), '回放的回答分段与实时一致');
  const listed = await page.eval(`(async () => (await (await fetch('/api/sessions')).json()).sessions.find((s) => s.id === ${JSON.stringify(sessionId)}))()`);
  check(Boolean(listed) && (listed.verdict || null) === (live.answer?.verdict ?? null), '左侧会话列表的标记与回答印章一致');
  check(page.errors.length === 0, `页面没有脚本错误${page.errors.length ? `：${page.errors.slice(0, 3).join(' | ')}` : ''}`);
  console.log(`截图: ${outDir}`);
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  if (browser) await browser.close();
  web.kill();
  await new Promise((r) => (web.exitCode !== null ? r(null) : web.once('exit', r)));
  await server.stop();
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* 留给系统临时目录清理 */
  }
}
process.exit(failed ? 1 : 0);
