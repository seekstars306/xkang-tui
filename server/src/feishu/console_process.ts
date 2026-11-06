import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 控制台的进程探测与启停。
 *
 * 为什么值得单独一个模块：这些都是"会真的影响线上"的动作，
 * 必须能和纯逻辑分开单测、分开审查。两条硬规则：
 *   1. 任何停止/重启动作都要能被审计（谁、什么时候、影响了哪些 pid）；
 *   2. 重启服务端用"脱离父进程的 relauncher"——直接在自己的进程里 spawn 再 exit，
 *      子进程会跟着一起死，服务端就起不回来了。
 */

/**
 * CIM 的 CreationDate 形如 20261104151505.123456+480，new Date() 解析不了（会得到 Invalid Date，
 * 再 toISOString() 直接抛 RangeError，把整个 status 接口打挂）。按前 14 位自己拼。
 */
function parseCimDate(raw: unknown): string | null {
  // 既吃 CIM 原始格式 20261104151505.123456+480，也吃预先格式化过的 2026-11-05T11:01:59
  const digits = String(raw ?? '').replace(/\D/g, '');
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(digits);
  if (!m) return null;
  const d = new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6]);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  commandLine: string;
  startedAt: string | null;
}

const IS_WIN = process.platform === 'win32';

/** 当前节点进程列表。Windows 走 CIM，其它平台走 ps；取不到就返回空数组，由调用方决定报错。 */
export function listProcesses(): ProcInfo[] {
  if (IS_WIN) {
    const ps = spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' } | Select-Object ProcessId,ParentProcessId,CommandLine,@{n='StartedAt';e={$_.CreationDate.ToString('yyyy-MM-ddTHH:mm:ss')}} | ConvertTo-Json -Compress",
    ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (ps.status !== 0 || !ps.stdout) return [];
    let parsed: any;
    try { parsed = JSON.parse(ps.stdout.trim() || '[]'); } catch { return []; }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.filter(r => r && typeof r.ProcessId === 'number').map(r => ({
      pid: r.ProcessId,
      ppid: Number(r.ParentProcessId ?? 0),
      commandLine: String(r.CommandLine ?? ''),
      startedAt: parseCimDate(r.StartedAt),
    }));
  }
  const ps = spawnSync('ps', ['-eo', 'pid=,ppid=,lstart=,args='], { encoding: 'utf8', timeout: 15000 });
  if (ps.status !== 0 || !ps.stdout) return [];
  return ps.stdout.split('\n').map(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s{2,}(.*)$/.exec(line);
    if (!m) return null;
    return { pid: Number(m[1]), ppid: Number(m[2]), commandLine: m[4], startedAt: null } as ProcInfo;
  }).filter((x): x is ProcInfo => x !== null);
}

/** 把 PowerShell/ps 的原始输出解析成进程列表。空输出与非 JSON 都返回空数组，不抛错。 */
export function parseProcList(stdout: string): ProcInfo[] {
  let parsed: any;
  try { parsed = JSON.parse((stdout || '').trim() || '[]'); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.filter(r => r && typeof r.ProcessId === 'number').map(r => ({
    pid: r.ProcessId,
    ppid: Number(r.ParentProcessId ?? 0),
    commandLine: String(r.CommandLine ?? ''),
    startedAt: parseCimDate(r.StartedAt ?? r.CreationDate),
  }));
}
const BRIDGE_MARK = /feishu[\\/]main\.(ts|js)/;
const SERVER_MARK = /(^|[\\/])src[\\/]index\.(ts|js)|dist[\\/]index\.js/;

export function findBridge(): ProcInfo | null {
  return listProcesses().find(p => BRIDGE_MARK.test(p.commandLine) && !/relaunch/.test(p.commandLine)) ?? null;
}

/** 服务端进程：包含自己 */
export function findServerProcesses(): ProcInfo[] {
  return listProcesses().filter(p => SERVER_MARK.test(p.commandLine) && !/relaunch/.test(p.commandLine));
}

export function isRunning(info: ProcInfo | null): boolean {
  if (!info) return false;
  try { process.kill(info.pid, 0); return true; } catch { return false; }
}

/** 按进程树结束；Windows 用 taskkill /T，其它平台先 SIGTERM 再升级 */
export function terminate(pid: number): { ok: boolean; error?: string } {
  if (IS_WIN) {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || 'taskkill 失败').trim() };
  }
  try { process.kill(pid, 'SIGTERM'); } catch (e) { return { ok: false, error: (e as Error).message }; }
  return { ok: true };
}

/** 仓库根目录：本文件在 server/src/feishu 下，要上三级才到仓库根 */
export function repoRoot(moduleUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '../../..');
}

export interface StartBridgeResult { ok: boolean; pid?: number; error?: string; logFile?: string }

/**
 * 启动飞书桥。脱离父进程 + stdio 落到文件：
 * 服务端重启时不应该把桥一起带走，而桥的日志也不能因为服务端被 kill 就消失。
 */
export function startBridge(moduleUrl: string = import.meta.url): StartBridgeResult {
  const root = repoRoot(moduleUrl);
  const entry = path.join(root, 'server/src/feishu/main.ts');
  if (!fs.existsSync(entry)) return { ok: false, error: '找不到飞书桥入口：' + entry };
  const logDir = path.join(root, 'server/data/diagnostics');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'bridge-from-console.log');
  const env = { ...process.env, XKANG_BASE_URL: process.env.XKANG_BASE_URL || 'http://127.0.0.1:8600' };
  let out: number;
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: root,
      env,
      detached: true,
      stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
      windowsHide: true,
    });
    child.unref();
    out = child.pid ?? 0;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!out) return { ok: false, error: '启动飞书桥失败：拿不到子进程 PID' };
  return { ok: true, pid: out, logFile };
}

/** relauncher 脚本路径（纯 .mjs：不依赖 tsx 也能跑，服务端起不来时多一条活路） */
export function relauncherPath(moduleUrl: string = import.meta.url): string {
  return path.join(path.dirname(fileURLToPath(moduleUrl)), 'relaunch_server.mjs');
}

export interface RestartPlan {
  ok: boolean;
  error?: string;
  relauncherPid?: number;
  statusFile?: string;
  logFile?: string;
  command: string;
}

/**
 * 安排一次服务端重启：先拉起脱离的 relauncher，由它等当前进程退出后再把服务端拉起来。
 * 返回后调用方应尽快 exit；relauncher 的进展写在 statusFile 里，控制台可轮询。
 */
export function planServerRestart(moduleUrl: string = import.meta.url, extra: { waitMs?: number } = {}): RestartPlan {
  const root = repoRoot(moduleUrl);
  const serverDir = path.join(root, 'server');
  const logDir = path.join(serverDir, 'data/diagnostics');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'restart-from-console.log');
  const statusFile = path.join(logDir, 'restart-status.json');
  const script = relauncherPath(moduleUrl);
  if (!fs.existsSync(script)) return { ok: false, error: '找不到 relauncher 脚本：' + script, command: '' };
  const waitMs = extra.waitMs ?? 15000;
  const args = [
    script,
    '--parent-pid', String(process.pid),
    '--cwd', serverDir,
    '--entry', 'src/index.ts',
    '--log', logFile,
    '--status', statusFile,
    '--wait-ms', String(waitMs),
  ];
  try {
    fs.writeFileSync(statusFile, JSON.stringify({ state: 'scheduled', at: new Date().toISOString(), parentPid: process.pid }, null, 2));
    const child = spawn(process.execPath, args, {
      cwd: serverDir,
      env: { ...process.env },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    if (!child.pid) return { ok: false, error: ' relauncher 启动失败', command: '' };
    return {
      ok: true,
      relauncherPid: child.pid,
      statusFile,
      logFile,
      command: `node --import tsx src/index.ts（cwd=${serverDir}）`,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message, command: '' };
  }
}

/**
 * 安排一次停止：不接棒，服务端退出后保持停止。
 * 与 planServerRestart 的区别只在于要不要 relauncher——停完之后监控台自己也访问不了，
 * 所以把恢复命令写进状态文件，用户随时能看到。
 */
export function planServerStop(moduleUrl: string = import.meta.url): RestartPlan & { stopped: true } {
  const root = repoRoot(moduleUrl);
  const serverDir = path.join(root, 'server');
  const logDir = path.join(serverDir, 'data/diagnostics');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'restart-from-console.log');
  const statusFile = path.join(logDir, 'restart-status.json');
  const command = 'pwsh scripts/start_production.ps1';
  try {
    fs.writeFileSync(statusFile, JSON.stringify({
      state: 'stopped', startedAt: new Date().toISOString(), at: new Date().toISOString(),
      parentPid: process.pid, cwd: serverDir, entry: 'src/index.ts', command,
      note: '服务端已按控制台指令停止，未自动拉起。恢复请运行上面的命令。',
    }, null, 2));
    return { ok: true, statusFile, logFile, command, stopped: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message, command: '', stopped: true };
  }
}

/**
 * 端口上是否已有监听。
 *
 * 用 net.Socket().connect() 是异步的，函数返回时事件还没来，测不准——
 * 所以这里用同步的 netstat/ss。匹配时要求端口号后面是空白或行尾，
 * 免得 :8600 命中 :86000。
 */
function listening(port: number): boolean {
  if (!IS_WIN) {
    const r = spawnSync('sh', ['-c', '(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null)'], { encoding: 'utf8', timeout: 8000 });
    if (!r.stdout) return false;
    const re = new RegExp(':' + port + '(?:\\s|$)');
    return r.stdout.split(/\r?\n/).some(line => re.test(line));
  }
  // 注意不能用 { shell: true }：那会走 cmd.exe /c，父进程没有控制台时 Windows 会给它
  // 新开一个控制台——表现为屏幕上疯狂闪 cmd 窗口。直接调 netstat.exe 不会。
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  if (!r.stdout) return false;
  const re = new RegExp(':' + port + '(?:\\s|$)');
  // Windows 的 netstat 会把 TIME_WAIT/CLOSE_WAIT 的连接也列出来，本地端口同样是 8600，
  // 只认 LISTENING 行，否则服务端明明已经退了还被判成占用，启动就一直被拒。
  return r.stdout.split(/\r?\n/).some(line => re.test(line) && (!IS_WIN || /LISTENING/i.test(line)));
}
export function startServerProcess(moduleUrl: string = import.meta.url, port = 8600, waitMs = 12000): StartBridgeResult & { already?: boolean } {
  const root = repoRoot(moduleUrl);
  const serverDir = path.join(root, 'server');
  const entry = path.join(serverDir, 'src/index.ts');
  if (!fs.existsSync(entry)) return { ok: false, error: '找不到服务端入口：' + entry };
  // 已经在跑就立刻返回，不要白等——最常见的情况就是点多了一次
  if (listening(port)) return { ok: true, already: true } as StartBridgeResult;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && listening(port)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  if (listening(port)) return { ok: false, error: '端口 ' + port + ' 仍被占用（旧服务端可能还没退完），请稍后重试' };
  const logDir = path.join(serverDir, 'data/diagnostics');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'start-from-console.log');
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: serverDir,
      env: { ...process.env },
      detached: true,
      stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
      windowsHide: true,
    });
    child.unref();
    if (!child.pid) return { ok: false, error: '启动服务端失败：拿不到子进程 PID' };
    return { ok: true, pid: child.pid, logFile };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 接棒小服务的端口（与 console_keeper.mjs 保持一致） */
export const KEEPER_PORT = Number(process.env.XKANG_KEEPER_PORT || 8601);

/** 接棒脚本路径 */
export function keeperPath(moduleUrl: string = import.meta.url): string {
  return path.join(path.dirname(fileURLToPath(moduleUrl)), 'console_keeper.mjs');
}

/**
 * 确保接棒小服务在跑。服务端每次启动都调一次：
 * 端口已被占用（说明已经有一份）就什么都不做；没起过就拉起来。
 * 它独立于服务端存活，服务端停止后仍然能接收"启动"指令。
 */
export function ensureKeeper(moduleUrl: string = import.meta.url): { ok: boolean; pid?: number; error?: string } {
  const script = keeperPath(moduleUrl);
  if (!fs.existsSync(script)) return { ok: false, error: '找不到接棒脚本：' + script };
  // 已经有一份在跑就不再拉：keeper 自己遇到端口占用会安静退出，
  // 但每次重启都白拉一次进程没必要，先探一下。
  if (listening(KEEPER_PORT)) return { ok: true, pid: undefined };
  try {
    const child = spawn(process.execPath, [script], {
      cwd: repoRoot(moduleUrl),
      env: { ...process.env },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
}

/** 控制台动作审计：JSONL 追加，写不进去也不阻断动作本身（但要把真实原因报出来） */
export function appendAudit(moduleUrl: string, entry: AuditEntry): { ok: boolean; error?: string } {
  const file = path.join(repoRoot(moduleUrl), 'server/data/diagnostics/console-actions.jsonl');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
