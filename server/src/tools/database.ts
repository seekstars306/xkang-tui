import mysql from 'mysql2/promise';
import { ServerConfig } from '../types.js';

export interface DatabaseToolArgs {
  action: 'list_databases' | 'list_tables' | 'describe_table' | 'search_schema' | 'query';
  database?: string;
  tableName?: string;
  keyword?: string;
  sql?: string;
  limit?: number;
}

const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT = 200;
// 工具自身把输出控制在预算内（超出时按行裁剪并明确说明），避免被 harness 从 JSON 中间硬截断
const RESULT_CHAR_BUDGET = 12000;
const CELL_MAX_CHARS = 300;
const QUERY_TIMEOUT_MS = 10000;
const META_TIMEOUT_MS = 6000;

let dbPool: mysql.Pool | null = null;
// 运行时自学的「表名→库」映射：MyCat 要求带库前缀或先 USE，模型常写裸表名；
// 成功执行过 db.table 后记录映射，后续裸表名查询自动路由（只是库表归属知识，各会话共享无副作用）
const tableDbCache = new Map<string, string>();
let knownDatabases: { list: string[]; at: number } | null = null;

function matchKnownDb(name: string, known: string[]): string | null {
  const lower = name.toLowerCase();
  return known.find((d) => d.toLowerCase() === lower) || null;
}

function learnTableDbMappings(sql: string, usedDb: string, known: string[]): void {
  if (!usedDb) return;
  for (const m of sql.matchAll(/`?([a-zA-Z0-9_]+)`?\s*\.\s*`?([a-zA-Z0-9_]+)`?/g)) {
    // 只学习 "真实库名.表名"，跳过表别名 (如 u.id)
    const db = matchKnownDb(m[1], known);
    if (db && db.toLowerCase() !== 'information_schema') {
      tableDbCache.set(m[2].toLowerCase(), db);
    }
  }
  for (const m of sql.matchAll(/\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?(?![\w.]|\s*\.)/gi)) {
    const t = m[1].toLowerCase();
    if (!tableDbCache.has(t) && !matchKnownDb(t, known) && !['select', 'where', 'on', 'and', 'or', 'dual'].includes(t)) {
      tableDbCache.set(t, usedDb);
    }
  }
}

/** 从 SQL 中的 `库名.表名` 推断目标库；只认真实存在的库名，避免把表别名 (u.id) 当成库 */
export function inferDbFromQualifiedNames(sql: string, known: string[]): string | null {
  for (const m of sql.matchAll(/`?([a-zA-Z0-9_]+)`?\s*\.\s*`?([a-zA-Z0-9_]+)`?/g)) {
    const db = matchKnownDb(m[1], known);
    if (db) return db;
  }
  return null;
}

function inferDbFromCache(sql: string): string | null {
  const bareTableMatch = sql.match(/\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?/i);
  if (bareTableMatch) {
    const cached = tableDbCache.get(bareTableMatch[1].toLowerCase());
    if (cached) return cached;
  }
  return null;
}

/** 数据库凭据只从环境变量读取（server/.env），代码中不再保留任何默认账号密码 */
export function getDbConnectionConfig(): mysql.ConnectionOptions | null {
  const host = process.env.COMPANY_DB_HOST;
  const user = process.env.COMPANY_DB_USER;
  const password = process.env.COMPANY_DB_PASSWORD;
  if (!host || !user || !password) return null;
  return {
    host,
    port: parseInt(process.env.COMPANY_DB_PORT || '8066', 10),
    user,
    password,
    connectTimeout: 8000,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    // 日期时间按库内原样字符串返回；否则会被转成 JS Date 再序列化成 UTC（差 8 小时），模型据此给出错误时间、查错日志窗口
    dateStrings: true,
  };
}

const MISSING_DB_CONFIG = '服务端未配置 COMPANY_DB_HOST / COMPANY_DB_USER / COMPANY_DB_PASSWORD，无法查询数据库，请联系管理员在 server/.env 中配置。';

export function getDbPool(): mysql.Pool {
  if (!dbPool) {
    const cfg = getDbConnectionConfig();
    if (!cfg) throw new Error(MISSING_DB_CONFIG);
    dbPool = mysql.createPool({ ...cfg, waitForConnections: true, connectionLimit: 8 });
  }
  return dbPool;
}

/** 关闭连接池（测试与进程退出时使用） */
export async function closeDbPool(): Promise<void> {
  if (dbPool) {
    const pool = dbPool;
    dbPool = null;
    await pool.end();
  }
}

const FORBIDDEN_SQL_PATTERNS = [
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\bdrop\b/i,
  /\balter\b/i,
  /\btruncate\b/i,
  /\bcreate\b/i,
  /\breplace\b/i,
  /\brename\b/i,
  /\bgrant\b/i,
  /\brevoke\b/i,
  /\block\b/i,
  /\bunlock\b/i,
  /\bflush\b/i,
  /\bkill\b/i,
  /\bcall\b/i,
  /(?:^|;)\s*set\s+/i, // Blocks standalone SET command (e.g. SET @var = ...), but allows literal strings like WHERE status = 'SET'
  /\binto\s+outfile\b/i,
  /\binto\s+dumpfile\b/i,
  /\bload_file\b/i,
  /\bload\s+data\b/i,
];

/** 去掉模型常带的 ```sql 代码块包裹与首尾分号 */
export function normalizeSqlText(sql: string): string {
  return sql
    .replace(/^```(?:sql)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
    .replace(/^;+|;+$/g, '')
    .trim();
}

/**
 * Validate that SQL query is strictly read-only and free of dangerous multi-statements
 */
export function validateReadOnlySql(sql: string): { valid: boolean; reason?: string } {
  const trimmed = normalizeSqlText(sql);

  if (!trimmed) {
    return { valid: false, reason: 'SQL 语句不能为空。' };
  }

  if (trimmed.includes(';')) {
    return { valid: false, reason: '禁止在单个请求中执行多条分号连接的 SQL 语句。' };
  }

  // 块注释可分割关键字绕过黑名单 (如 DE/**/LETE)，SELECT 查询中无合法用途，直接整体拒绝
  if (/\/\*[\s\S]*?\*\//.test(trimmed) || trimmed.includes('/*') || trimmed.includes('*/')) {
    return {
      valid: false,
      reason: '【安全拦截】检测到 SQL 块注释(/* */)：为防止关键字分割绕过 (如 DE/**/LETE)，只读查询禁止携带块注释。',
    };
  }

  const startsWithReadOnly = /^(select|show|explain|desc|describe)\b/i.test(trimmed);
  if (!startsWithReadOnly) {
    return {
      valid: false,
      reason: '【安全拦截】只读检索工具仅允许执行 SELECT, SHOW, DESCRIBE, EXPLAIN 查询。',
    };
  }

  for (const pattern of FORBIDDEN_SQL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        reason: `【安全拦截】检测到潜在的写操作或高危关键字: ${pattern.toString()}`,
      };
    }
  }

  return { valid: true };
}

/**
 * 把等值比较 / IN 列表中 11 位以上的裸数字字面量加上引号。
 * 单号、雪花 ID、手机号、票号多存为字符串列：`varchar列 = 1541...` 会触发隐式类型转换，
 * 既用不上索引（全表扫描 → 超时），又按 double 比较产生精度误差（可能命中相邻 ID）。
 * 对整数列，MySQL 会把字符串常量转回整数比较，同样能走索引，因此加引号对两种列都安全。
 */
export function quoteLongIdLiterals(sql: string): { sql: string; changed: boolean } {
  let out = '';
  let changed = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\' && ch !== '`') {
          j += 2;
          continue;
        }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch >= '0' && ch <= '9' && (i === 0 || !/[\w.$]/.test(sql[i - 1]))) {
      let j = i;
      while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') j++;
      const num = sql.slice(i, j);
      const boundaryOk = j >= sql.length || !/[\w.]/.test(sql[j]);
      if (num.length >= 11 && boundaryOk) {
        const before = out.replace(/\s+$/, '');
        const last2 = before.slice(-2);
        const last1 = before.slice(-1);
        const isEquality = last2 === '<>' || last2 === '!=' || (last1 === '=' && last2 !== '>=' && last2 !== '<=');
        const isListItem = last1 === '(' || last1 === ',';
        const inLimit = /\blimit\s+(\d+\s*,\s*)?$/i.test(before) || /\boffset\s*$/i.test(before);
        if ((isEquality || isListItem) && !inLimit) {
          out += `'${num}'`;
          changed = true;
          i = j;
          continue;
        }
      }
      out += num;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return { sql: out, changed };
}

/** SELECT 未写 LIMIT 时追加 LIMIT n+1：多取一行用来判断"后面还有没有"，而不是静默截在第 n 行 */
export function applyRowLimit(sql: string, limit: number): { sql: string; probeLimit: number | null; userLimit: number | null } {
  if (!/^select\b/i.test(sql)) return { sql, probeLimit: null, userLimit: null };
  const limitMatches = Array.from(sql.matchAll(/\blimit\s+(\d+)(?:\s*,\s*(\d+)|\s+offset\s+\d+)?/gi));
  if (limitMatches.length === 0) {
    return { sql: `${sql} LIMIT ${limit + 1}`, probeLimit: limit, userLimit: null };
  }
  const last = limitMatches[limitMatches.length - 1];
  const userLimit = Number(last[2] ?? last[1]);
  return { sql, probeLimit: null, userLimit: Number.isFinite(userLimit) ? userLimit : null };
}

function formatCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `[二进制 ${value.length} 字节]`;
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  if (typeof value === 'string' && value.length > CELL_MAX_CHARS) {
    return value.slice(0, CELL_MAX_CHARS) + `…[文本截断，共 ${value.length} 字符]`;
  }
  if (typeof value === 'object') {
    const s = JSON.stringify(value);
    return s.length > CELL_MAX_CHARS ? s.slice(0, CELL_MAX_CHARS) + `…[截断，共 ${s.length} 字符]` : s;
  }
  return value;
}

export interface FormatRowsOptions {
  database: string;
  executedSql: string;
  rows: Array<Record<string, unknown>>;
  limit: number;
  probeLimit: number | null;
  userLimit: number | null;
  notes?: string[];
  budget?: number;
}

/**
 * 紧凑输出：columns + 行数组（不再逐行重复字段名、不再 2 空格缩进），全为 NULL 的列单独列出。
 * 结果不完整（超过 limit / 撞到用户 LIMIT / 超出输出预算）时一定显式标注，防止模型把部分数据当全量。
 */
export function formatRowsResult(opts: FormatRowsOptions): string {
  const budget = opts.budget ?? RESULT_CHAR_BUDGET;
  const fetched = opts.rows;
  const cap = Math.min(opts.limit, MAX_ROW_LIMIT);
  const hasMore = opts.probeLimit != null ? fetched.length > opts.probeLimit : fetched.length > cap;
  const maybeMore = opts.userLimit != null && fetched.length >= Math.min(opts.userLimit, cap);
  const kept = fetched.slice(0, opts.probeLimit != null ? opts.probeLimit : cap);

  const columns = kept.length > 0 ? Object.keys(kept[0]) : [];
  const allNullColumns = columns.filter((c) => kept.every((r) => r[c] === null || r[c] === undefined));
  const cols = columns.filter((c) => !allNullColumns.includes(c));
  let rowArrays = kept.map((r) => cols.map((c) => formatCell(r[c])));
  const truncatedCells = kept.reduce((total, row) => total + cols.filter(column => {
    const value = row[column];
    return typeof value === 'string' ? value.length > CELL_MAX_CHARS : value !== null && typeof value === 'object' && !(value instanceof Date) && JSON.stringify(value).length > CELL_MAX_CHARS;
  }).length, 0);

  const notes = [...(opts.notes || [])];
  if (hasMore) {
    notes.push(
      `结果不完整：满足条件的数据超过 ${kept.length} 行，这里只返回了前 ${kept.length} 行。需要完整名单或统计时，请先用 COUNT(*)/GROUP BY 得到总数，再加过滤条件、只选必要列或用 LIMIT n OFFSET m 分页取完，不要把这部分结果当作全部。`
    );
  } else if (maybeMore) {
    notes.push(`返回行数恰好等于 SQL 中的 LIMIT ${opts.userLimit}，后面可能还有更多数据。`);
  }

  const build = (rowsForOutput: unknown[][], droppedByOutput: number) => {
    const outNotes = [...notes];
    if (droppedByOutput > 0) {
      outNotes.push(
        `因输出长度限制只展示了前 ${rowsForOutput.length} 行（本次实际取回 ${kept.length} 行，另有 ${droppedByOutput} 行未展示）。请减少返回列（避免 SELECT *）或分页查询。`
      );
    }
    return JSON.stringify({
      status: 'success',
      action: 'query',
      database: opts.database,
      executedSql: opts.executedSql,
      rowCount: rowsForOutput.length,
      complete: !hasMore && !maybeMore && droppedByOutput === 0 && truncatedCells === 0,
      ...(truncatedCells ? { truncatedCells, truncated: true } : {}),
      ...(outNotes.length ? { notes: outNotes } : {}),
      columns: cols,
      ...(allNullColumns.length ? { allNullColumns } : {}),
      rows: rowsForOutput,
    });
  };

  let output = build(rowArrays, 0);
  if (output.length > budget && rowArrays.length > 1) {
    let lo = 1;
    let hi = rowArrays.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (build(rowArrays.slice(0, mid), kept.length - mid).length <= budget) lo = mid;
      else hi = mid - 1;
    }
    rowArrays = rowArrays.slice(0, lo);
    output = build(rowArrays, kept.length - lo);
  }
  return output;
}

export class QueryTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}超时 (${Math.round(ms / 1000)}s)`);
    this.name = 'QueryTimeoutError';
  }
}

/** 连接不上数据库（网络不通、库宕机、连接池耗尽），与慢查询区分开：这不是 SQL 写法问题 */
export class DbConnectError extends Error {
  constructor(cause: unknown) {
    super(`无法连接数据库: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'DbConnectError';
  }
}

export const DB_CONNECT_GUIDANCE =
  '这是数据库连接失败（网络不通或数据库暂不可用），与 SQL 写法无关，换写法重试没有意义。请如实告诉客服"数据暂时无法查询"，可以先用代码检索等其他途径排查，稍后再重试查库。';

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new QueryTimeoutError(label, timeoutMs)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

type KillConnectionFactory = () => Promise<{ query: (sql: string) => Promise<unknown>; end: () => Promise<void> }>;

const defaultKillConnectionFactory: KillConnectionFactory = async () => {
  const cfg = getDbConnectionConfig();
  if (!cfg) throw new Error(MISSING_DB_CONFIG);
  return mysql.createConnection(cfg);
};

/**
 * 超时后真正取消服务端仍在执行的语句：只放弃等待会让慢查询继续占着库，
 * 堆积后连按主键查都会超时（历史会话中出现过 29 次查询 25 次超时）。
 * 先 KILL QUERY，不支持时（部分 MyCat 版本）退回 KILL 连接；均为尽力而为，失败不影响主流程。
 */
export async function killRunningQuery(
  threadId: number | undefined,
  factory: KillConnectionFactory = defaultKillConnectionFactory
): Promise<'killed' | 'skipped' | 'failed'> {
  if (!threadId || !Number.isInteger(threadId)) return 'skipped';
  let conn: Awaited<ReturnType<KillConnectionFactory>> | null = null;
  try {
    conn = await withTimeout(factory(), 4000, '建立终止连接');
    try {
      await withTimeout(conn.query(`KILL QUERY ${threadId}`), 3000, 'KILL QUERY ');
    } catch {
      await withTimeout(conn.query(`KILL ${threadId}`), 3000, 'KILL ');
    }
    return 'killed';
  } catch {
    return 'failed';
  } finally {
    if (conn) {
      try {
        await conn.end();
      } catch {}
    }
  }
}

function threadIdOf(conn: mysql.PoolConnection): number | undefined {
  const anyConn = conn as any;
  return anyConn.threadId ?? anyConn.connection?.threadId;
}

export interface QueryContext {
  conn: mysql.PoolConnection;
  timedOut: boolean;
}

/** 在已获取的连接上执行语句；超时会尝试终止服务端执行并把连接标记为需销毁 */
export async function runQuery<T = unknown>(
  ctx: QueryContext,
  sql: string,
  values: unknown[] | undefined,
  timeoutMs: number,
  label: string
): Promise<T> {
  try {
    const result = values ? await withTimeout(ctx.conn.query(sql, values), timeoutMs, label) : await withTimeout(ctx.conn.query(sql), timeoutMs, label);
    return result as T;
  } catch (err) {
    if (err instanceof QueryTimeoutError) {
      ctx.timedOut = true;
      await killRunningQuery(threadIdOf(ctx.conn));
    }
    throw err;
  }
}

/** 获取连接并在结束后归还；超时/断连后的连接直接销毁，避免把"中毒连接"还给连接池 */
export async function withDbConnection<T>(fn: (ctx: QueryContext) => Promise<T>): Promise<T> {
  const pool = getDbPool();
  let conn: mysql.PoolConnection;
  try {
    conn = await withTimeout(pool.getConnection(), META_TIMEOUT_MS, '获取数据库连接');
  } catch (err) {
    throw new DbConnectError(err);
  }
  const ctx: QueryContext = { conn, timedOut: false };
  try {
    return await fn(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ECONNRESET|EPIPE|PROTOCOL_CONNECTION_LOST/i.test(msg)) ctx.timedOut = true;
    throw err;
  } finally {
    if (ctx.timedOut) {
      try {
        (conn as any).destroy();
      } catch {
        try {
          conn.release();
        } catch {}
      }
    } else {
      try {
        conn.release();
      } catch {}
    }
  }
}

function safeIdent(name: string): string {
  return name.replace(/`/g, '');
}

async function getKnownDatabases(ctx: QueryContext): Promise<string[]> {
  if (knownDatabases && Date.now() - knownDatabases.at < 10 * 60 * 1000) return knownDatabases.list;
  const [rows] = await runQuery<any[]>(ctx, 'SHOW DATABASES', undefined, META_TIMEOUT_MS, '查询数据库清单');
  const list = (rows as Array<Record<string, unknown>>).map((r) => String(r.DATABASE || Object.values(r)[0]));
  knownDatabases = { list, at: Date.now() };
  return list;
}

/**
 * Normalize an LLM-supplied keyword string into a list of individual keywords.
 * Handles OR / || / | / commas / whitespace separators and surrounding quotes.
 */
function normalizeKeywords(raw: string): string[] {
  return raw
    .replace(/^["'`]|["'`]$/g, '')
    .split(/\s+or\s+|\s*\|\|?\s*|,|\s+/i)
    .map((k) => k.trim().replace(/^["'`]|["'`]$/g, '').toLowerCase())
    .filter((k) => k.length > 0)
    .filter((k, i, arr) => arr.indexOf(k) === i);
}

const SLOW_QUERY_GUIDANCE =
  '该查询已超时并已尝试终止服务端执行。常见原因是没有用上索引：1) 先用 action:"describe_table" 查看表的索引列，改用索引列等值查询（单号、ID 请加引号按字符串比较）；2) 大表加 create_time 等时间窗口；3) 不要对大表做无边界的 LIKE \'%关键词%\'，也不要把多个列用 OR 串起来；4) 不要原样重试同一查询。';

function errorJson(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ status: 'error', message, ...extra });
}

export async function executeDatabaseTool(
  args: DatabaseToolArgs,
  _config: ServerConfig,
  user: string
): Promise<string> {
  if (!getDbConnectionConfig()) {
    return errorJson(MISSING_DB_CONFIG);
  }
  const action = args.action || 'list_databases';

  try {
    return await withDbConnection(async (ctx) => {
      switch (action) {
        case 'list_databases': {
          const [rows] = await runQuery<any[]>(ctx, 'SHOW DATABASES', undefined, META_TIMEOUT_MS, '查询数据库清单');
          const dbList = (rows as Array<Record<string, unknown>>).map((r) => String(r.DATABASE || Object.values(r)[0]));
          return JSON.stringify({
            status: 'success',
            action,
            totalDatabases: dbList.length,
            databases: dbList,
            note: '可用 action:"list_tables", database:"<库名>" 查看各库内的表。',
          });
        }

        case 'list_tables': {
          const db = args.database?.trim();
          if (!db) {
            return errorJson('缺少必填参数 database（如 "skt" 或 "payment"）');
          }
          await runQuery(ctx, `USE \`${safeIdent(db)}\``, undefined, META_TIMEOUT_MS, '切换数据库');
          const [tables] = await runQuery<any[]>(ctx, 'SHOW TABLES', undefined, META_TIMEOUT_MS, '查询数据表清单');
          let tableList = (tables as Array<Record<string, unknown>>).map((t) => String(Object.values(t)[0]));
          if (args.keyword?.trim()) {
            const keywords = normalizeKeywords(args.keyword);
            if (keywords.length > 0) {
              tableList = tableList.filter((t) => keywords.some((kw) => t.toLowerCase().includes(kw)));
            }
          }
          const shown = tableList.slice(0, 300);
          return JSON.stringify({
            status: 'success',
            action,
            database: db,
            matchedCount: tableList.length,
            complete: shown.length === tableList.length,
            ...(shown.length < tableList.length ? { note: `只列出前 ${shown.length} 个表，请用 keyword 过滤缩小范围。` } : {}),
            tables: shown,
          });
        }

        case 'describe_table': {
          let db = args.database?.trim();
          let table = args.tableName?.trim() || args.keyword?.trim();
          if (table && table.includes('.')) {
            const parts = table.split('.');
            if (parts.length === 2) {
              db = db || parts[0].replace(/[`'"]/g, '').trim();
              table = parts[1].replace(/[`'"]/g, '').trim();
            }
          }
          if (table && /\s+or\s+|\||,|\s+/i.test(table)) {
            const candidates = normalizeKeywords(table);
            if (candidates.length > 0) table = candidates[0];
          }
          const defaulted = !db;
          if (!db) db = 'skt';
          if (!table) {
            return errorJson('缺少必填参数 tableName（如 tableName: "order_air"）');
          }

          try {
            await runQuery(ctx, `USE \`${safeIdent(db)}\``, undefined, META_TIMEOUT_MS, '切换数据库');
            const [columns] = await runQuery<any[]>(ctx, `SHOW FULL COLUMNS FROM \`${safeIdent(table)}\``, undefined, META_TIMEOUT_MS, '查询表结构');
            let indexes: Array<{ name: string; unique: boolean; columns: string[] }> = [];
            try {
              const [idxRows] = await runQuery<any[]>(ctx, `SHOW INDEX FROM \`${safeIdent(table)}\``, undefined, META_TIMEOUT_MS, '查询索引');
              const byName = new Map<string, { name: string; unique: boolean; columns: string[] }>();
              for (const r of idxRows as Array<Record<string, any>>) {
                const name = String(r.Key_name);
                const entry = byName.get(name) || { name, unique: Number(r.Non_unique) === 0, columns: [] };
                entry.columns[Number(r.Seq_in_index) - 1] = String(r.Column_name);
                byName.set(name, entry);
              }
              indexes = Array.from(byName.values()).map((e) => ({ ...e, columns: e.columns.filter(Boolean) }));
            } catch {
              // 索引信息拿不到不影响表结构返回
            }
            const columnDetails = (columns as Array<Record<string, unknown>>).map((c) => {
              const item: Record<string, unknown> = { field: c.Field, type: c.Type };
              if (c.Key) item.key = c.Key;
              if (c.Null === 'NO') item.notNull = true;
              if (c.Comment) item.comment = c.Comment;
              return item;
            });
            return JSON.stringify({
              status: 'success',
              action,
              database: db,
              tableName: table,
              ...(defaulted ? { note: '未指定 database，默认使用 skt 库。' } : {}),
              totalColumns: columnDetails.length,
              indexes,
              indexHint: '查询大表时请优先用 indexes 中的列做等值条件，否则容易全表扫描超时。',
              columns: columnDetails,
            });
          } catch (err) {
            if (err instanceof QueryTimeoutError) throw err;
            return errorJson(`查看表结构失败: ${err instanceof Error ? err.message : String(err)}`, {
              note: '请检查库名/表名是否正确，可先用 action:"list_tables" 或 "search_schema" 确认真实表名。',
            });
          }
        }

        case 'search_schema': {
          const rawKeyword = (args.keyword || '').trim();
          if (!rawKeyword) {
            return errorJson('缺少必填参数 keyword（如 "refund" 或 "hotel"，支持 "A OR B" / "a|b" / "a,b" 多关键词）');
          }
          const keywords = normalizeKeywords(rawKeyword);
          if (keywords.length === 0) {
            return errorJson('无法从 keyword 中解析出有效关键词。');
          }
          const [dbs] = await runQuery<any[]>(ctx, 'SHOW DATABASES', undefined, META_TIMEOUT_MS, '查询数据库列表');
          const dbList = (dbs as Array<Record<string, unknown>>).map((r) => String(r.DATABASE || Object.values(r)[0]));
          const targetDbs = args.database?.trim() ? [args.database.trim()] : dbList;
          const matches: Array<{ database: string; table: string }> = [];
          const failedDbs: string[] = [];
          for (const db of targetDbs) {
            try {
              await runQuery(ctx, `USE \`${safeIdent(db)}\``, undefined, 4000, '选库');
              const [tables] = await runQuery<any[]>(ctx, 'SHOW TABLES', undefined, 4000, '读表');
              for (const t of tables as Array<Record<string, unknown>>) {
                const tableName = String(Object.values(t)[0]);
                if (keywords.some((kw) => tableName.toLowerCase().includes(kw))) {
                  matches.push({ database: db, table: tableName });
                }
              }
            } catch (err) {
              if (err instanceof QueryTimeoutError) throw err;
              failedDbs.push(db);
            }
          }
          const looksLikeData = keywords.some((k) => /^\d{7,}$/.test(k) || /^[一-龥]{2,}$/.test(k));
          return JSON.stringify({
            status: 'success',
            action,
            keyword: rawKeyword,
            totalMatches: matches.length,
            matches: matches.slice(0, 150),
            ...(failedDbs.length ? { skippedDatabases: failedDbs } : {}),
            note:
              matches.length === 0
                ? looksLikeData
                  ? 'search_schema 只按"表名"匹配英文词根。看起来你输入的是业务数据（单号/手机号/中文），请改用 lookup_order 定位单号，或直接 action:"query" 写 SQL 查数据行。'
                  : '没有表名包含这些关键词。请换更短的英文词根（如 order / refund / hotel），或先 list_databases 再 list_tables 浏览。'
                : '找到候选表后请先 describe_table 确认字段与索引，再写查询。',
          });
        }

        case 'query': {
          let rawSql = (args.sql || '').trim();
          // 参数兜底：模型把 SQL 或条件写进了 keyword/tableName
          if (!rawSql && args.keyword?.trim()) {
            const kw = args.keyword.trim();
            if (/^(select|show|desc|explain)\b/i.test(kw)) {
              rawSql = kw;
            } else if (args.tableName?.trim()) {
              rawSql = 'SELECT * FROM `' + safeIdent(args.tableName.trim()) + '` WHERE ' + kw.replace(/^where\s+/i, '');
            }
          }
          if (!rawSql) {
            return errorJson('缺少必填参数 sql（如 sql: "SELECT ... FROM skt.order_air WHERE air_id = \'1540797466482442240\'"）');
          }

          const validation = validateReadOnlySql(rawSql);
          if (!validation.valid) {
            return JSON.stringify({ status: 'security_violation', message: validation.reason, sql: rawSql });
          }

          const notes: string[] = [];
          const quoted = quoteLongIdLiterals(normalizeSqlText(rawSql));
          let sql = quoted.sql;
          if (quoted.changed) {
            notes.push('已把长数字 ID 字面量自动加引号按字符串比较（字符串列与数字比较会全表扫描且有精度误差）。');
          }

          let db = args.database?.trim();
          let known: string[] = [];
          try {
            known = await getKnownDatabases(ctx);
          } catch (err) {
            if (err instanceof QueryTimeoutError) throw err;
          }
          if (!db) {
            db = inferDbFromQualifiedNames(sql, known) || inferDbFromCache(sql) || undefined;
          }
          if (!db) {
            db = 'skt';
            notes.push('未指定 database，默认使用 skt 库。');
          }

          const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_ROW_LIMIT, 1), MAX_ROW_LIMIT);
          const limited = applyRowLimit(sql, limit);
          sql = limited.sql;

          try {
            await runQuery(ctx, `USE \`${safeIdent(db)}\``, undefined, META_TIMEOUT_MS, '切换数据库');
            const [rows] = await runQuery<any>(ctx, sql, undefined, QUERY_TIMEOUT_MS, '数据库执行 SQL ');
            const rowsArray = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
            learnTableDbMappings(sql, db, known);
            return formatRowsResult({
              database: db,
              executedSql: sql,
              rows: rowsArray,
              limit,
              probeLimit: limited.probeLimit,
              userLimit: limited.userLimit,
              notes,
            });
          } catch (queryErr) {
            if (queryErr instanceof QueryTimeoutError) {
              return errorJson(`数据库查询异常: ${queryErr.message}`, { database: db, executedSql: sql, guidance: SLOW_QUERY_GUIDANCE });
            }
            const qMsg = queryErr instanceof Error ? queryErr.message : String(queryErr);
            let hint = '';
            if (/no\s+\w*\s*database\s*selected/i.test(qMsg)) {
              hint = '（提示：MyCat 要求先指定库，请传 database 参数或在 SQL 中使用 `库名.表名`）';
            } else if (/unknown\s+column|1054/i.test(qMsg)) {
              hint = '（提示：字段名不存在，请先 action:"describe_table" 确认真实字段名）';
            } else if (/doesn't exist|1146|unknown\s+table/i.test(qMsg)) {
              hint = '（提示：表不存在，请用 action:"search_schema" 或 "list_tables" 确认真实表名）';
            }
            return errorJson(`数据库查询异常: ${qMsg}${hint}`, { database: db, executedSql: sql });
          }
        }

        default:
          return errorJson(`未知的 action: ${args.action}。可用选项: list_databases, list_tables, describe_table, search_schema, query`);
      }
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (err instanceof DbConnectError) {
      return errorJson(`数据库查询异常: ${errorMsg}`, { guidance: DB_CONNECT_GUIDANCE });
    }
    if (err instanceof QueryTimeoutError) {
      return errorJson(`数据库查询异常: ${errorMsg}`, { guidance: SLOW_QUERY_GUIDANCE });
    }
    return errorJson(`数据库查询异常: ${errorMsg}`, { queriedBy: user });
  }
}
