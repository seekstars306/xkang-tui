import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { listProcesses, repoRoot, terminate, type ProcInfo } from './console_process.js';

/**
 * MCP 服务管理。
 *
 * 为什么单独一个模块：MCP 服务的生命周期和 xkang 服务端、飞书桥都不一样——
 * 它通常由使用方（ZCode / DSH 这类客户端）以**管道**方式拉起，进程挂在客户端名下，
 * 出了问题只能去任务管理器杀。控制台把它们也纳入视野，至少能做到：
 *   · 看见谁在跑、跑了多久、日志在哪；
 *   · 一键停掉/重启，不用翻任务管理器；
 *   · 能独立起来的（http 传输）由控制台启动；stdio 的只能停，界面上给客户端命令。
 */

export type McpTransport = 'stdio' | 'http' | 'unknown';

export interface McpService {
  /** 目录名，如 mcp-grafana-logs */
  name: string;
  label: string;
  entry: string;
  transport: McpTransport;
  description: string;
  /** 客户端应该怎么起（stdio 服务必须由客户端以管道拉起） */
  clientCommand: string;
  /** 能不能由控制台启动：stdio 服务靠管道和客户端通信，脱离客户端起起来也没人能用 */
  startable: boolean;
}

/** 目录名 → 中文名。新增 MCP 服务时在这里补一行，不补就用目录名。 */
const LABELS: Record<string, string> = {
  'mcp-grafana-logs': 'Grafana 日志查询',
};

const DESCRIPTIONS: Record<string, string> = {
  'mcp-grafana-logs': '通过 Grafana/Loki 查线上日志：按命名空间、应用名、关键词和时间窗检索。',
};

/** 扫描 tools/ 下的 mcp-* 目录，自动发现 MCP 服务 */
export function discoverMcpServices(moduleUrl: string = import.meta.url): McpService[] {
  const toolsDir = path.join(repoRoot(moduleUrl), 'tools');
  let entries: string[] = [];
  try { entries = fs.readdirSync(toolsDir, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.startsWith('mcp-')).map(e => e.name); } catch { return []; }
  const out: McpService[] = [];
  for (const name of entries.sort()) {
    const dir = path.join(toolsDir, name);
    const entry = ['index.mjs', 'index.js', 'index.ts'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
    if (!entry) continue;
    out.push({
      name,
      label: LABELS[name] ?? name,
      entry,
      transport: detectTransport(entry),
      description: DESCRIPTIONS[name] ?? '',
      clientCommand: 'node ' + path.relative(repoRoot(moduleUrl), entry).replace(/\\/g, '/'),
      startable: detectTransport(entry) !== 'stdio',
    });
  }
  return out;
}

/** 看源码用的是哪种传输：stdio 服务必须由客户端拉起来，控制台只能起"日志模式"的实例 */
export function detectTransport(entry: string): McpTransport {
  try {
    const src = fs.readFileSync(entry, 'utf8');
    if (/StdioServerTransport/.test(src)) return 'stdio';
    if (/SSEServerTransport|StreamableHTTP|createServer\(/.test(src)) return 'http';
  } catch { /* 读不到就当未知 */ }
  return 'unknown';
}

/** 按命令行里的入口路径找进程（绝对/相对路径都可能出现） */
export function findMcpProcess(service: McpService, procs: ProcInfo[] = listProcesses()): ProcInfo | null {
  const rel = service.entry.replace(/\\/g, '/');
  return procs.find(p => p.commandLine.includes(rel) || p.commandLine.includes(service.name)) ?? null;
}

export interface McpStatus extends McpService {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  logFile: string | null;
}

export function mcpStatus(service: McpService, procs?: ProcInfo[]): McpStatus {
  const proc = findMcpProcess(service, procs);
  return {
    ...service,
    running: Boolean(proc),
    pid: proc?.pid ?? null,
    startedAt: proc?.startedAt ?? null,
    logFile: proc ? path.join(repoRoot(), 'server/data/diagnostics', 'mcp-' + service.name + '.log') : null,
  };
}

export function listMcpStatus(moduleUrl: string = import.meta.url, procs?: ProcInfo[]): McpStatus[] {
  return discoverMcpServices(moduleUrl).map(s => mcpStatus(s, procs));
}

export interface McpActionResult { ok: boolean; pid?: number; error?: string; logFile?: string }

/**
 * 起一份常驻实例，stdio 重定向到日志文件。
 *
 * 注意：stdio 的 MCP 服务靠 stdin/stdout 和客户端通信，脱离客户端起来之后
 * 没有客户端能附上来——所以这个"启动"的用途是常驻与看日志，不是给客户端用。
 * 界面上会把这句说明白，不让人误以为客户端能连上。
 */
export function startMcpService(name: string, moduleUrl: string = import.meta.url): McpActionResult {
  const service = discoverMcpServices(moduleUrl).find(s => s.name === name);
  if (!service) return { ok: false, error: '没有这个 MCP 服务：' + name };
  const existing = findMcpProcess(service);
  if (existing) return { ok: true, pid: existing.pid, error: undefined };
  const logDir = path.join(repoRoot(moduleUrl), 'server/data/diagnostics');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'mcp-' + service.name + '.log');
  try {
    const child = spawn(process.execPath, [service.entry], {
      cwd: path.dirname(service.entry),
      env: { ...process.env },
      detached: true,
      stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
      windowsHide: true,
    });
    child.unref();
    if (!child.pid) return { ok: false, error: '启动失败：拿不到子进程 PID' };
    return { ok: true, pid: child.pid, logFile };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function stopMcpService(name: string, moduleUrl: string = import.meta.url): McpActionResult {
  const service = discoverMcpServices(moduleUrl).find(s => s.name === name);
  if (!service) return { ok: false, error: '没有这个 MCP 服务：' + name };
  const proc = findMcpProcess(service);
  if (!proc) return { ok: false, error: '该 MCP 服务未在运行' };
  const r = terminate(proc.pid);
  return r.ok ? { ok: true, pid: proc.pid } : { ok: false, error: r.error };
}
