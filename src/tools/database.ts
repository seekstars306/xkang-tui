import mysql from 'mysql2/promise';
import { HarnessContext, ToolDefinition } from '../types/index.js';

let dbPool: mysql.Pool | null = null;
// 连续失败计数（跨调用保留，用于识别数据库通道整体降级并引导切换排查通道）
let consecutiveDbFailures = 0;
// 运行时自学的「表名→库」映射缓存：MyCat 要求查询带库前缀或先 USE，
// 模型经常写裸表名导致 "No MyCAT Database selected"；成功执行过 db.table 后
// 记录映射，后续裸表名查询自动路由到正确库（纯运行时自适应，无业务硬编码）
const tableDbCache = new Map<string, string>();

function learnTableDbMappings(sql: string, usedDb: string): void {
  if (!usedDb) return;
  // 记录 schema-qualified 表：skt.skt_hotel_order -> skt_hotel_order => skt
  for (const m of sql.matchAll(/`?([a-zA-Z0-9_]+)`?\s*\.\s*`?([a-zA-Z0-9_]+)`?/g)) {
    if (m[1].toLowerCase() !== 'information_schema') {
      tableDbCache.set(m[2].toLowerCase(), m[1]);
    }
  }
  // 记录当前库下的裸表名：FROM skt_hotel_order (USE skt) -> skt_hotel_order => skt
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

function getDbPool(): mysql.Pool {
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
      enableKeepAlive: true,
    });
  }
  return dbPool;
}

// 超时等异常后连接上可能仍挂着未完成的慢查询，release 会把"中毒连接"还给池子拖垮后续所有查询，必须直接销毁
const SLOW_QUERY_GUIDANCE =
  '该查询已超时中断。若目标为日志/流水/历史记录类大表，请：1) 先用 SHOW INDEX FROM 表名 确认索引列，改用索引列等值查询（如 WHERE order_id = 单号）；2) 或增加 create_time 窄时间窗口（±1天内）与用户名等过滤条件；3) 严禁对大表执行无时间边界的 LIKE %关键词% 全表扫描，也不要原样重试同一查询形态。';

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
  /\bset\b/i,
  /\binto\s+outfile\b/i,
  /\binto\s+dumpfile\b/i,
  /\bload_file\b/i,
  /\bload\s+data\b/i,
];

function validateReadOnlySql(sql: string): { valid: boolean; reason?: string } {
  const trimmed = sql.trim().replace(/^;+|;+$/g, '').trim();

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

export const queryDatabaseTool: ToolDefinition = {
  name: 'query_company_database',
  description: '查询公司内部只读数据库（MyCat / MySQL），支持查看数据库列表、数据表列表、表字段结构与注释、跨库搜索表名以及执行只读 SELECT/SHOW 查询',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list_databases', 'list_tables', 'describe_table', 'search_schema', 'query'],
        description: '操作类型：list_databases(查看库清单), list_tables(查看某库表清单), describe_table(查看表结构及字段注释), search_schema(按关键词跨库搜表名), query(执行只读SQL)',
      },
      database: {
        type: 'string',
        description: '目标数据库名称（如 "payment", "skt", "myibe", "skt_project_hotel", "transfer"）',
      },
      tableName: {
        type: 'string',
        description: '表名（当 action 为 describe_table 时必填，如 "payment_flow"）',
      },
      keyword: {
        type: 'string',
        description: '搜索关键字（用于 search_schema 搜表或 list_tables 过滤表名）',
      },
      sql: {
        type: 'string',
        description: '只读 SQL 查询语句（当 action 为 query 时使用，仅支持 SELECT/SHOW，自动附加 LIMIT）',
      },
      limit: {
        type: 'number',
        description: 'SQL 查询返回的最大行数限制（默认 50，最大 200）',
      },
    },
    required: ['action'],
  },
  execute: async (args: Record<string, unknown>, _context: HarnessContext) => {
    const pool = getDbPool();
    let conn: mysql.PoolConnection | null = null;
    let hadTimeout = false;

    try {
      conn = await withTimeout(pool.getConnection(), 6000, '获取数据库连接超时 (6s)');
      const action = String(args.action || 'list_databases');

      const result = await (async (): Promise<string> => { switch (action) {
        case 'list_databases': {
          const [rows] = await withTimeout(conn.query('SHOW DATABASES'), 6000, '查询数据库清单超时 (6s)');
          const dbList = (rows as Array<Record<string, unknown>>).map(
            (r) => String(r.DATABASE || Object.values(r)[0])
          );

          return JSON.stringify(
            {
              status: 'success',
              action: 'list_databases',
              totalDatabases: dbList.length,
              databases: dbList,
              note: '使用 action: "list_tables", database: "<库名>" 查看各库内的数据表。',
            },
            null,
            2
          );
        }

        case 'list_tables': {
          const db = args.database ? String(args.database).trim() : '';
          if (!db) {
            return JSON.stringify({
              status: 'error',
              message: '缺少必填参数 database（请指定要查看的数据库名称，如 "payment" 或 "skt"）',
            });
          }

          await withTimeout(conn.query(`USE \`${db.replace(/`/g, '')}\``), 6000, '切换数据库超时 (6s)');
          const [tables] = await withTimeout(conn.query('SHOW TABLES'), 6000, '查询数据表清单超时 (6s)');
          let tableList = (tables as Array<Record<string, unknown>>).map(
            (t) => String(Object.values(t)[0])
          );

          if (args.keyword) {
            const kw = String(args.keyword).trim().toLowerCase();
            tableList = tableList.filter((t) => t.toLowerCase().includes(kw));
          }

          return JSON.stringify(
            {
              status: 'success',
              action: 'list_tables',
              database: db,
              matchedCount: tableList.length,
              tables: tableList.slice(0, 200),
              isTruncated: tableList.length > 200,
              note: `可通过 action: "describe_table", database: "${db}", tableName: "<表名>" 查看表字段结构。`,
            },
            null,
            2
          );
        }

        case 'describe_table': {
          const db = args.database ? String(args.database).trim() : '';
          const table = args.tableName ? String(args.tableName).trim() : '';
          if (!db || !table) {
            return JSON.stringify({
              status: 'error',
              message: '缺少必填参数 database 或 tableName（如 database: "payment", tableName: "payment_flow"）',
            });
          }

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
              totalColumns: columnDetails.length,
              columns: columnDetails,
            },
            null,
            2
          );
        }

        case 'search_schema': {
          const keyword = args.keyword ? String(args.keyword).trim().toLowerCase() : '';
          if (!keyword) {
            return JSON.stringify({
              status: 'error',
              message: '缺少必填参数 keyword（如 keyword: "refund" 或 "hotel"）',
            });
          }

          const [dbs] = await withTimeout(conn.query('SHOW DATABASES'), 6000, '查询数据库列表超时 (6s)');
          const dbList = (dbs as Array<Record<string, unknown>>).map((r) =>
            String(r.DATABASE || Object.values(r)[0])
          );

          const targetDbs = args.database ? [String(args.database).trim()] : dbList;
          const matchedTables: Array<{ database: string; table: string }> = [];

          for (const db of targetDbs) {
            try {
              await withTimeout(conn.query(`USE \`${db.replace(/`/g, '')}\``), 4000, '选库超时');
              const [tables] = await withTimeout(conn.query('SHOW TABLES'), 4000, '读表超时');
              for (const t of tables as Array<Record<string, unknown>>) {
                const tableName = String(Object.values(t)[0]);
                if (tableName.toLowerCase().includes(keyword)) {
                  matchedTables.push({ database: db, table: tableName });
                }
              }
            } catch {
              // Ignore individual database failure
            }
          }

          return JSON.stringify(
            {
              status: 'success',
              action: 'search_schema',
              keyword,
              totalMatches: matchedTables.length,
              matches: matchedTables.slice(0, 100),
            },
            null,
            2
          );
        }

        case 'query': {
          const sql = args.sql ? String(args.sql).trim() : '';
          let db = args.database ? String(args.database).trim() : '';

          if (!sql) {
            return JSON.stringify({
              status: 'error',
              message: '缺少必填参数 sql（需要执行的只读 SQL 查询）',
            });
          }

          const validation = validateReadOnlySql(sql);
          if (!validation.valid) {
            return JSON.stringify({
              status: 'security_violation',
              message: validation.reason,
              sql,
            });
          }

          // 库路由：显式指定 > SQL 内 db.table 前缀 > 运行时表名缓存自学推断
          if (!db) {
            const cachedDb = inferDbFromCache(sql);
            if (cachedDb) db = cachedDb;
          }

          if (db) {
            await withTimeout(conn.query(`USE \`${db.replace(/`/g, '')}\``), 6000, '切换数据库超时 (6s)');
          }

          let finalSql = sql;
          const limitParam = Math.min(Math.max(Number(args.limit || 50), 1), 200);

          if (/^select\b/i.test(finalSql) && !/\blimit\s+\d+/i.test(finalSql)) {
            finalSql = `${finalSql} LIMIT ${limitParam}`;
          }

          const [rows] = await withTimeout(conn.query(finalSql), 10000, '数据库执行 SQL 超时 (10s)，请检查表名或增加条件');
          const rowsArray = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
          const sanitizedRows = rowsArray.map(sanitizeRow);

          // 成功后学习表名→库映射，供后续裸表名查询自动路由
          learnTableDbMappings(finalSql, db);

          return JSON.stringify(
            {
              status: 'success',
              action: 'query',
              database: db || 'default',
              executedSql: finalSql,
              rowCount: sanitizedRows.length,
              rows: sanitizedRows,
            },
            null,
            2
          );
        }

        default:
          return JSON.stringify({
            status: 'error',
            message: `未知的 action: ${args.action}。可用选项: list_databases, list_tables, describe_table, search_schema, query`,
          });
      } })();

      // 查询成功则重置连续失败计数（通道恢复正常）
      try {
        const obj = JSON.parse(result);
        if (obj && obj.status === 'success') consecutiveDbFailures = 0;
      } catch {}

      return result;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // 超时/连接被重置时，连接上可能仍挂着未完成的慢查询，必须销毁而非归还池子
      if (/超时|ECONNRESET|EPIPE|PROTOCOL_CONNECTION_LOST/i.test(errorMsg)) {
        hadTimeout = true;
      }
      consecutiveDbFailures++;
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
  },
};
