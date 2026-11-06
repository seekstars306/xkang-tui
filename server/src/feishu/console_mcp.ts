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
  /** 能不能由控制台启动：支持 --http 模式的才能 */
  startable: boolean;
  /** HTTP 模式端口（startable 为 true 时有效） */
  httpPort: number | null;
  /** HTTP 模式地址（startable 为 true 时有效） */
  httpUrl: string | null;
}

/** HTTP 模式端口。stdio 服务只能由客户端拉起；支持 --http 的才能由控制台直接起。 */
const HTTP_PORTS: Record<string, number> = {
  'mcp-grafana-logs': 8930,
};
const DEFAULT_HTTP_PORT = 8930;

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
      httpPort: supportsHttpMode(entry) ? (HTTP_PORTS[name] ?? DEFAULT_HTTP_PORT) : null,
      startable: supportsHttpMode(entry),
      httpUrl: supportsHttpMode(entry) ? 'http://127.0.0.1:' + (HTTP_PORTS[name] ?? DEFAULT_HTTP_PORT) + '/mcp' : null,
    });
  }
  return out;
}

/** 是否支持 --http：源码里出现 StreamableHTTP 传输才算，避免给一个点了没反应的按钮 */
export function supportsHttpMode(entry: string): boolean {
  try { return /StreamableHTTPServerTransport/.test(fs.readFileSync(entry, 'utf8')); } catch { return false; }
}

/** 看源码用的是哪种传输 */
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
 * 起一份常驻实例。支持 --http 的服务用 HTTP 模式起（客户端能连 httpUrl，控制台也能管）；
 * 只支持 stdio 的服务起起来也没有客户端能附上来，界面上不给这个按钮。
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
    const args = service.httpPort ? [service.entry, '--http', '--port', String(service.httpPort)] : [service.entry];
    const child = spawn(process.execPath, args, {
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
