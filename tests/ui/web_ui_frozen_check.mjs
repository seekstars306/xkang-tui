/**
 * 网页端冻结续查 E2E（R2/R3）：用 --demo 替身 + XK_DEMO_FROZEN=1 预置一个 15 分钟到点的冻结会话，
 * 在真实 Chrome 里验证：预算冻结提示、续查按钮位置（不在 .gate 内、第一个 foot-btn 仍是"复制回答"）、
 * 逐条核实（claims）渲染，以及点击续查后恢复运行并清除冻结。
 * 只输出汇总数字与断言，不输出客户信息；截图（含虚构演示数据）落在临时目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchBrowser, findBrowser } from '../helpers/cdp_browser.mjs';
import { startPreview } from '../helpers/preview_process.mjs';

process.env.XK_DEMO_FROZEN = '1';
const preview = await startPreview({ port: 8699, args: ['--demo'] });
const base = preview.url;
const out = path.join(os.tmpdir(), 'xkang-frozen-ui-shots');
fs.mkdirSync(out, { recursive: true });
assert.match(findBrowser(), /Google[\\/]Chrome|google-chrome/i, '验收必须使用 Google Chrome');
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ width: 1280, height: 900 });
  await page.goto(base);
  await page.eval('new Promise(r => setTimeout(r, 500))');
  // 冻结会话是演示库里唯一预置的会话
  const frozenId = await page.eval(`(async () => {
    const list = (await (await fetch('/api/sessions')).json()).sessions || [];
    for (const s of list) {
      const detail = await (await fetch('/api/session/' + s.id)).json();
      if (detail.frozen) return s.id;
    }
    return null;
  })()`);
  assert.ok(frozenId, '演示库应包含一个冻结会话');
  await page.goto(base.replace(/\/$/, '') + '/?reload=1#' + frozenId);
  await page.eval('new Promise(r => setTimeout(r, 800))');
  const frozen = await page.eval(`({
    budget: document.querySelector('.turn-budget')?.textContent || '',
    continueLabel: document.querySelector('.answer-foot .foot-continue')?.textContent || '',
    continueInGate: Boolean(document.querySelector('.gate .foot-continue')),
    firstFootBtn: document.querySelector('.answer-foot .foot-btn')?.textContent || '',
    footBtnCount: document.querySelectorAll('.answer-foot .foot-btn').length,
    claimsTitle: document.querySelector('.claims-title')?.textContent || '',
    claimsItems: document.querySelectorAll('.claims-list .claim').length,
    pendingClaims: document.querySelectorAll('.claims-list .claim-pending').length,
    answer: document.querySelector('.answer')?.innerText || '',
  })`);
  assert.match(frozen.budget, /已达 15 分钟上限（已保留已核实内容）/, '冻结后展示预算用尽提示');
  assert.match(frozen.continueLabel, /继续排查 15 分钟（第 1 次追加）/, '续查按钮带追加次数');
  assert.equal(frozen.continueInGate, false, '续查按钮不得放在 .gate 内（finalizeTurn 会禁用 .gate 按钮）');
  assert.match(frozen.firstFootBtn, /复制回答/, '第一个 foot-btn 必须始终是"复制回答"');
  assert.equal(frozen.footBtnCount, 3, '复制 / 有误 / 续查 三个按钮');
  assert.equal(frozen.claimsTitle, '逐条核实（已核实 1 项 / 待确认 1 项）');
  assert.equal(frozen.claimsItems, 2);
  assert.equal(frozen.pendingClaims, 1, '待确认断言单独标出');
  assert.match(frozen.answer, /已核实联系电话。/);
  await page.screenshot(path.join(out, '01-frozen.png'));

  // 点击续查：追加 15 分钟，恢复运行并给出新的已复核答案
  await page.eval("document.querySelector('.answer-foot .foot-continue').click()");
  for (let i = 0; i < 120; i++) { await page.eval('new Promise(r => setTimeout(r, 100))'); if (!(await page.eval('state.busy'))) break; }
  assert.equal(await page.eval('state.busy'), false);
  const after = await page.eval(`({
    answer: document.querySelector('.answer')?.innerText || '',
    verdict: document.querySelector('.answer')?.dataset.verdict,
    continueGone: !document.querySelector('.answer-foot .foot-continue'),
    budget: document.querySelector('.turn-budget')?.textContent || '',
    claimsItems: document.querySelectorAll('.claims-list .claim').length,
    seal: document.querySelector('.seal')?.textContent || '',
  })`);
  assert.match(after.answer, /已核对客户资料/, '续查后给出新的已复核答案');
  assert.equal(after.verdict, 'reviewed');
  assert.equal(after.continueGone, true, '续查完成后冻结标记清除，按钮移除');
  assert.doesNotMatch(after.budget, /已达 15 分钟上限/, '冻结提示随续查完成移除');
  assert.ok(after.claimsItems >= 1, '续查后的新答案同样带逐条核实状态');
  assert.doesNotMatch(after.answer, /PRIVATE_|SELECT|private_field/);
  assert.doesNotMatch(after.seal, /PRIVATE_/);
  await page.screenshot(path.join(out, '02-continued.png'));
  assert.equal(page.errors.length, 0, page.errors.join(' | '));
  console.log(JSON.stringify({ passed: true, browser: 'Google Chrome', frozenReplay: true, continueResumed: true, claimsRendered: true, footOrderSafe: true, screenshots: out }));
} finally {
  delete process.env.XK_DEMO_FROZEN;
  await browser.close();
  await preview.stop();
}
