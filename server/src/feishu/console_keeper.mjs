#!/usr/bin/env node
/**
 * 控制台"接棒人"——一个独立于 xkang 服务端的小进程。
 *
 * 解决什么问题：控制台页面本身由服务端提供。点了"停止服务端"之后进程真的退出，
 * 页面还在浏览器里，但它的请求已经没有后端可发——这时再点"启动服务端"必然失败。
 *
 * 所以这里常驻一个只做一件事的小服务：服务端不在时，替它接收"启动"指令。
 * 它刻意保持极小：不连数据库、不读 .env、不依赖 tsx，任何依赖出问题都不影响它把服务端拉起来。
 *
 * 端口默认 8601（XKANG_KEEPER_PORT 可改）。服务端每次启动都会确保它在跑；
 * 端口被占用就安静退出，不会出现两份。
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const serverDir = path.join(repoRoot, 'server');
const PORT = Number(process.env.XKANG_KEEPER_PORT || 8601);
const LOG = path.join(serverDir, 'data/diagnostics/keeper.log');

const log = (line) => {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + line + '\n');
  } catch { /* 日志写不进去也不能停 */ }
};

/**
 * 端口上是否已有监听。
 * net.Socket().connect() 是异步的，函数返回时事件还没来，测不准；
 * 所以用同步的 netstat，并且只认 LISTENING 行——TIME_WAIT/CLOSE_WAIT 的连接
 * 本地端口同样是 8600，会把已经退了误判成还在跑。
 */
const listening = (port) => {
  const r = spawnSync('netstat -ano', { shell: true, encoding: 'utf8', timeout: 8000, windowsHide: true });
  if (!r.stdout) return false;
  const re = new RegExp(':' + port + '(?:\\s|$)');
  return r.stdout.split(/\r?\n/).some((line) => re.test(line) && /LISTENING/i.test(line));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const send = (res, code, body) => {
  res.writeHead(code, { ...cors, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** 等 8600 空出来再拉服务端：停止是异步退出的，紧接着启动会撞上旧进程还没退完 */
async function startServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && listening(8600)) await sleep(400);
  if (listening(8600)) return { ok: false, error: '端口 8600 仍被占用（旧服务端可能还没退完），请稍后重试' };
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env },
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  if (!child.pid) return { ok: false, error: '启动失败：拿不到子进程 PID' };
  // 给它一点时间证明自己活着
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    if (listening(8600)) return { ok: true, pid: child.pid };
  }
  return { ok: false, error: '服务端启动后没有监听 8600，详见 ' + LOG };
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
    send(res, 200, { ok: true, keeper: true, mainListening: listening(8600), pid: process.pid });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/start') {
    if (listening(8600)) { send(res, 200, { ok: true, already: true }); return; }
    startServer().then((r) => { log('start -> ' + JSON.stringify(r)); send(res, r.ok ? 200 : 500, r); });
    return;
  }
  send(res, 404, { error: 'not found' });
});

server.on('error', (e) => {
  // 端口已被别的 keeper 占用：安静退出，不报错、不写日志噪音
  if (e && e.code === 'EADDRINUSE') process.exit(0);
  log('server error: ' + e.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => log('keeper 已启动 pid=' + process.pid + ' port=' + PORT));
