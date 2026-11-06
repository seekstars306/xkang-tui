#!/usr/bin/env node
/**
 * 服务端重启的"接棒人"。
 *
 * 为什么需要它：重启请求是由服务端自己处理的。如果在自己的进程里 spawn 新服务端再 exit，
 * 子进程会跟着父进程一起死（Windows 上尤其如此），服务端就起不来了。
 * 所以这里先脱离父进程活着，等旧服务端真的退出后，再把新的拉起来。
 *
 * 用法（由 console_process.planServerRestart 调用）：
 *   node relaunch_server.mjs --parent-pid 1234 --cwd <server dir> --entry src/index.ts \
 *        --log <file> --status <file> --wait-ms 15000
 *
 * 全程只做一件事：把状态写进 --status 指定的 JSON，任何人（包括控制台轮询）都能看到进展。
 * 不依赖 tsx、不依赖仓库里的任何模块——服务端起不来时，它必须是最后一条活路。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const read = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const parentPid = Number(read('parent-pid', '0'));
const cwd = read('cwd', process.cwd());
const entry = read('entry', 'src/index.ts');
const logFile = read('log', path.join(cwd, 'data/diagnostics/relaunch.log'));
const statusFile = read('status', path.join(cwd, 'data/diagnostics/restart-status.json'));
const waitMs = Number(read('wait-ms', '15000'));

const startedAt = new Date().toISOString();
const write = (state, extra = {}) => {
  const payload = { state, startedAt, at: new Date().toISOString(), parentPid, cwd, entry, ...extra };
  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify(payload, null, 2));
  } catch { /* 状态写不进去也不能停 */ }
  return payload;
};
const log = (line) => {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + line + '\n');
  } catch { /* 同上 */ }
};

const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

write('waiting');
log('等待旧服务端退出：pid=' + parentPid + '，上限 ' + waitMs + 'ms');

const deadline = Date.now() + waitMs;
while (alive(parentPid) && Date.now() < deadline) await sleep(300);

if (alive(parentPid)) {
  log('旧服务端在时限内没有退出，按单进程结束它（不用进程树，避免误杀本进程）');
  try { process.kill(parentPid, 'SIGKILL'); } catch (e) { log('SIGKILL 失败：' + e.message); }
  for (let i = 0; i < 40 && alive(parentPid); i += 1) await sleep(250);
  if (alive(parentPid)) {
    write('failed', { error: '旧服务端无法结束，已放弃重启' });
    log('旧服务端仍在运行，放弃重启');
    process.exit(1);
  }
}
log('旧服务端已退出，启动新服务端');

const out = fs.openSync(logFile, 'a');
let child;
try {
  child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd,
    env: { ...process.env },
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
} catch (e) {
  write('failed', { error: String(e && e.message ? e.message : e) });
  log('启动失败：' + e.message);
  process.exit(1);
}

if (!child.pid) {
  write('failed', { error: '启动失败：拿不到子进程 PID' });
  log('启动失败：拿不到子进程 PID');
  process.exit(1);
}

// 给它一点时间证明自己活着：起不来就立刻把失败写进状态，而不是让控制台干等
let ok = false;
for (let i = 0; i < 20; i += 1) {
  await sleep(500);
  if (alive(child.pid)) { ok = true; break; }
}
if (ok) {
  write('started', { pid: child.pid, command: process.execPath + ' --import tsx ' + entry });
  log('新服务端已启动：pid=' + child.pid);
  process.exit(0);
}
write('failed', { error: '新服务端启动后立刻退出，详见 ' + logFile });
log('新服务端启动后立刻退出');
process.exit(1);
