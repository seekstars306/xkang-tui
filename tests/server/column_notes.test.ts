import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Duplex } from 'node:stream';
import {
  isCodeMappingComment,
  truncateNote,
  resolveColumnSources,
  buildColumnNotes,
  createColumnCommentCache,
  COLUMN_NOTE_MAX_CHARS,
} from '../../server/src/tools/column_notes.ts';
import {
  executeDatabaseTool,
  formatRowsResult,
  validateReadOnlySql,
  createColumnCommentsLookup,
  COLUMN_COMMENT_SQL,
  type QueryContext,
  type DatabaseToolDeps,
} from '../../server/src/tools/database.ts';

// ---------------------------------------------------------------------------
// 测试数据：假的 information_schema.COLUMNS 内容与字段元数据（与 mysql2 ColumnDefinition 同形）
// ---------------------------------------------------------------------------

const COMMENTS: Record<string, Record<string, string>> = {
  'skt.skt_hotel_order': {
    order_no: '订单号',
    carrier: '承运商：1001携程,1002华住,1003锦江',
    order_come: '订单来源 1:H5 2:APP 3:PC',
    source: '渠道 1官网 2小程序 6畅联',
    remark_flag: '是否备注 0否1是',
    create_time: '创建时间',
    status: '酒店单状态 0待确认 1已确认 2已取消',
  },
  'skt.order': {
    status: '订单状态 0待支付 1已支付 2已取消',
  },
};

function commentsOf(schema: string, table: string): Map<string, string> {
  return new Map(Object.entries(COMMENTS[`${schema}.${table}`] ?? {}));
}

interface Source {
  schema: string;
  table: string;
  column: string;
  alias?: string;
}

const hotel = (column: string, alias = 'h'): Source => ({ schema: 'skt', table: 'skt_hotel_order', column, alias });
const order = (column: string, alias = 'o'): Source => ({ schema: 'skt', table: 'order', column, alias });

/** 字段元数据：name 是结果列名；schema/db、orgTable、orgName 是来源；table 是 SQL 里的别名（不应被使用） */
function field(name: string, source?: Source) {
  return source
    ? { name, schema: source.schema, db: source.schema, table: source.alias ?? source.table, orgTable: source.table, orgName: source.column }
    : { name, schema: '', db: '', table: '', orgTable: '', orgName: '' };
}

// ---------------------------------------------------------------------------
// 编码映射判定
// ---------------------------------------------------------------------------

describe('isCodeMappingComment：只认「数字代码 + 含义」的枚举', () => {
  test('正例：多项枚举（各种分隔写法、代码在前或含义在前）与带明确分隔符的单项', () => {
    const positives = [
      '承运商：1001携程,1002华住,1003锦江',
      '1:H5 2:APP 3:PC',
      '0否1是',
      '渠道 1官网 2小程序 6畅联',
      '状态(0:待支付,1:已支付,2:已取消)',
      '是否删除：0-否 1-是',
      '支付方式: 1.微信 2.支付宝',
      '-1:已删除 0:正常',
      '类型 1=国内;2=国际',
      '1已支付(待出票) 2已取消',
      '待审核(0),已通过(1),已驳回(2)',
      '订单状态 10待支付 20已支付 30已出票 40已取消',
      'status 0 disabled 1 enabled',
      '结算周期 1:天 2:周 3:月',
      '1日结 2月结 3周结',
      '平台 1:H5',
      '默认 0：关闭',
    ];
    for (const comment of positives) assert.equal(isCodeMappingComment(comment), true, comment);
  });

  test('反例：说明型注释、数量/日期/版本/格式说明、孤立的「数字+文字」', () => {
    const negatives = [
      '订单号',
      '创建时间',
      '12306订单号',
      '身份证号18位',
      '金额，保留2位小数',
      '最近30天订单数',
      'MD5签名',
      'base64编码的图片',
      '2019年12月新增字段',
      '重试间隔：10秒、30秒、60秒',
      '格式 2020-01-01 12:00:00',
      'IP 192.168.1.1',
      '超时时间(单位:秒)，默认30秒',
      '版本号 v2',
      '取值范围 0-100',
      '比例 1:N',
      '每天9点到18点',
      '共10页，每页20条',
      '满200减30,满500减100',
      '2023年5月1日起生效',
      '1002华住',
    ];
    for (const comment of negatives) assert.equal(isCodeMappingComment(comment), false, comment);
  });

  test('空值与非字符串不算', () => {
    for (const value of ['', '   ', null, undefined, 1002, {}]) assert.equal(isCodeMappingComment(value), false, String(value));
  });
});

describe('truncateNote', () => {
  test('超过上限截断并以省略号结尾，按字符计不会截坏汉字', () => {
    const long = '状态 ' + Array.from({ length: 120 }, (_, i) => `${i}含义${i}`).join(',');
    const note = truncateNote(long);
    assert.equal(Array.from(note).length, COLUMN_NOTE_MAX_CHARS + 1);
    assert.ok(note.endsWith('…'));
    assert.equal(truncateNote('  0否1是  '), '0否1是');
  });
});

// ---------------------------------------------------------------------------
// 字段元数据 → 来源
// ---------------------------------------------------------------------------

describe('resolveColumnSources：只认驱动字段元数据，不解析 SQL', () => {
  test('别名列归到原表原列（用 orgTable/orgName，而不是 SQL 别名）', () => {
    const sources = resolveColumnSources([field('come', hotel('order_come'))]);
    assert.deepEqual(sources.get('come'), { schema: 'skt', table: 'skt_hotel_order', column: 'order_come' });
  });

  test('表达式列、缺 schema/orgTable/orgName 的列没有来源', () => {
    const sources = resolveColumnSources([
      field('carrier_text'),
      { name: 'a', schema: 'skt', orgTable: '', orgName: 'a' },
      { name: 'b', schema: '', db: '', orgTable: 't', orgName: 'b' },
      { name: 'c', schema: 'skt', orgTable: 't' },
    ]);
    for (const name of ['carrier_text', 'a', 'b', 'c']) assert.equal(sources.get(name), null, name);
  });

  test('同名结果列来源不一致（JOIN 两表都有 status）时无法归属；来源一致时保留', () => {
    const sources = resolveColumnSources([field('status', order('status')), field('status', hotel('status')), field('carrier', hotel('carrier')), field('carrier', hotel('carrier'))]);
    assert.equal(sources.get('status'), null);
    assert.deepEqual(sources.get('carrier'), { schema: 'skt', table: 'skt_hotel_order', column: 'carrier' });
  });

  test('schema 缺失时用 db；能读原型上的惰性 getter（mysql2 ColumnDefinition 的形态）', () => {
    class LazyField {
      name: string;
      constructor(name: string) {
        this.name = name;
      }
      get schema() {
        return 'skt';
      }
      get orgTable() {
        return 'skt_hotel_order';
      }
      get orgName() {
        return 'carrier';
      }
    }
    const sources = resolveColumnSources([new LazyField('carrier'), { name: 'x', db: 'skt', orgTable: 't', orgName: 'x' }]);
    assert.deepEqual(sources.get('carrier'), { schema: 'skt', table: 'skt_hotel_order', column: 'carrier' });
    assert.deepEqual(sources.get('x'), { schema: 'skt', table: 't', column: 'x' });
  });

  test('不是数组时返回空', () => {
    assert.equal(resolveColumnSources(undefined).size, 0);
    assert.equal(resolveColumnSources({}).size, 0);
  });
});

// ---------------------------------------------------------------------------
// 由（返回列、字段元数据、注释查询）构造 columnNotes
// ---------------------------------------------------------------------------

describe('buildColumnNotes', () => {
  const lookupFrom = (calls: string[] = []) => async (schema: string, table: string) => {
    calls.push(`${schema}.${table}`);
    return commentsOf(schema, table);
  };

  test('只注编码型列：说明型注释与没有注释的列不注，注释原文原样附上，同一张表只查一次', async () => {
    const calls: string[] = [];
    const notes = await buildColumnNotes({
      columns: ['order_no', 'carrier', 'source', 'create_time', 'no_comment'],
      fields: [
        field('order_no', hotel('order_no')),
        field('carrier', hotel('carrier')),
        field('source', hotel('source')),
        field('create_time', hotel('create_time')),
        field('no_comment', hotel('no_comment')),
      ],
      lookupComments: lookupFrom(calls),
    });
    assert.deepEqual(notes, { carrier: '承运商：1001携程,1002华住,1003锦江', source: '渠道 1官网 2小程序 6畅联' });
    assert.deepEqual(calls, ['skt.skt_hotel_order']);
  });

  test('元数据缺失时不注：没有字段元数据、表达式列、缺 orgTable 都不注，也不去查注释', async () => {
    for (const fields of [undefined, null, [], 'x', [field('carrier')], [{ name: 'carrier', schema: 'skt', orgName: 'carrier' }]]) {
      const calls: string[] = [];
      const notes = await buildColumnNotes({ columns: ['carrier'], fields, lookupComments: lookupFrom(calls) });
      assert.equal(notes, undefined, JSON.stringify(fields));
      assert.deepEqual(calls, [], JSON.stringify(fields));
    }
  });

  test('注释查询抛错时不注且不抛；能查到的其他表照常注', async () => {
    const throwing = async () => {
      throw new Error("SELECT command denied to user 'u'@'%' for table 'COLUMNS'");
    };
    const notes = await buildColumnNotes({ columns: ['carrier'], fields: [field('carrier', hotel('carrier'))], lookupComments: throwing });
    assert.equal(notes, undefined);

    const partlyFailing = async (schema: string, table: string) => {
      if (table === 'order') throw new Error('timeout');
      return commentsOf(schema, table);
    };
    const mixed = await buildColumnNotes({
      columns: ['order_status', 'carrier'],
      fields: [field('order_status', order('status')), field('carrier', hotel('carrier'))],
      lookupComments: partlyFailing,
    });
    assert.deepEqual(mixed, { carrier: '承运商：1001携程,1002华住,1003锦江' });

    for (const bad of [async () => null, async () => undefined, async () => 'not a map' as unknown as Map<string, string>]) {
      assert.equal(await buildColumnNotes({ columns: ['carrier'], fields: [field('carrier', hotel('carrier'))], lookupComments: bad }), undefined);
    }
  });

  test('不注全空列；某表只剩全空列需要注释时不去查该表', async () => {
    const calls: string[] = [];
    const notes = await buildColumnNotes({
      columns: ['carrier', 'remark_flag', 'order_status'],
      allNullColumns: ['remark_flag', 'order_status'],
      fields: [field('carrier', hotel('carrier')), field('remark_flag', hotel('remark_flag')), field('order_status', order('status'))],
      lookupComments: lookupFrom(calls),
    });
    assert.deepEqual(notes, { carrier: '承运商：1001携程,1002华住,1003锦江' });
    assert.deepEqual(calls, ['skt.skt_hotel_order']);
  });

  test('同名列来源不一致时不注；别名列按元数据注到结果列名上', async () => {
    const notes = await buildColumnNotes({
      columns: ['status', 'come'],
      fields: [field('status', order('status')), field('status', hotel('status')), field('come', hotel('order_come'))],
      lookupComments: lookupFrom(),
    });
    assert.deepEqual(notes, { come: '订单来源 1:H5 2:APP 3:PC' });
  });

  test('列名大小写不敏感地匹配注释；系统库的列不查注释', async () => {
    const calls: string[] = [];
    const notes = await buildColumnNotes({
      columns: ['CARRIER', 'TABLE_TYPE'],
      fields: [
        { name: 'CARRIER', schema: 'skt', orgTable: 'skt_hotel_order', orgName: 'CARRIER' },
        { name: 'TABLE_TYPE', schema: 'information_schema', orgTable: 'TABLES', orgName: 'TABLE_TYPE' },
      ],
      lookupComments: lookupFrom(calls),
    });
    assert.deepEqual(notes, { CARRIER: '承运商：1001携程,1002华住,1003锦江' });
    assert.deepEqual(calls, ['skt.skt_hotel_order']);
  });

  test('单条注释截断到约 200 字；总长度超过上限时后面的列不再附', async () => {
    const longComment = '状态 ' + Array.from({ length: 120 }, (_, i) => `${i}状态${String.fromCharCode(0x4e00 + i)}`).join(',');
    assert.equal(isCodeMappingComment(longComment), true);
    const lookup = async () => new Map([['a', longComment], ['b', '0否1是'], ['c', '1:H5 2:APP']]);
    const fields = ['a', 'b', 'c'].map((c) => ({ name: c, schema: 'skt', orgTable: 't', orgName: c }));
    const notes = await buildColumnNotes({ columns: ['a', 'b', 'c'], fields, lookupComments: lookup });
    assert.equal(Array.from(notes!.a).length, COLUMN_NOTE_MAX_CHARS + 1);
    assert.ok(notes!.a.endsWith('…'));
    const capped = await buildColumnNotes({ columns: ['a', 'b', 'c'], fields, lookupComments: lookup, maxTotalChars: 210 });
    assert.deepEqual(Object.keys(capped!), ['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// 按表缓存
// ---------------------------------------------------------------------------

describe('createColumnCommentCache', () => {
  test('TTL 内命中不重复查，过期后重新查', async () => {
    let now = 0;
    const cache = createColumnCommentCache({ ttlMs: 1000, now: () => now });
    let loads = 0;
    const load = async () => {
      loads++;
      return new Map([['carrier', '0否1是']]);
    };
    assert.equal((await cache.get('skt', 't', load))?.get('carrier'), '0否1是');
    now = 999;
    await cache.get('skt', 't', load);
    assert.equal(loads, 1);
    assert.deepEqual(cache.peek('skt', 't'), { hit: true, comments: new Map([['carrier', '0否1是']]) });
    now = 1000;
    assert.deepEqual(cache.peek('skt', 't'), { hit: false });
    await cache.get('skt', 't', load);
    assert.equal(loads, 2);
  });

  test('查询失败不外抛、返回 null，并在失败冷却期内不再重查', async () => {
    let now = 0;
    const cache = createColumnCommentCache({ ttlMs: 60_000, failureTtlMs: 100, now: () => now });
    let loads = 0;
    const failing = async (): Promise<Map<string, string>> => {
      loads++;
      throw new Error('timeout');
    };
    assert.equal(await cache.get('skt', 't', failing), null);
    assert.equal(await cache.get('skt', 't', failing), null);
    assert.equal(loads, 1);
    now = 100;
    assert.equal(await cache.get('skt', 't', failing), null);
    assert.equal(loads, 2);
  });

  test('超过表数上限时淘汰最早写入的表', async () => {
    const cache = createColumnCommentCache({ maxTables: 2 });
    for (const t of ['a', 'b', 'c']) await cache.get('skt', t, async () => new Map());
    assert.equal(cache.size, 2);
    assert.deepEqual(cache.peek('skt', 'a'), { hit: false });
    assert.equal(cache.peek('skt', 'c').hit, true);
  });
});

// ---------------------------------------------------------------------------
// formatRowsResult 输出 columnNotes
// ---------------------------------------------------------------------------

describe('formatRowsResult 的 columnNotes', () => {
  const base = { database: 'skt', executedSql: 'x', limit: 50, probeLimit: 50, userLimit: null };

  test('只输出本次返回且不是全空的列的注释；不传时没有该字段，原有字段不变', () => {
    const rows = [{ order_no: 'H1', carrier: '1002', remark_flag: null }];
    const withNotes = JSON.parse(
      formatRowsResult({ ...base, rows, columnNotes: { carrier: '承运商：1002华住', remark_flag: '0否1是', not_returned: '1:H5' } })
    );
    assert.deepEqual(withNotes.columnNotes, { carrier: '承运商：1002华住' });
    const plain = JSON.parse(formatRowsResult({ ...base, rows }));
    assert.equal('columnNotes' in plain, false);
    const { columnNotes: _notes, ...rest } = withNotes;
    assert.deepEqual(rest, plain);
    assert.equal('columnNotes' in JSON.parse(formatRowsResult({ ...base, rows, columnNotes: { remark_flag: '0否1是' } })), false);
  });

  test('带注释时仍遵守输出预算；带上注释连一行都放不下时去掉注释，而不是超出预算', () => {
    const wide = Array.from({ length: 20 }, (_, i) => ({ id: String(i), memo: 'x'.repeat(280), flag: '1' }));
    const note = '标记 ' + Array.from({ length: 40 }, (_, i) => `${i}含义`).join(',');
    const trimmed = formatRowsResult({ ...base, rows: wide, budget: 3000, columnNotes: { flag: note } });
    assert.ok(trimmed.length <= 3000);
    const out = JSON.parse(trimmed);
    assert.equal(out.columnNotes.flag, note);
    assert.equal(out.complete, false);
    assert.ok(out.rowCount < 20);

    const single = [{ id: '1', memo: 'x'.repeat(280), flag: '1' }];
    const plainLength = formatRowsResult({ ...base, rows: single }).length;
    const tight = formatRowsResult({ ...base, rows: single, budget: plainLength + 10, columnNotes: { flag: note } });
    assert.ok(tight.length <= plainLength + 10);
    assert.equal('columnNotes' in JSON.parse(tight), false);
  });
});

// ---------------------------------------------------------------------------
// 查询结果拼装：注入假执行器 / 假注释查询，走 executeDatabaseTool 的完整 query 流程
// ---------------------------------------------------------------------------

const HANG = Symbol('hang');
type Responder = (sql: string, values?: unknown[]) => unknown;

interface FakeDb {
  deps: Partial<DatabaseToolDeps>;
  executed: Array<{ sql: string; values?: unknown[] }>;
  /** 本次连接是否被标记为销毁（不还回连接池） */
  discarded: () => boolean;
}

function fakeDb(respond: Responder, deps: Partial<DatabaseToolDeps> = {}): FakeDb {
  const executed: Array<{ sql: string; values?: unknown[] }> = [];
  let discarded = false;
  const conn = {
    query: async (sql: string, values?: unknown[]) => {
      executed.push(values ? { sql, values } : { sql });
      const result = respond(sql, values);
      if (result === HANG) return new Promise(() => {});
      return result;
    },
  };
  const withConnection = async <T>(fn: (ctx: QueryContext) => Promise<T>): Promise<T> => {
    const ctx: QueryContext = { conn: conn as unknown as QueryContext['conn'], timedOut: false };
    try {
      return await fn(ctx);
    } finally {
      discarded = ctx.timedOut;
    }
  };
  return {
    deps: { isConfigured: () => true, withConnection, lookupColumnComments: createColumnCommentsLookup(createColumnCommentCache()), ...deps },
    executed,
    discarded: () => discarded,
  };
}

/** 假库：SHOW DATABASES / USE / 列注释查询按真实形态应答，业务 SQL 交给 userResult */
function responder(userResult: (sql: string) => unknown, onComments?: (schema: string, table: string) => unknown): Responder {
  return (sql, values) => {
    if (/^SHOW DATABASES$/i.test(sql)) return [[{ Database: 'skt' }, { Database: 'payment' }], []];
    if (/^USE /i.test(sql)) return [{ affectedRows: 0 }, undefined];
    if (sql === COLUMN_COMMENT_SQL) {
      const [schema, table] = values as [string, string];
      if (onComments) return onComments(schema, table);
      return [[...commentsOf(schema, table)].map(([col_name, col_comment]) => ({ col_name, col_comment })), []];
    }
    const result = userResult(sql);
    if (result === undefined) throw new Error(`unexpected SQL: ${sql}`);
    return result;
  };
}

const HOTEL_SQL =
  "SELECT h.order_no, h.carrier, h.order_come AS come, h.remark_flag, h.create_time, CONCAT(h.carrier, '') AS carrier_text FROM skt.skt_hotel_order h WHERE h.order_no = 'H1'";
const HOTEL_FIELDS = [
  field('order_no', hotel('order_no')),
  field('carrier', hotel('carrier')),
  field('come', hotel('order_come')),
  field('remark_flag', hotel('remark_flag')),
  field('create_time', hotel('create_time')),
  field('carrier_text'),
];
const HOTEL_ROWS = [{ order_no: 'H1', carrier: '1002', come: '1', remark_flag: null, create_time: '2026-10-01 10:00:00', carrier_text: '1002' }];
const hotelResult = (fields: unknown) => (sql: string) => (sql.startsWith('SELECT h.order_no') ? [HOTEL_ROWS, fields] : undefined);
const runQueryTool = async (db: FakeDb, sql = HOTEL_SQL) => JSON.parse(await executeDatabaseTool({ action: 'query', sql }, {} as any, 'tester', db.deps));
const commentLookups = (db: FakeDb) => db.executed.filter((e) => e.sql === COLUMN_COMMENT_SQL);

describe('query 结果拼装（注入假执行器）', () => {
  test('结果 JSON 带 columnNotes：只含编码型、来源可靠、非全空的返回列；原有字段含义与格式不变', async () => {
    const db = fakeDb(responder(hotelResult(HOTEL_FIELDS)));
    const out = await runQueryTool(db);
    assert.equal(out.status, 'success');
    assert.deepEqual(out.columnNotes, { carrier: '承运商：1001携程,1002华住,1003锦江', come: '订单来源 1:H5 2:APP 3:PC' });
    assert.deepEqual(out.columns, ['order_no', 'carrier', 'come', 'create_time', 'carrier_text']);
    assert.deepEqual(out.allNullColumns, ['remark_flag']);
    assert.deepEqual(out.rows, [['H1', '1002', '1', '2026-10-01 10:00:00', '1002']]);
    assert.equal(out.rowCount, 1);
    assert.equal(out.complete, true);
    assert.equal(out.executedSql, `${HOTEL_SQL} LIMIT 51`);
    // 注释查询：只读、参数化，按元数据里的真实库表（不是 SQL 别名 h）
    const lookups = commentLookups(db);
    assert.deepEqual(lookups.map((e) => e.values), [['skt', 'skt_hotel_order']]);
    assert.equal(validateReadOnlySql(lookups[0].sql).valid, true);
    // 用户 SQL 只执行一次，注释逻辑不会重跑或改写它
    assert.equal(db.executed.filter((e) => e.sql === `${HOTEL_SQL} LIMIT 51`).length, 1);
    assert.equal(db.discarded(), false);
  });

  test('注入假的注释查询函数时同样生效，且拿到的是元数据里的 (库, 表)', async () => {
    const calls: string[] = [];
    const db = fakeDb(responder(hotelResult(HOTEL_FIELDS)), {
      lookupColumnComments: async (_ctx, schema, table, timeoutMs) => {
        calls.push(`${schema}.${table}`);
        assert.ok(timeoutMs > 0);
        return commentsOf(schema, table);
      },
    });
    const out = await runQueryTool(db);
    assert.deepEqual(out.columnNotes, { carrier: '承运商：1001携程,1002华住,1003锦江', come: '订单来源 1:H5 2:APP 3:PC' });
    assert.deepEqual(calls, ['skt.skt_hotel_order']);
  });

  test('驱动没给字段元数据时不注，也不去查注释', async () => {
    for (const fields of [undefined, []]) {
      const db = fakeDb(responder(hotelResult(fields)));
      const out = await runQueryTool(db);
      assert.equal(out.status, 'success');
      assert.equal('columnNotes' in out, false);
      assert.deepEqual(out.rows, [['H1', '1002', '1', '2026-10-01 10:00:00', '1002']]);
      assert.equal(commentLookups(db).length, 0);
    }
  });

  test('注释查询报错（如无权限）时查询照常成功、不附注释，且短时间内不再重查', async () => {
    const db = fakeDb(
      responder(hotelResult(HOTEL_FIELDS), () => {
        throw new Error("SELECT command denied to user 'u'@'%' for table 'COLUMNS'");
      })
    );
    const out = await runQueryTool(db);
    assert.equal(out.status, 'success');
    assert.equal('columnNotes' in out, false);
    assert.deepEqual(out.columns, ['order_no', 'carrier', 'come', 'create_time', 'carrier_text']);
    assert.equal(db.discarded(), false);
    await runQueryTool(db);
    assert.equal(commentLookups(db).length, 1);
  });

  test('注释查询卡住时在时间预算内返回、不附注释，并把连接标记为销毁', async () => {
    const db = fakeDb(responder(hotelResult(HOTEL_FIELDS), () => HANG), { columnNotesBudgetMs: 60 });
    const started = Date.now();
    const out = await runQueryTool(db);
    assert.ok(Date.now() - started < 1500, `耗时 ${Date.now() - started}ms`);
    assert.equal(out.status, 'success');
    assert.equal('columnNotes' in out, false);
    assert.deepEqual(out.rows, [['H1', '1002', '1', '2026-10-01 10:00:00', '1002']]);
    assert.equal(db.discarded(), true);
  });

  test('注入的注释查询不理会超时时，整体限时兜底', async () => {
    const db = fakeDb(responder(hotelResult(HOTEL_FIELDS)), { columnNotesBudgetMs: 50, lookupColumnComments: () => new Promise(() => {}) });
    const started = Date.now();
    const out = await runQueryTool(db);
    assert.ok(Date.now() - started < 1500, `耗时 ${Date.now() - started}ms`);
    assert.equal(out.status, 'success');
    assert.equal('columnNotes' in out, false);
    assert.equal(db.discarded(), true);
  });

  test('JOIN 两表同名列不注，别名列按元数据注；同一张表的注释在进程内缓存', async () => {
    const sql = 'SELECT o.status, h.status, h.carrier AS hotel_carrier FROM skt.order o JOIN skt.skt_hotel_order h ON h.order_id = o.id WHERE o.id = 7';
    const fields = [field('status', order('status')), field('status', hotel('status')), field('hotel_carrier', hotel('carrier'))];
    const db = fakeDb(responder((s) => (s.startsWith('SELECT o.status') ? [[{ status: '1', hotel_carrier: '1002' }], fields] : undefined)));
    const first = await runQueryTool(db, sql);
    assert.deepEqual(first.columnNotes, { hotel_carrier: '承运商：1001携程,1002华住,1003锦江' });
    const second = await runQueryTool(db, sql);
    assert.deepEqual(second.columnNotes, first.columnNotes);
    assert.deepEqual(commentLookups(db).map((e) => e.values), [['skt', 'skt_hotel_order']]);
  });

  test('只给普通 SELECT 附注释：SHOW 与 UNION 不查注释（字符串里的 union 不受影响）', async () => {
    const carrierFields = [field('carrier', hotel('carrier'))];
    const result = [[{ carrier: '1002' }], carrierFields];
    for (const sql of ['SHOW COLUMNS FROM skt.skt_hotel_order', 'SELECT carrier FROM skt.skt_hotel_order WHERE id = 1 UNION SELECT carrier FROM skt.skt_hotel_order WHERE id = 2']) {
      const db = fakeDb(responder(() => result));
      const out = await runQueryTool(db, sql);
      assert.equal(out.status, 'success', sql);
      assert.equal('columnNotes' in out, false, sql);
      assert.equal(commentLookups(db).length, 0, sql);
    }
    const db = fakeDb(responder(() => result));
    const out = await runQueryTool(db, "SELECT carrier FROM skt.skt_hotel_order WHERE remark = 'union pay'");
    assert.deepEqual(out.columnNotes, { carrier: '承运商：1001携程,1002华住,1003锦江' });
  });

  test('只读校验不受影响：写语句照旧拦截，一条 SQL 都不执行', async () => {
    const db = fakeDb(responder(() => [[], []]));
    const out = await runQueryTool(db, 'DELETE FROM skt.skt_hotel_order WHERE id = 1');
    assert.equal(out.status, 'security_violation');
    assert.deepEqual(db.executed, []);
  });

  test('注释查询语句本身是只读、参数化的 information_schema 查询', () => {
    assert.equal(validateReadOnlySql(COLUMN_COMMENT_SQL).valid, true);
    assert.match(COLUMN_COMMENT_SQL, /^SELECT\b/);
    assert.match(COLUMN_COMMENT_SQL, /FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = \? AND TABLE_NAME = \?/);
    assert.equal((COLUMN_COMMENT_SQL.match(/\?/g) || []).length, 2);
  });
});

// ---------------------------------------------------------------------------
// 真实 mysql2 驱动（服务端实际依赖的 server/node_modules/mysql2）+ 内存假服务端：不连真实库、不占端口
// ---------------------------------------------------------------------------

/** 内存中的一对双工流：写入的数据在下一轮事件循环才送达对端（与真实 socket 一样是异步的） */
function asyncPipePair(): [Duplex, Duplex] {
  const sides: Duplex[] = [];
  const ended = [false, false];
  const deliver = (to: number, chunk: Buffer | null) =>
    setImmediate(() => {
      if (ended[to]) return;
      if (chunk === null) ended[to] = true;
      sides[to].push(chunk);
    });
  for (const self of [0, 1]) {
    const peer = 1 - self;
    sides.push(
      new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          deliver(peer, chunk);
          callback();
        },
        final(callback) {
          deliver(peer, null);
          callback();
        },
        destroy(error, callback) {
          deliver(peer, null);
          callback(error);
        },
      })
    );
  }
  return [sides[0], sides[1]];
}

/** 假服务端返回的列定义：真实 MySQL 在这里带上来源库、原表、原列 */
const serverColumn = (name: string, source?: Source) => ({
  catalog: 'def',
  schema: source?.schema ?? '',
  table: source ? source.alias ?? source.table : '',
  orgTable: source?.table ?? '',
  name,
  orgName: source?.column ?? '',
  characterSet: 33, // utf8_general_ci
  columnLength: 768,
  columnType: 253, // VAR_STRING
  flags: 0,
  decimals: 0,
});

describe('真实 mysql2 驱动的字段元数据（内存假服务端）', () => {
  test('驱动返回的 schema/orgTable/orgName 能把结果列归到来源表，最终 JSON 带 columnNotes；注释查询失败不影响连接复用', async () => {
    const requireFromServer = createRequire(new URL('../../server/src/tools/database.ts', import.meta.url));
    const mysql = requireFromServer('mysql2');
    const mysqlPromise = requireFromServer('mysql2/promise');
    const received: string[] = [];
    let denyComments = false;
    const respond = (server: any, sql: string) => {
      if (/^SHOW DATABASES$/i.test(sql)) {
        server.writeColumns([serverColumn('Database')]);
        server.writeTextRow(['skt']);
        server.writeEof();
      } else if (/^USE /i.test(sql)) {
        server.writeOk();
      } else if (sql.includes('information_schema.COLUMNS')) {
        if (denyComments) return server.writeError({ message: "SELECT command denied to user 'u'@'%' for table 'COLUMNS'", code: 1142 });
        server.writeColumns([serverColumn('col_name'), serverColumn('col_comment')]);
        if (sql.includes("TABLE_SCHEMA = 'skt' AND TABLE_NAME = 'skt_hotel_order'")) {
          for (const [name, comment] of commentsOf('skt', 'skt_hotel_order')) server.writeTextRow([name, comment]);
        }
        server.writeEof();
      } else if (sql.startsWith('SELECT h.order_no')) {
        server.writeColumns([
          serverColumn('order_no', hotel('order_no')),
          serverColumn('carrier', hotel('carrier')),
          serverColumn('come', hotel('order_come')),
          serverColumn('remark_flag', hotel('remark_flag')),
          serverColumn('carrier_text'),
        ]);
        server.writeTextRow(['H1', '1002', '1', null, '1002']);
        server.writeEof();
      } else {
        server.writeError({ message: `unexpected ${sql}`, code: 1064 });
      }
    };
    const stream = () => {
      const [clientSide, serverSide] = asyncPipePair();
      const server = new mysql.Connection({ config: new mysql.ConnectionConfig({ stream: serverSide, isServer: true }) });
      server.serverHandshake({
        protocolVersion: 10,
        serverVersion: '8.0.0-fake',
        connectionId: 1,
        statusFlags: 2,
        characterSet: 33,
        capabilityFlags: 0xffffff,
        // mysql2 的服务端模式不会按命令重置包序号：握手完成与每次应答后归零，与真实服务端一致
        authCallback: (_info: unknown, done: (err: null, mysqlError: null) => void) => {
          done(null, null);
          server.sequenceId = 0;
        },
      });
      server.on('query', (sql: string) => {
        received.push(sql);
        server.sequenceId = 1;
        respond(server, sql);
        server.sequenceId = 0;
      });
      server.on('error', () => {});
      return clientSide;
    };
    const pool = mysqlPromise.createPool({ stream, user: 'u', password: 'p', connectionLimit: 1, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
    let destroyed = 0;
    const withConnection = async <T>(fn: (ctx: QueryContext) => Promise<T>): Promise<T> => {
      const conn = await pool.getConnection();
      const ctx: QueryContext = { conn, timedOut: false };
      try {
        return await fn(ctx);
      } finally {
        if (ctx.timedOut) {
          destroyed++;
          conn.destroy();
        } else conn.release();
      }
    };
    const sql = "SELECT h.order_no, h.carrier, h.order_come AS come, h.remark_flag, CONCAT(h.carrier, '') AS carrier_text FROM skt.skt_hotel_order h WHERE h.order_no = 'H1'";
    const run = async () =>
      JSON.parse(
        await executeDatabaseTool({ action: 'query', sql }, {} as any, 'tester', {
          isConfigured: () => true,
          withConnection,
          lookupColumnComments: createColumnCommentsLookup(createColumnCommentCache()),
        })
      );
    try {
      const out = await run();
      assert.equal(out.status, 'success');
      assert.deepEqual(out.columnNotes, { carrier: '承运商：1001携程,1002华住,1003锦江', come: '订单来源 1:H5 2:APP 3:PC' });
      assert.deepEqual(out.columns, ['order_no', 'carrier', 'come', 'carrier_text']);
      assert.deepEqual(out.allNullColumns, ['remark_flag']);
      assert.deepEqual(out.rows, [['H1', '1002', '1', '1002']]);
      assert.ok(
        received.includes(
          "SELECT COLUMN_NAME AS col_name, COLUMN_COMMENT AS col_comment FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'skt' AND TABLE_NAME = 'skt_hotel_order' AND COLUMN_COMMENT <> '' LIMIT 1000"
        ),
        received.join('\n')
      );

      denyComments = true;
      const denied = await run();
      assert.equal(denied.status, 'success');
      assert.equal('columnNotes' in denied, false);
      assert.deepEqual(denied.rows, [['H1', '1002', '1', '1002']]);
      const again = await run();
      assert.equal(again.status, 'success');
      assert.equal(destroyed, 0);
    } finally {
      await pool.end();
    }
  });
});
