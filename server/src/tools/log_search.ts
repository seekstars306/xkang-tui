import { ServerConfig } from '../types.js';

/**
 * 服务端日志查询工具 (Grafana / Loki)
 * 通过 Grafana 数据源代理查询 Loki，内置安全护栏：
 *  - 单次查询窗口硬限制 2 小时，防止大跨度扫描拖垮日志集群
 *  - target_time 锚点 + 窄窗口聚焦检索（推荐 ±10 分钟）
 */

const GRAFANA_URL = process.env.GRAFANA_URL || 'http://10.197.236.112:8885';
const GRAFANA_USERNAME = process.env.GRAFANA_USERNAME || 'admin';
const GRAFANA_PASSWORD = process.env.GRAFANA_PASSWORD || '';
const LOKI_UID = process.env.GRAFANA_LOKI_UID || 'b723cf86-421c-4bba-84a6-82c0486d3dec';
const MAX_WINDOW_MS = 2 * 60 * 60 * 1000;

const authHeader = 'Basic ' + Buffer.from(`${GRAFANA_USERNAME}:${GRAFANA_PASSWORD}`).toString('base64');

export interface SearchLogsArgs {
  app?: string;
  keyword?: string;
  namespace?: string;
  target_time?: string;
  window_minutes?: number;
  minutes_ago?: number;
  start_time?: string;
  end_time?: string;
  limit?: number;
}

function parseDateTime(str: string): number | null {
  if (!str) return null;
  const s = String(str).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return s.length === 10 ? n * 1000 : n;
  }
  let d = new Date(s);
  if (!isNaN(d.getTime())) return d.getTime();
  d = new Date(s.replace(/-/g, '/'));
  if (!isNaN(d.getTime())) return d.getTime();
  return null;
}

function formatLocalTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function grafanaFetch(path: string): Promise<any> {
  const resp = await fetch(`${GRAFANA_URL.replace(/\/$/, '')}${path}`, {
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`Grafana API [HTTP ${resp.status}]: ${await resp.text()}`);
  }
  return resp.json();
}

export async function executeSearchLogs(args: SearchLogsArgs, _config: ServerConfig, user: string): Promise<string> {
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
  const now = Date.now();
  let startMs: number;
  let endMs: number;

  // 1. 时间窗口计算（target_time 锚点优先）
  if (args.target_time) {
    const targetMs = parseDateTime(args.target_time);
    if (!targetMs) {
      return `错误: 无法解析 target_time "${args.target_time}"，请使用 'YYYY-MM-DD HH:mm:ss' 格式`;
    }
    const win = Math.min(Math.max(Number(args.window_minutes) || 10, 1), 60);
    startMs = targetMs - win * 60 * 1000;
    endMs = targetMs + win * 60 * 1000;
  } else if (args.start_time) {
    startMs = parseDateTime(args.start_time) || now - 30 * 60 * 1000;
    endMs = args.end_time ? (parseDateTime(args.end_time) || now) : now;
  } else {
    const minAgo = Math.min(Math.max(Number(args.minutes_ago) || 30, 1), 120);
    startMs = now - minAgo * 60 * 1000;
    endMs = now;
  }

  if (startMs >= endMs) {
    return `错误: 开始时间必须早于结束时间 (${formatLocalTime(startMs)} >= ${formatLocalTime(endMs)})`;
  }
  if (endMs - startMs > MAX_WINDOW_MS) {
    return `【安全拦截】查询跨度超过 2 小时上限。请先通过数据库记录确定大致时间点，用 target_time + window_minutes(≤30分钟) 聚焦查询。`;
  }

  // 2. LogQL 构造（必须带 app/namespace 选择器，防全量扫描）
  const ns = args.namespace || 'cxy';
  const selectors: string[] = [`namespace="${ns}"`];
  if (args.app) selectors.push(`app="${args.app}"`);
  let logql = `{${selectors.join(', ')}}`;
  if (args.keyword && args.keyword.trim()) {
    logql += ` |= ${JSON.stringify(args.keyword.trim())}`;
  }

  const params = new URLSearchParams({
    query: logql,
    start: (BigInt(startMs) * 1000000n).toString(),
    end: (BigInt(endMs) * 1000000n).toString(),
    limit: String(limit),
    direction: 'backward',
  });

  try {
    const res = await grafanaFetch(
      `/api/datasources/proxy/uid/${LOKI_UID}/loki/api/v1/query_range?${params.toString()}`
    );
    if (res.status !== 'success' || !res.data?.result) {
      return `窗口 [${formatLocalTime(startMs)} ~ ${formatLocalTime(endMs)}] 内未检索到日志。\n查询: ${logql}`;
    }

    const entries: Array<{ t: string; app: string; pod: string; line: string; ns: bigint }> = [];
    for (const stream of res.data.result) {
      const meta = stream.stream || {};
      const head = `[${meta.app || 'unknown'}|${meta.pod || 'unknown'}]`;
      for (const [tsNs, line] of stream.values || []) {
        entries.push({
          t: formatLocalTime(Number(BigInt(tsNs) / 1000000n)),
          app: head,
          pod: meta.pod || '',
          line: String(line).trimEnd(),
          ns: BigInt(tsNs),
        });
      }
    }
    entries.sort((a, b) => (b.ns > a.ns ? 1 : -1));

    if (entries.length === 0) {
      return `窗口 [${formatLocalTime(startMs)} ~ ${formatLocalTime(endMs)}] 内未匹配到日志 (共0条)。\n查询: ${logql}\n建议: 放宽 keyword、扩大 window_minutes(≤30) 或确认 app 名称 (可用 list_log_apps 查看)。`;
    }

    // 单条日志截断，防止 token 爆炸
    const out = entries.slice(0, limit).map(e => {
      const line = e.line.length > 400 ? e.line.slice(0, 400) + '…[截断]' : e.line;
      return `${e.t} ${e.app} ${line}`;
    });
    return [
      `=== 日志查询结果 (共 ${entries.length} 条, 显示 ${out.length} 条) ===`,
      `窗口: ${formatLocalTime(startMs)} ~ ${formatLocalTime(endMs)} | 查询: ${logql}`,
      '--------------------------------------------------',
      ...out,
    ].join('\n');
  } catch (err: unknown) {
    return `日志查询失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** 列出可查询的微服务应用列表 */
export async function executeListLogApps(args: { namespace?: string }, _config: ServerConfig, _user: string): Promise<string> {
  const ns = args.namespace || 'cxy';
  try {
    const res = await grafanaFetch(
      `/api/datasources/proxy/uid/${LOKI_UID}/loki/api/v1/series?match[]={namespace="${ns}"}`
    );
    const apps = new Set<string>();
    for (const item of res.data || []) {
      if (item.app) apps.add(item.app);
    }
    return JSON.stringify({ namespace: ns, count: apps.size, apps: Array.from(apps).sort() }, null, 2);
  } catch (err: unknown) {
    return `获取应用列表失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}
