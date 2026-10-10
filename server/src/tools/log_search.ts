import { ServerConfig } from '../types.js';

/**
 * 服务端日志查询工具 (Grafana / Loki)
 * 通过 Grafana 数据源代理查询 Loki，内置安全护栏：
 *  - 单次查询窗口硬限制 2 小时，防止大跨度扫描拖垮日志集群
 *  - target_time 锚点 + 窄窗口聚焦检索（推荐 ±10 分钟）
 * 凭据只从环境变量读取（server/.env 中的 GRAFANA_*）。
 */

const MAX_WINDOW_MS = 2 * 60 * 60 * 1000;
const LINE_MAX_CHARS = 500;
const OUTPUT_CHAR_BUDGET = 14000;

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<any>;
}>;

export interface GrafanaConfig {
  url: string;
  username: string;
  password: string;
  lokiUid: string;
}

export function getGrafanaConfig(): GrafanaConfig | null {
  const url = process.env.GRAFANA_URL;
  const username = process.env.GRAFANA_USERNAME;
  const password = process.env.GRAFANA_PASSWORD;
  const lokiUid = process.env.GRAFANA_LOKI_UID;
  if (!url || !username || !password || !lokiUid) return null;
  return { url: url.replace(/\/$/, ''), username, password, lokiUid };
}

const MISSING_GRAFANA_CONFIG = '服务端未配置 GRAFANA_URL / GRAFANA_USERNAME / GRAFANA_PASSWORD / GRAFANA_LOKI_UID，无法查询日志，请联系管理员在 server/.env 中配置。';

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

export function parseDateTime(str: string): number | null {
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

export function formatLocalTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构造 LogQL。keyword 支持 "A OR B" / "A|B"（任一命中），英文词不区分大小写；纯数字/单号按字面精确匹配。
 * 以前 keyword 直接拼成 `|= "A OR B"`，日志里当然找不到这串字面量，模型却据此认为"没有报错"。
 */
export function buildLogQL(args: Pick<SearchLogsArgs, 'app' | 'namespace' | 'keyword'>): string {
  const ns = args.namespace || 'cxy';
  const selectors: string[] = [`namespace=${JSON.stringify(ns)}`];
  if (args.app && args.app.trim()) selectors.push(`app=${JSON.stringify(args.app.trim())}`);
  let logql = `{${selectors.join(', ')}}`;

  const raw = (args.keyword || '').trim();
  if (raw) {
    const terms = raw
      .split(/\s+OR\s+|\s*\|\|\s*|\s*\|\s*/i)
      .map((t) => t.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    if (terms.length > 1) {
      logql += ` |~ ${JSON.stringify(`(?i)(${terms.map(escapeRegExp).join('|')})`)}`;
    } else if (terms.length === 1) {
      const term = terms[0];
      logql += /[A-Za-z]/.test(term) ? ` |~ ${JSON.stringify(`(?i)${escapeRegExp(term)}`)}` : ` |= ${JSON.stringify(term)}`;
    }
  }
  return logql;
}

export function resolveWindow(
  args: Pick<SearchLogsArgs, 'target_time' | 'window_minutes' | 'minutes_ago' | 'start_time' | 'end_time'>,
  now: number
): { startMs: number; endMs: number; note?: string } | { error: string } {
  let startMs: number;
  let endMs: number;
  let note: string | undefined;
  if (args.target_time) {
    const targetMs = parseDateTime(args.target_time);
    if (!targetMs) {
      return { error: `错误: 无法解析 target_time "${args.target_time}"，请使用 'YYYY-MM-DD HH:mm:ss' 格式（数据库中的本地时间即可）` };
    }
    const win = Math.min(Math.max(Number(args.window_minutes) || 10, 1), 60);
    startMs = targetMs - win * 60 * 1000;
    endMs = targetMs + win * 60 * 1000;
  } else if (args.start_time) {
    const s = parseDateTime(args.start_time);
    if (!s) return { error: `错误: 无法解析 start_time "${args.start_time}"` };
    startMs = s;
    endMs = args.end_time ? parseDateTime(args.end_time) || now : now;
  } else {
    const minAgo = Math.min(Math.max(Number(args.minutes_ago) || 30, 1), 120);
    startMs = now - minAgo * 60 * 1000;
    endMs = now;
    if (!args.minutes_ago) {
      note = '未指定时间，默认只查最近 30 分钟。如果问题发生在更早的时间，请先从数据库拿到时间点（如 create_time）再用 target_time 查询。';
    }
  }
  if (startMs >= endMs) {
    return { error: `错误: 开始时间必须早于结束时间 (${formatLocalTime(startMs)} >= ${formatLocalTime(endMs)})` };
  }
  if (endMs - startMs > MAX_WINDOW_MS) {
    return { error: '【安全拦截】查询跨度超过 2 小时上限。请先通过数据库记录确定大致时间点，用 target_time + window_minutes(≤30分钟) 聚焦查询。' };
  }
  return { startMs, endMs, note };
}

async function grafanaFetch(cfg: GrafanaConfig, apiPath: string, fetchImpl: FetchLike): Promise<any> {
  const authHeader = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  const resp = await fetchImpl(`${cfg.url}${apiPath}`, {
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`Grafana API [HTTP ${resp.status}]: ${(await resp.text()).slice(0, 300)}`);
  }
  return resp.json();
}

export async function executeSearchLogs(
  args: SearchLogsArgs,
  _config: ServerConfig,
  _user: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  now: number = Date.now()
): Promise<string> {
  const cfg = getGrafanaConfig();
  if (!cfg) return MISSING_GRAFANA_CONFIG;

  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
  const win = resolveWindow(args, now);
  if ('error' in win) return win.error;
  const { startMs, endMs } = win;

  const logql = buildLogQL(args);
  const params = new URLSearchParams({
    query: logql,
    start: (BigInt(startMs) * 1000000n).toString(),
    end: (BigInt(endMs) * 1000000n).toString(),
    limit: String(limit),
    direction: 'backward',
  });
  const windowText = `${formatLocalTime(startMs)} ~ ${formatLocalTime(endMs)}`;

  try {
    const res = await grafanaFetch(cfg, `/api/datasources/proxy/uid/${cfg.lokiUid}/loki/api/v1/query_range?${params.toString()}`, fetchImpl);
    const entries: Array<{ t: string; app: string; line: string; ns: bigint }> = [];
    for (const stream of res?.data?.result || []) {
      const meta = stream.stream || {};
      const head = `[${meta.app || 'unknown'}|${meta.pod || 'unknown'}]`;
      for (const [tsNs, line] of stream.values || []) {
        entries.push({
          t: formatLocalTime(Number(BigInt(tsNs) / 1000000n)),
          app: head,
          line: String(line).trimEnd(),
          ns: BigInt(tsNs),
        });
      }
    }

    if (entries.length === 0) {
      return [
        `窗口 [${windowText}] 内没有匹配的日志。查询: ${logql}`,
        win.note || '',
        '注意: 没查到 ≠ 没发生。可能是关键词并未打印在日志里（很多服务不打印手机号/单号）、app 名称不对、时间窗不对或超出日志保留期。',
        '可以: 用 list_log_apps 确认应用名；用数据库记录里的时间点作为 target_time；换成接口路径、异常类名等更可能出现在日志里的关键词。',
      ]
        .filter(Boolean)
        .join('\n');
    }

    // Loki 按时间倒序截取 limit 条；展示时改为时间正序，便于还原事件经过
    entries.sort((a, b) => (a.ns > b.ns ? 1 : a.ns < b.ns ? -1 : 0));
    const hitLimit = entries.length >= limit;
    const head = hitLimit
      ? `=== 日志查询结果: 返回 ${entries.length} 条（已达到 limit=${limit} 上限，只拿到了窗口内时间最近的 ${limit} 条，更早的匹配日志未返回；请缩小时间窗或使用更具体的关键词） ===`
      : `=== 日志查询结果: 共 ${entries.length} 条（窗口内全部匹配） ===`;

    const out: string[] = [];
    let used = 0;
    let dropped = 0;
    for (const e of entries) {
      const line = e.line.length > LINE_MAX_CHARS ? e.line.slice(0, LINE_MAX_CHARS) + '…[截断]' : e.line;
      const text = `${e.t} ${e.app} ${line}`;
      if (out.length > 0 && used + text.length > OUTPUT_CHAR_BUDGET) {
        dropped++;
        continue;
      }
      out.push(text);
      used += text.length + 1;
    }
    return [
      head,
      `窗口: ${windowText} | 查询: ${logql} | 按时间正序`,
      win.note || '',
      '--------------------------------------------------',
      ...out,
      dropped > 0 ? `…因输出长度限制，另有 ${dropped} 条较新的日志未展示，请缩小时间窗或加关键词。` : '',
    ]
      .filter(Boolean)
      .join('\n');
  } catch (err: unknown) {
    return `日志查询失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** 列出可查询的微服务应用列表 */
export async function executeListLogApps(
  args: { namespace?: string },
  _config: ServerConfig,
  _user: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<string> {
  const cfg = getGrafanaConfig();
  if (!cfg) return MISSING_GRAFANA_CONFIG;
  const ns = args.namespace || 'cxy';
  try {
    const res = await grafanaFetch(cfg, `/api/datasources/proxy/uid/${cfg.lokiUid}/loki/api/v1/series?match[]={namespace=${JSON.stringify(ns)}}`, fetchImpl);
    const apps = new Set<string>();
    for (const item of res?.data || []) {
      if (item.app) apps.add(item.app);
    }
    return JSON.stringify({ namespace: ns, count: apps.size, apps: Array.from(apps).sort() });
  } catch (err: unknown) {
    return `获取应用列表失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}
