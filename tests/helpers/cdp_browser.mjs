/**
 * 极简 Chrome DevTools Protocol 客户端：启动无头 Chrome/Edge，打开页面、执行脚本、截图。
 * 用于网页界面的截图检查（tests/ui/web_ui_snapshots.mjs），不依赖 puppeteer/playwright。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function findBrowser() {
  const found = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error('没有找到 Chrome / Edge，可用 CHROME_PATH 环境变量指定');
  return found;
}

export async function launchBrowser() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-cdp-'));
  const child = spawn(
    findBrowser(),
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('浏览器启动超时')), 20000);
    child.stderr.on('data', (d) => {
      buf += String(d);
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.once('exit', (code) => reject(new Error(`浏览器提前退出 (${code})`)));
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  async function newPage({ width = 1280, height = 800, mobile = false } = {}) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    await call('Page.enable');
    await call('Runtime.enable');
    const errors = [];
    listeners.push((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    });
    const page = {
      errors,
      async setViewport(w, h, isMobile = false) {
        await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: isMobile });
      },
      async goto(url) {
        const loaded = new Promise((resolve) => {
          const l = (msg) => {
            if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') {
              listeners.splice(listeners.indexOf(l), 1);
              resolve();
            }
          };
          listeners.push(l);
        });
        await call('Page.navigate', { url });
        await loaded;
      },
      async eval(expression) {
        const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
      async screenshot(file) {
        const { data } = await call('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        return file;
      },
      close: () => send('Target.closeTarget', { targetId }),
    };
    await page.setViewport(width, height, mobile);
    return page;
  }

  async function close() {
    try {
      await send('Browser.close');
    } catch {
      child.kill();
    }
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    fs.rmSync(profile, { recursive: true, force: true });
  }

  return { newPage, close };
}
