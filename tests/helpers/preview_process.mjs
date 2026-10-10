/**
 * 以子进程启动隔离的网页端实例（tests/helpers/web_ui_preview.ts），等它能访问后返回。
 * stop() 结束进程并删除临时用户目录（Windows 上结束子进程不会触发它自己的清理逻辑，所以由这里负责）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function startPreview({ port, args = [], home, readyCheck } = {}) {
  const dir = home || fs.mkdtempSync(path.join(os.tmpdir(), 'xk-webui-home-'));
  const tsx = pathToFileURL(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  const child = spawn(process.execPath, ['--import', tsx, path.join(ROOT, 'tests', 'helpers', 'web_ui_preview.ts'), String(port), ...args], {
    cwd: ROOT,
    env: { ...process.env, XK_PREVIEW_HOME: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    for (let i = 0; i < 10 && fs.existsSync(dir); i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return !fs.existsSync(dir);
  };

  const url = `http://localhost:${port}/`;
  const deadline = Date.now() + 90000;
  for (;;) {
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`网页端实例提前退出:\n${logs.join('').slice(-2000)}`);
    }
    try {
      const resp = await fetch(`${url}api/bootstrap`);
      if (resp.ok && (!readyCheck || readyCheck(await resp.json()))) break;
    } catch {
      /* 还没启动 */
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`网页端实例启动超时:\n${logs.join('').slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { url, home: dir, logs, stop };
}
