#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const GRAFANA_URL = process.env.GRAFANA_URL || "http://10.197.236.112:8885";
const GRAFANA_USERNAME = process.env.GRAFANA_USERNAME || "admin";
const GRAFANA_PASSWORD = process.env.GRAFANA_PASSWORD || "";
const LOKI_UID = process.env.GRAFANA_LOKI_UID || "b723cf86-421c-4bba-84a6-82c0486d3dec";

// Maximum allowed search window: 2 hours (in ms)
const MAX_SEARCH_WINDOW_MS = 2 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MINUTES = 5;

const authHeader = "Basic " + Buffer.from(`${GRAFANA_USERNAME}:${GRAFANA_PASSWORD}`).toString("base64");

function parseDateTime(str) {
  if (!str) return null;
  if (typeof str === "number") return str;
  if (/^\d+$/.test(String(str).trim())) {
    const n = Number(str);
    return String(str).trim().length === 10 ? n * 1000 : n;
  }
  let d = new Date(str);
  if (!isNaN(d.getTime())) return d.getTime();
  let normalized = String(str).trim().replace(/-/g, "/");
  d = new Date(normalized);
  if (!isNaN(d.getTime())) return d.getTime();
  return null;
}

function formatLocalTime(timestampMs) {
  const d = new Date(timestampMs);
  const pad = (n) => String(n).padStart(2, "0");
  const padMs = (n) => String(n).padStart(3, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${padMs(d.getMilliseconds())}`;
}

async function grafanaFetch(path, options = {}) {
  const url = `${GRAFANA_URL.replace(/\/$/, "")}${path}`;
  const headers = {
    Authorization: authHeader,
    "Content-Type": "application/json",
    ...options.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Grafana API 响应异常 [HTTP ${response.status}]: ${errorText}`);
  }
  return await response.json();
}

async function getLokiDatasourceUid() {
  if (LOKI_UID) return LOKI_UID;
  const datasources = await grafanaFetch("/api/datasources");
  const lokiDs = datasources.find((ds) => ds.type === "loki" && ds.name === "Loki-new") ||
                 datasources.find((ds) => ds.type === "loki");
  if (!lokiDs) {
    throw new Error("Grafana 中未发现可用的 Loki 日志数据源。");
  }
  return lokiDs.uid;
}

const server = new Server(
  {
    name: "grafana-loki-logs",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register Tool Definitions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_logs",
        description: `【推荐排查工具】精准安全地查询微服务日志。
【重要安全原则】严禁盲目进行大跨度或无边界的日志扫描，以免拖垮日志系统。排查时应严格遵循：
1. 先根据数据库记录（如订单创建/支付/失败时间）或客服反馈信息获取大致发生时间（target_time）；
2. 设定窄时间窗口（window_minutes，通常前后 5~10 分钟）进行聚焦检索；
3. 单次检索跨度严格限制在 2 小时以内。`,
        inputSchema: {
          type: "object",
          properties: {
            app: {
              type: "string",
              description: "目标微服务/应用名，如 'cxy-web', 'cxy-booking', 'cxy-ibe', 'cxy-hotel' 等 (建议必填)",
            },
            target_time: {
              type: "string",
              description: "【核心推荐】事件发生的大致基准时间点（例如从数据库查询到的 create_time、修改时间或客服反馈时间，格式如 '2026-08-23 08:35:00'）。指定后将自动查询该时间点前后的窗口日志",
            },
            window_minutes: {
              type: "number",
              description: "围绕 target_time 前后的搜索窗口半径分钟数（默认 5 分钟，即 target_time ± 5分钟，最大限制 30 分钟）",
              default: 5,
            },
            keyword: {
              type: "string",
              description: "关键词过滤（如订单号、TraceId、用户ID、异常关键字 'Exception', 'timeout', 'error' 等）",
            },
            start_time: {
              type: "string",
              description: "自定义开始时间 (与 target_time 互斥，格式 'YYYY-MM-DD HH:mm:ss'，总跨度不得超过 2 小时)",
            },
            end_time: {
              type: "string",
              description: "自定义结束时间 (配合 start_time 使用，默认为当前时间)",
            },
            minutes_ago: {
              type: "number",
              description: "仅排查当下实时问题时使用：查询最近 N 分钟内的日志 (默认 15 分钟，最大不得超过 60 分钟)",
            },
            namespace: {
              type: "string",
              description: "命名空间，默认为 'cxy'",
              default: "cxy",
            },
            pod: {
              type: "string",
              description: "指定 Pod 名称过滤 (可选)",
            },
            limit: {
              type: "number",
              description: "最多返回的日志行数 (默认 50 条，最大 200 条)",
              default: 50,
            },
          },
        },
      },
      {
        name: "list_applications",
        description: "获取日志系统中指定命名空间下的微服务/应用列表 (例如 cxy-web, cxy-booking 等)",
        inputSchema: {
          type: "object",
          properties: {
            namespace: {
              type: "string",
              description: "命名空间 (默认为 'cxy')",
              default: "cxy",
            },
          },
        },
      },
      {
        name: "list_namespaces",
        description: "获取日志系统中所有可用的命名空间列表",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "raw_logql_query",
        description: "【高级工具】执行自定义 LogQL 原生语句（受最大 2 小时时间窗口与服务名选择器保护）",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "LogQL 表达式，必须包含标签选择器，例如 '{app=\"cxy-web\"} |= \"Exception\"'",
            },
            target_time: {
              type: "string",
              description: "基准时间点 (如 '2026-08-23 08:35:00')",
            },
            window_minutes: {
              type: "number",
              description: "时间窗口半径分钟数 (默认 5 分钟)",
              default: 5,
            },
            minutes_ago: {
              type: "number",
              description: "最近 N 分钟 (最大 60 分钟)",
              default: 15,
            },
            limit: {
              type: "number",
              description: "最多返回条数 (默认 50，最大 200)",
              default: 50,
            },
          },
          required: ["query"],
        },
      },
    ],
  };
});

// Handle Tool Calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const uid = await getLokiDatasourceUid();

  try {
    if (name === "list_applications") {
      const namespace = args?.namespace || "cxy";
      const url = `/api/datasources/proxy/uid/${uid}/loki/api/v1/series?match[]={namespace="${namespace}"}`;
      const res = await grafanaFetch(url);
      const apps = new Set();
      if (res.data) {
        for (const item of res.data) {
          if (item.app) apps.add(item.app);
        }
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ namespace, count: apps.size, apps: Array.from(apps).sort() }, null, 2),
          },
        ],
      };
    }

    if (name === "list_namespaces") {
      const url = `/api/datasources/proxy/uid/${uid}/loki/api/v1/label/namespace/values`;
      const res = await grafanaFetch(url);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ namespaces: res.data || [] }, null, 2),
          },
        ],
      };
    }

    if (name === "search_logs" || name === "raw_logql_query") {
      let logql = "";
      const limit = Math.min(Math.max(Number(args?.limit) || 50, 1), 200);
      const now = Date.now();
      let startMs;
      let endMs;

      // 1. Calculate time boundaries based on input parameters
      if (args?.target_time) {
        const targetMs = parseDateTime(args.target_time);
        if (!targetMs) {
          throw new Error(`无法解析目标基准时间 target_time: "${args.target_time}"，请提供如 '2026-08-23 08:35:00' 格式的时间`);
        }
        const windowMin = Math.min(Math.max(Number(args.window_minutes) || DEFAULT_WINDOW_MINUTES, 1), 30);
        startMs = targetMs - windowMin * 60 * 1000;
        endMs = targetMs + windowMin * 60 * 1000;
      } else if (args?.start_time) {
        startMs = parseDateTime(args.start_time);
        if (!startMs) {
          throw new Error(`无法解析开始时间 start_time: "${args.start_time}"`);
        }
        endMs = args.end_time ? parseDateTime(args.end_time) : now;
        if (!endMs) {
          throw new Error(`无法解析结束时间 end_time: "${args.end_time}"`);
        }
      } else if (args?.minutes_ago) {
        const minAgo = Math.min(Math.max(Number(args.minutes_ago), 1), 60);
        startMs = now - minAgo * 60 * 1000;
        endMs = now;
      } else {
        // Default safe fallback: last 15 minutes
        startMs = now - 15 * 60 * 1000;
        endMs = now;
      }

      // Safety check: Validate time ordering and max time span
      if (startMs >= endMs) {
        throw new Error(`时间范围无效: 开始时间 (${formatLocalTime(startMs)}) 必须早于结束时间 (${formatLocalTime(endMs)})`);
      }

      const diffMs = endMs - startMs;
      if (diffMs > MAX_SEARCH_WINDOW_MS) {
        const hours = (diffMs / (1000 * 60 * 60)).toFixed(1);
        throw new Error(
          `【安全拦截】请求的日志时间跨度为 ${hours} 小时，超过了单次最大允许的 2 小时窗口限制！\n` +
          `请先从数据库操作时间或客服反馈时间确定具体时间点 (target_time)，将搜索范围缩小至 5~15 分钟内再行查询。`
        );
      }

      // 2. Build LogQL query
      if (name === "raw_logql_query") {
        logql = args.query;
        if (!logql.includes("{") || !logql.includes("}")) {
          throw new Error(`LogQL 语法不正确，必须包含流选择器，例如 '{app="cxy-web"}'`);
        }
      } else {
        const namespace = args?.namespace || "cxy";
        const app = args?.app;
        const keyword = args?.keyword;
        const pod = args?.pod;

        if (!app && !keyword) {
          throw new Error("【安全防护】为避免全量慢查询，请至少指定应用名称 (app) 或关键词 (keyword)。");
        }

        const selectors = [];
        if (namespace) selectors.push(`namespace="${namespace}"`);
        if (app) selectors.push(`app="${app}"`);
        if (pod) selectors.push(`pod=~"${pod}.*"`);

        logql = `{${selectors.join(", ")}}`;
        if (keyword && keyword.trim()) {
          logql += ` |= ${JSON.stringify(keyword.trim())}`;
        }
      }

      const startNs = BigInt(startMs) * 1_000_000n;
      const endNs = BigInt(endMs) * 1_000_000n;

      const params = new URLSearchParams({
        query: logql,
        start: startNs.toString(),
        end: endNs.toString(),
        limit: limit.toString(),
        direction: "backward",
      });

      const url = `/api/datasources/proxy/uid/${uid}/loki/api/v1/query_range?${params.toString()}`;
      const res = await grafanaFetch(url);

      if (res.status !== "success" || !res.data || !res.data.result) {
        return {
          content: [
            {
              type: "text",
              text: `在时间窗口 [${formatLocalTime(startMs)} ~ ${formatLocalTime(endMs)}] 内未检索到匹配的日志。\n查询语句: ${logql}`,
            },
          ],
        };
      }

      // Format log lines
      const logEntries = [];
      for (const streamObj of res.data.result) {
        const meta = streamObj.stream || {};
        const streamInfo = `[${meta.app || "unknown"}] [pod: ${meta.pod || "unknown"}] [${meta.stream || "stdout"}]`;
        for (const [timestampNs, logLine] of streamObj.values || []) {
          const logMs = Number(BigInt(timestampNs) / 1_000_000n);
          const timeStr = formatLocalTime(logMs);
          logEntries.push({
            time: timeStr,
            header: `${timeStr} ${streamInfo}`,
            line: logLine.trimEnd(),
            timestampNs: BigInt(timestampNs),
          });
        }
      }

      // Sort by timestamp descending (newest first)
      logEntries.sort((a, b) => (b.timestampNs > a.timestampNs ? 1 : -1));

      const timeRangeHeader = `时间窗口: ${formatLocalTime(startMs)} ~ ${formatLocalTime(endMs)} (跨度 ${Math.round(diffMs / 60000)} 分钟)`;

      if (logEntries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `查询完成，当前窗口未检索到日志。\n${timeRangeHeader}\n执行语句: ${logql}`,
            },
          ],
        };
      }

      const outputText = [
        `=== 日志查询结果 (共 ${logEntries.length} 条) ===`,
        `【${timeRangeHeader}】`,
        `【LogQL 语句: ${logql}】`,
        "--------------------------------------------------",
        ...logEntries.map((e) => `${e.header} -> ${e.line}`),
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text: outputText,
          },
        ],
      };
    }

    throw new Error(`未知的工具调用: ${name}`);
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `操作失败: ${err.message}`,
        },
      ],
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Grafana Loki Log MCP Server running with safety guardrails on stdio.");
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
