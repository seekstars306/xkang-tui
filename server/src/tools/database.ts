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

// Global connection pool
let dbPool: mysql.Pool | null = null;
// 运行时自学的「表名→库」映射缓存：MyCat 要求查询带库前缀或先 USE，
// 模型经常写裸表名导致 "No MyCAT Database selected"；成功执行过 db.table 后
// 记录映射，后续裸表名查询自动路由到正确库（纯运行时自适应，无业务硬编码）
const tableDbCache = new Map<string, string>();

function learnTableDbMappings(sql: string, usedDb: string): void {
  if (!usedDb) return;
  for (const m of sql.matchAll(/`?([a-zA-Z0-9_]+)`?\s*\.\s*`?([a-zA-Z0-9_]+)`?/g)) {
    if (m[1].toLowerCase() !== 'information_schema') {
      tableDbCache.set(m[2].toLowerCase(), m[1]);
    }
  }
  for (const m of sql.matchAll(/\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?/gi)) {
    const t = m[1].toLowerCase();
    if (!tableDbCache.has(t) && !['select', 'where', 'on', 'and', 'or', 'dual'].includes(t)) {
      tableDbCache.set(t, usedDb);
    }
  }
}

function inferDbFromCache(sql: string): string | null {
  const bareTableMatch = sql.match(/\b(?:from|join)\s+`?([a-zA-Z0-9_]+)`?/i);
  if (bareTableMatch) {
    const cached = tableDbCache.get(bareTableMatch[1].toLowerCase());
    if (cached) return cached;
  }
  return null;
}

export function getDbPool(): mysql.Pool {
  if (!dbPool) {
    const host = process.env.COMPANY_DB_HOST || '10.197.236.175';
    const port = parseInt(process.env.COMPANY_DB_PORT || '8066', 10);
    const user = process.env.COMPANY_DB_USER || 'zhangzhao';
    const password = process.env.COMPANY_DB_PASSWORD || '';

    dbPool = mysql.createPool({
      host,
      port,
      user,
      password,
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 8000,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  }
  return dbPool;
}

// Forbidden SQL keywords for security inspection (destructive commands)
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

/**
 * Validate that SQL query is strictly read-only and free of dangerous multi-statements
 */
export function validateReadOnlySql(sql: string): { valid: boolean; reason?: string } {
  // Strip markdown code block wrappers (```sql ... ```) if passed by LLM
  const stripped = sql.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const trimmed = stripped.replace(/^;+|;+$/g, '').trim();

  if (!trimmed) {
    return { valid: false, reason: 'SQL 语句不能为空。' };
  }

  // Check for statement chaining with semicolons
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

  // Check leading command
  const startsWithReadOnly = /^(select|show|explain|desc|describe)\b/i.test(trimmed);
  if (!startsWithReadOnly) {
    return {
      valid: false,
      reason: '【安全拦截】只读检索工具仅允许执行 SELECT, SHOW, DESCRIBE, EXPLAIN 查询。',
    };
  }

  // Check forbidden keywords
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
 * Normalize an LLM-supplied keyword string into a list of individual keywords.
 * Handles common LLM conventions: OR / || / | / commas / whitespace separators,
 * surrounding quotes, and mixed case. Returns deduplicated, non-empty tokens.
 *
 * Mirrors the lenient normalization applied in code_search.ts so models that pass
 * "A OR B", "a|b|c", or "a, b" all behave the same as a clean multi-keyword list.
 */
function normalizeKeywords(raw: string): string[] {
  return raw
    .replace(/^["'`]|["'`]$/g, '') // strip surrounding quotes
    .split(/\s+(?:or|or|OR)\s+|\s*\|\|?\s*|,|\s+/i) // OR / || / | / comma / whitespace
    .map((k) => k.trim().replace(/^["'`]|["'`]$/g, '').toLowerCase())
    .filter((k) => k.length > 0)
    .filter((k, i, arr) => arr.indexOf(k) === i); // dedupe
}

/**
 * Truncate overly long values (e.g. certificates, long JSON blobs) to prevent context window overflow
 */
function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string' && value.length > 300) {
      sanitized[key] = value.slice(0, 300) + `... [文本截断，共 ${value.length} 字符]`;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMsg: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(errorMsg)), timeoutMs);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

export async function executeDatabaseTool(
  args: DatabaseToolArgs,
  _config: ServerConfig,
  user: string
): Promise<string> {
  const pool = getDbPool();
  let conn: mysql.PoolConnection | null = null;
  let hadTimeout = false;
  // 排障引导：查库结果尾部追加日志维度提醒（数据库只能证明数据状态，无法证明接口行为）
  const LOG_HINT = '\n\n[排障提示] 以上仅为数据库落库数据。若排查”查不到/不展示/失败/转圈”等功能异常，数据库正常不代表接口正常——请继续调用 search_logs 查询相关微服务日志（有单号/时间用 target_time+keyword，无线索用 minutes_ago 盲查），获取接口调用、异常堆栈与下游响应证据后再下结论。';

  // 超时等异常后连接上可能仍挂着未完成的慢查询，release 会把"中毒连接"还给池子拖垮后续所有查询，必须直接销毁
  const SLOW_QUERY_GUIDANCE =
    '该查询已超时中断。若目标为日志/流水/历史记录类大表，请：1) 先用 SHOW INDEX FROM 表名 确认索引列，改用索引列等值查询（如 WHERE order_id = 单号）；2) 或增加 create_time 窄时间窗口（±1天内）与用户名等过滤条件；3) 严禁对大表执行无时间边界的 LIKE %关键词% 全表扫描，也不要原样重试同一查询形态。';

  // 连续失败计数：识别数据库通道整体降级并引导切换排查通道
  let consecutiveDbFailures = (globalThis as any).__xkangDbFailures || 0;

  const wrapWithLogHint = (resultJson: string): string => {
    try {
      const obj = JSON.parse(resultJson);
      if (obj.status === 'success' && !obj.nextStepHint) {
        obj.nextStepHint = LOG_HINT;
      }
      return JSON.stringify(obj, null, 2);
    } catch {
      return resultJson;
    }
  };

  try {
    conn = await withTimeout(pool.getConnection(), 6000, '获取数据库连接超时 (6s)');
    const action = args.action || 'list_databases';

    const result = wrapWithLogHint(await (async () => { switch (action) {
      case 'list_databases': {
        const [rows] = await withTimeout(conn.query('SHOW DATABASES'), 6000, '查询数据库清单超时 (6s)');
        const dbList = (rows as Array<Record<string, unknown>>).map(
          (r) => String(r.DATABASE || Object.values(r)[0])
        );

        return JSON.stringify(
          {
            status: 'success',
            action: 'list_databases',
            queriedBy: user,
            totalDatabases: dbList.length,
            databases: dbList,
            note: '可通过 action: “list_tables”, database: “<库名>” 查看各库内的表清单。',
          },
          null,
          2
        );
      }

      case 'list_tables': {
        const db = args.database?.trim();
        if (!db) {
          return JSON.stringify({
            status: 'error',
            message: '缺少必填参数 database（请指定要查看的数据库名称，如 “payment” 或 “skt”）',
          });
        }

        await withTimeout(conn.query(`USE \`${db.replace(/`/g, '')}\``), 6000, '切换数据库超时 (6s)');
        const [tables] = await withTimeout(conn.query('SHOW TABLES'), 6000, '查询数据表清单超时 (6s)');
        let tableList = (tables as Array<Record<string, unknown>>).map(
          (t) => String(Object.values(t)[0])
        );

        // Filter by pattern if provided (supports multi-keyword via OR/|/comma/whitespace)
        if (args.keyword?.trim()) {
          const keywords = normalizeKeywords(args.keyword);
          if (keywords.length > 0) {
            tableList = tableList.filter((t) => {
              const tLower = t.toLowerCase();
              return keywords.some((kw) => tLower.includes(kw));
            });
          }
        }

        return JSON.stringify(
          {
            status: 'success',
            action: 'list_tables',
            database: db,
            queriedBy: user,
            matchedCount: tableList.length,
            tables: tableList.slice(0, 200),
            isTruncated: tableList.length > 200,
            note: '可通过 action: “describe_table”, database: “' + db + '”, tableName: “<表名>” 查看具体表结构及字段注释。',
          },
          null,
          2
        );
      }

      case 'describe_table': {
        let db = args.database?.trim();
        let table = args.tableName?.trim() || args.keyword?.trim();

        // If table contains db prefix (e.g. skt.train_order_passenger)
        if (table && table.includes('.')) {
          const parts = table.split('.');
          if (parts.length === 2) {
            db = db || parts[0].replace(/[`'\”]/g, '').trim();
            table = parts[1].replace(/[`'\”]/g, '').trim();
          }
        }

        // If tableName had multiple keywords like “a OR b”, take the first valid table candidate
        if (table && /\s+(?:or|OR)\s+|\||,|\s+/i.test(table)) {
          const candidates = normalizeKeywords(table);
          if (candidates.length > 0) {
            table = candidates[0];
          }
        }

        if (!db) {
          db = 'skt'; // Default to primary company database
        }

        if (!table) {
          return JSON.stringify({
            status: 'error',
            message: '缺少必填参数 tableName（如 tableName: “train_order_ticket”）',
          });
        }

        try {
          await withTimeout(conn.query(`USE \`${db.replace(/`/g, '')}\``), 6000, '切换数据库超时 (6s)');
          const [columns] = await withTimeout(
            conn.query(`SHOW FULL COLUMNS FROM \`${table.replace(/`/g, '')}\``),
            6000,
            '查询表结构超时 (6s)'
          );

          const columnDetails = (columns as Array<Record<string, unknown>>).map((c) => ({
            field: c.Field,
            type: c.Type,
            nullable: c.Null === 'YES',
            key: c.Key || '',
            default: c.Default,
            extra: c.Extra || '',
            comment: c.Comment || '',
          }));

          return JSON.stringify(
            {
              status: 'success',
              action: 'describe_table',
              database: db,
              tableName: table,
              queriedBy: user,
              totalColumns: columnDetails.length,
              columns: columnDetails,
            },
            null,
            2
          );
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return JSON.stringify({
            status: 'error',
            message: `查看表结构失败: ${errMsg}`,
            note: '请检查表名是否存在，可先调用 action: “list_tables” 或 “search_schema” 确认精确表名。',
          });
        }
      }

      case 'search_schema': {
        const rawKeyword = (args.keyword || '').trim();
        if (!rawKeyword) {
          return JSON.stringify({
            status: 'error',
            message: '缺少必填参数 keyword（如 keyword: “refund” 或 “hotel”，支持 “A OR B” / “a|b” / “a,b” 多关键词）',
          });
        }

        // Normalize LLM-supplied keyword into individual tokens.
        // Supports “A OR B”, “a|b|c”, “a,b,c”, and whitespace-separated lists.
        const keywords = normalizeKeywords(rawKeyword);
        if (keywords.length === 0) {
          return JSON.stringify({
            status: 'error',
            message: '无法从 keyword 中解析出有效关键词。',
          });
        }

        const [dbs] = await withTimeout(conn.query('SHOW DATABASES'), 6000, '查询数据库列表超时 (6s)');
        const dbList = (dbs as Array<Record<string, unknown>>).map((r) =>
          String(r.DATABASE || Object.values(r)[0])
        );

        const targetDbs = args.database?.trim() ? [args.database.trim()] : dbList;
        const matchedTables: Array<{ database: string; table: string; matchedKeyword: string }> = [];

        for (const db of targetDbs) {
          try {
            await withTimeout(conn.query(`USE \`${db.replace(/`/g, '')}\``), 4000, '选库超时');
            const [tables] = await withTimeout(conn.query('SHOW TABLES'), 4000, '读表超时');
            for (const t of tables as Array<Record<string, unknown>>) {
              const tableName = String(Object.values(t)[0]);
              const tableNameLower = tableName.toLowerCase();
              // A table matches if ANY of the normalized keywords is a substring.
              const hit = keywords.find((kw) => tableNameLower.includes(kw));
              if (hit) {
                matchedTables.push({ database: db, table: tableName, matchedKeyword: hit });
              }
            }
          } catch {
            // Ignore single db query error
          }
        }

        return JSON.stringify(
          {
            status: 'success',
            action: 'search_schema',
            keyword: rawKeyword,
            normalizedKeywords: keywords,
            queriedBy: user,
            totalMatches: matchedTables.length,
            matches: matchedTables.slice(0, 100),
            note: matchedTables.length === 0
              ? (() => {
                  const hasUserData = keywords.some(
                    (k) => /^\d{7,}$/.test(k) || /^[\u4e00-\u9fa5]{2,4}$/.test(k)
                  );
                  if (hasUserData) {
                    return '未匹配到表名。注意：输入的关键词看起来是具体业务数据（如手机号、订单号、姓名），search_schema 仅用于检索“数据库表名”（如 train_order、finance_bill）。请直接使用 action: “query”, database: “skt”, sql: “SELECT ... WHERE ...” 查询数据行！例如：SELECT * FROM skt.train_order_passenger WHERE phone = \'18053271039\'';
                  }
                  return '未匹配到任何表名。可尝试：1) 用更短/更通用的关键词（如 “order” 而非 “order_train_detail”）；2) 先 action: “list_databases” 查看可用库，再 action: “list_tables”, database: “<库名>” 浏览表清单。';
                })()
              : '可通过 action: “describe_table”, database: “<库名>”, tableName: “<表名>” 查看具体表结构及字段注释。',
          },
          null,
          2
        );
      }

      case 'query': {
        let rawSql = (args.sql || '').trim();

        // Parameter fallback: if LLM put the SQL or condition into keyword/tableName
        if (!rawSql && args.keyword?.trim()) {
          const kw = args.keyword.trim();
          if (/^(select|show|desc|explain)\b/i.test(kw)) {
            rawSql = kw;
          } else if (args.tableName?.trim()) {
            const condition = kw.replace(/^where\s+/i, '');
            rawSql = 'SELECT * FROM `' + args.tableName.trim() + '` WHERE ' + condition;
          } else if (/\b(from|where)\b/i.test(kw)) {
            rawSql = 'SELECT * ' + (kw.toLowerCase().startsWith('from') ? kw : 'FROM ' + kw);
          }
        }

        const sql = rawSql.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```$/i, '').trim();
        let db = args.database?.trim();

        if (!sql) {
          return JSON.stringify({
            status: 'error',
            message: '缺少必填参数 sql。必须传入完整的 SQL 查询语句（如 sql: “SELECT * FROM skt.train_order_passenger WHERE phone = \'18053271039\'”）。',
          });
        }

        // 1. Validate SQL
        const validation = validateReadOnlySql(sql);
        if (!validation.valid) {
          return JSON.stringify({
            status: 'security_violation',
            message: validation.reason,
            sql,
          });
        }

        if (!db) {
          const dbTableMatch = sql.match(/`?([a-zA-Z0-9_]+)`?\s*\.\s*`?([a-zA-Z0-9_]+)`?/);
          if (dbTableMatch) {
            const inferred = dbTableMatch[1];
            try {
              const [dbs] = await withTimeout(conn.query('SHOW DATABASES'), 4000, 'SHOW DATABASES 超时');
              const dbList = (dbs as Array<Record<string, unknown>>).map((r) =>
                String(r.DATABASE || Object.values(r)[0])
              );
              if (dbList.some((d) => d.toLowerCase() === inferred.toLowerCase())) {
                db = inferred;
              }
            } catch {
              // Fall through to the missing-database guidance below
            }
          }
        }

        if (!db) {
          // 运行时表名缓存自学推断（优先于默认库）：模型写裸表名时自动路由到历史成功过的库
          const cachedDb = inferDbFromCache(sql);
          if (cachedDb) {
            db = cachedDb;
          }
        }

        if (!db) {
          // Default to skt if omitted
          db = 'skt';
        }

        // 3. Select DB (validated above)
        await withTimeout(conn.query(`USE \`${db.replace(/`/g, '')}\``), 6000, '切换数据库超时 (6s)');

        // 4. Enforce Limit
        let finalSql = sql;
        const limitParam = Math.min(Math.max(Number(args.limit || 50), 1), 200);

        if (/^select\b/i.test(finalSql) && !/\blimit\s+\d+/i.test(finalSql)) {
          finalSql = `${finalSql} LIMIT ${limitParam}`;
        }

        try {
          const [rows] = await withTimeout(conn.query(finalSql), 10000, '数据库执行 SQL 超时 (10s)，请检查表名或添加索引条件');
          const rowsArray = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
          const sanitizedRows = rowsArray.map(sanitizeRow);

          // 成功后学习表名→库映射，供后续裸表名查询自动路由
          learnTableDbMappings(finalSql, db);

          return JSON.stringify(
            {
              status: 'success',
              action: 'query',
              database: db,
              queriedBy: user,
              executedSql: finalSql,
              rowCount: sanitizedRows.length,
              rows: sanitizedRows,
            },
            null,
            2
          );
        } catch (queryErr: unknown) {
          const qMsg = queryErr instanceof Error ? queryErr.message : String(queryErr);
          let hint = '';
          if (/no\s+\w*\s*database\s*selected|1146/i.test(qMsg)) {
            hint = '（提示：MyCat 要求先指定库，请确认 database 参数已正确传入，或 SQL 中使用 `库名.表名`）';
          } else if (/unknown\s+(table|column)|1146|1054/i.test(qMsg)) {
            hint = '（提示：表名/字段名可能不正确，建议先 action: “describe_table” 确认表结构，或 action: “search_schema” 重新定位真实表名）';
          }
          return JSON.stringify({
            status: 'error',
            message: `数据库查询异常: ${qMsg}${hint}`,
            database: db,
            executedSql: finalSql,
          });
        }
      }

      default:
        return JSON.stringify({
          status: 'error',
          message: `未知的 action: ${args.action}。可用选项: list_databases, list_tables, describe_table, search_schema, query`,
        });
        }
    })());

    // 查询成功则重置连续失败计数（通道恢复正常）
    try {
      const obj = JSON.parse(result);
      if (obj && obj.status === 'success') {
        consecutiveDbFailures = 0;
        (globalThis as any).__xkangDbFailures = 0;
      }
    } catch {}

    return result;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // 超时/连接被重置时，连接上可能仍挂着未完成的慢查询，必须销毁而非归还池子
    if (/超时|ECONNRESET|EPIPE|PROTOCOL_CONNECTION_LOST/i.test(errorMsg)) {
      hadTimeout = true;
    }
    consecutiveDbFailures++;
    (globalThis as any).__xkangDbFailures = consecutiveDbFailures;
    const message = /超时/i.test(errorMsg)
      ? `数据库查询异常: ${errorMsg}\n\n[慢查询防护引导] ${SLOW_QUERY_GUIDANCE}`
      : `数据库查询异常: ${errorMsg}`;
    const payload: Record<string, unknown> = { status: 'error', message };
    // 数据库通道连续异常时，主动引导切换排查通道，避免模型在同一通道反复撞墙耗尽轮次
    if (consecutiveDbFailures >= 3) {
      payload.nextStepHint =
        '数据库通道已连续多次异常（可能为慢查询拖垮连接或网络抖动）。请立即暂停数据库查询，改用 search_logs（keyword=单号 或 create_time 时间窗口）检索微服务运行日志、用 search_code 检索报错文案定位代码；获得线索后再恢复带索引条件的精确查库。';
    }
    return JSON.stringify(payload);
  } finally {
    if (conn) {
      if (hadTimeout) {
        try { (conn as any).destroy(); } catch { try { conn.release(); } catch {} }
      } else {
        try { conn.release(); } catch {}
      }
    }
  }
}
