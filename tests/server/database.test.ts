import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateReadOnlySql,
  normalizeSqlText,
  quoteLongIdLiterals,
  applyRowLimit,
  formatRowsResult,
  inferDbFromQualifiedNames,
  killRunningQuery,
  getDbConnectionConfig,
  executeDatabaseTool,
} from '../../server/src/tools/database.ts';

describe('SQL 安全校验', () => {
  test('只允许只读语句，拦截写操作、多语句与块注释', () => {
    assert.equal(validateReadOnlySql('SELECT * FROM skt.order_air').valid, true);
    assert.equal(validateReadOnlySql('```sql\nSELECT 1;\n```').valid, true);
    assert.equal(validateReadOnlySql('DELETE FROM t').valid, false);
    assert.equal(validateReadOnlySql('SELECT 1; DROP TABLE t').valid, false);
    assert.equal(validateReadOnlySql('SELECT * FROM t WHERE a = 1 /* x */').valid, false);
    assert.equal(validateReadOnlySql("SELECT * FROM t WHERE status = 'SET'").valid, true);
    assert.equal(validateReadOnlySql('SELECT * FROM t INTO OUTFILE "/tmp/x"').valid, false);
  });

  test('normalizeSqlText 去掉代码块包裹与首尾分号（以前末尾分号会导致追加 LIMIT 后语法错误）', () => {
    assert.equal(normalizeSqlText('```sql\nSELECT 1;\n```'), 'SELECT 1');
    assert.equal(normalizeSqlText('SELECT 1;;'), 'SELECT 1');
  });
});

describe('quoteLongIdLiterals', () => {
  test('等值比较中的长数字 ID 加引号', () => {
    const r = quoteLongIdLiterals('SELECT * FROM skt.order_air WHERE air_id = 1541491413412347905');
    assert.equal(r.sql, "SELECT * FROM skt.order_air WHERE air_id = '1541491413412347905'");
    assert.equal(r.changed, true);
  });

  test('IN 列表、<> 与 != 也会处理', () => {
    assert.equal(
      quoteLongIdLiterals('SELECT 1 FROM t WHERE id IN (1540797466482442240, 1540703080314699776) AND x <> 18053271039 AND y != 15414914134123').sql,
      "SELECT 1 FROM t WHERE id IN ('1540797466482442240', '1540703080314699776') AND x <> '18053271039' AND y != '15414914134123'"
    );
  });

  test('已加引号、字符串内部、LIMIT、范围比较、短数字、标识符中的数字保持不变', () => {
    const cases = [
      "SELECT * FROM t WHERE id = '1541491413412347905'",
      "SELECT * FROM t WHERE note = 'order 1541491413412347905 failed'",
      'SELECT * FROM t LIMIT 10',
      'SELECT * FROM t WHERE create_time >= 1693526400000',
      'SELECT * FROM t WHERE status = 3',
      'SELECT col12345678901 FROM t WHERE a = 1',
      'SELECT * FROM t WHERE amount = 12345678901.50',
    ];
    for (const sql of cases) {
      const r = quoteLongIdLiterals(sql);
      assert.equal(r.sql, sql, sql);
      assert.equal(r.changed, false, sql);
    }
  });
});

describe('applyRowLimit', () => {
  test('未写 LIMIT 时追加 LIMIT n+1 用于判断是否还有更多', () => {
    assert.deepEqual(applyRowLimit('SELECT * FROM t', 50), { sql: 'SELECT * FROM t LIMIT 51', probeLimit: 50, userLimit: null });
  });
  test('已写 LIMIT 时保留并记录用户的 LIMIT', () => {
    assert.deepEqual(applyRowLimit('SELECT * FROM t LIMIT 20', 50), { sql: 'SELECT * FROM t LIMIT 20', probeLimit: null, userLimit: 20 });
    assert.equal(applyRowLimit('SELECT * FROM t LIMIT 10, 30', 50).userLimit, 30);
    assert.equal(applyRowLimit('SELECT * FROM t LIMIT 30 OFFSET 60', 50).userLimit, 30);
  });
  test('非 SELECT 语句不处理', () => {
    assert.deepEqual(applyRowLimit('SHOW TABLES', 50), { sql: 'SHOW TABLES', probeLimit: null, userLimit: null });
  });
});

describe('formatRowsResult', () => {
  const makeRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: String(1000 + i), name: `用户${i}`, phone: null, created: '2026-08-25 13:19:20' }));

  test('超过上限时标注 complete=false 并给出取全数据的方法（历史"漏人"案例的根因）', () => {
    const out = JSON.parse(formatRowsResult({ database: 'skt', executedSql: 'SELECT ... LIMIT 51', rows: makeRows(51), limit: 50, probeLimit: 50, userLimit: null }));
    assert.equal(out.complete, false);
    assert.equal(out.rowCount, 50);
    assert.match(out.notes.join(''), /结果不完整/);
    assert.match(out.notes.join(''), /COUNT\(\*\)/);
  });

  test('未超过上限时 complete=true，全 NULL 列单独列出，行以数组紧凑输出', () => {
    const out = JSON.parse(formatRowsResult({ database: 'skt', executedSql: 'x', rows: makeRows(3), limit: 50, probeLimit: 50, userLimit: null }));
    assert.equal(out.complete, true);
    assert.deepEqual(out.columns, ['id', 'name', 'created']);
    assert.deepEqual(out.allNullColumns, ['phone']);
    assert.deepEqual(out.rows[0], ['1000', '用户0', '2026-08-25 13:19:20']);
  });

  test('返回行数等于用户 LIMIT 时提示可能还有更多', () => {
    const out = JSON.parse(formatRowsResult({ database: 'skt', executedSql: 'x', rows: makeRows(20), limit: 50, probeLimit: null, userLimit: 20 }));
    assert.equal(out.complete, false);
    assert.match(out.notes.join(''), /LIMIT 20/);
  });

  test('超出输出预算时按行裁剪并说明，输出始终是完整 JSON', () => {
    const wide = Array.from({ length: 50 }, (_, i) => ({ id: String(i), memo: 'x'.repeat(280) }));
    const text = formatRowsResult({ database: 'skt', executedSql: 'x', rows: wide, limit: 50, probeLimit: null, userLimit: null, budget: 4000 });
    assert.ok(text.length <= 4000);
    const out = JSON.parse(text);
    assert.equal(out.complete, false);
    assert.ok(out.rowCount < 50);
    assert.match(out.notes.join(''), /因输出长度限制只展示了前/);
  });

  test('Date/Buffer/超长文本单元格安全转换（日期按本地时间，不再序列化成 UTC 的 ...Z）', () => {
    const out = JSON.parse(
      formatRowsResult({
        database: 'skt',
        executedSql: 'x',
        rows: [{ t: new Date(2026, 7, 25, 13, 19, 20), b: Buffer.from('abc'), s: 'y'.repeat(400) }],
        limit: 50,
        probeLimit: 50,
        userLimit: null,
      })
    );
    assert.equal(out.rows[0][0], '2026-08-25 13:19:20');
    assert.equal(out.rows[0][1], '[二进制 3 字节]');
    assert.match(out.rows[0][2], /文本截断，共 400 字符/);
  });
});

describe('库名推断', () => {
  test('表别名 u.id 不会被当成库名（回归保护）', () => {
    const known = ['skt', 'payment', 'skt_log'];
    assert.equal(inferDbFromQualifiedNames('SELECT u.id FROM skt.sys_user_info u', known), 'skt');
    assert.equal(inferDbFromQualifiedNames('SELECT u.id, o.name FROM sys_user_info u JOIN sys_organization o', known), null);
    assert.equal(inferDbFromQualifiedNames('SELECT * FROM `payment`.`payment_flow`', known), 'payment');
  });
});

describe('超时后终止服务端查询', () => {
  const fakeFactory = (behaviour: { killQueryFails?: boolean; killFails?: boolean; connectFails?: boolean }, log: string[]) => async () => {
    if (behaviour.connectFails) throw new Error('connect refused');
    return {
      query: async (sql: string) => {
        log.push(sql);
        if (sql.startsWith('KILL QUERY') && behaviour.killQueryFails) throw new Error('unsupported');
        if (sql.startsWith('KILL ') && !sql.startsWith('KILL QUERY') && behaviour.killFails) throw new Error('nope');
        return [];
      },
      end: async () => {
        log.push('end');
      },
    };
  };

  test('优先 KILL QUERY', async () => {
    const log: string[] = [];
    assert.equal(await killRunningQuery(42, fakeFactory({}, log)), 'killed');
    assert.deepEqual(log, ['KILL QUERY 42', 'end']);
  });

  test('KILL QUERY 不支持时退回 KILL 连接', async () => {
    const log: string[] = [];
    assert.equal(await killRunningQuery(42, fakeFactory({ killQueryFails: true }, log)), 'killed');
    assert.deepEqual(log, ['KILL QUERY 42', 'KILL 42', 'end']);
  });

  test('拿不到线程号或连接失败时不抛异常', async () => {
    assert.equal(await killRunningQuery(undefined, fakeFactory({}, [])), 'skipped');
    assert.equal(await killRunningQuery(42, fakeFactory({ connectFails: true }, [])), 'failed');
  });
});

describe('凭据只来自环境变量', () => {
  test('缺少 COMPANY_DB_* 时明确报错，不再回退到代码里的默认账号', async () => {
    const saved = { h: process.env.COMPANY_DB_HOST, u: process.env.COMPANY_DB_USER, p: process.env.COMPANY_DB_PASSWORD };
    delete process.env.COMPANY_DB_HOST;
    delete process.env.COMPANY_DB_USER;
    delete process.env.COMPANY_DB_PASSWORD;
    try {
      assert.equal(getDbConnectionConfig(), null);
      const out = JSON.parse(await executeDatabaseTool({ action: 'query', sql: 'SELECT 1' }, {} as any, 'tester'));
      assert.equal(out.status, 'error');
      assert.match(out.message, /未配置 COMPANY_DB_HOST/);
    } finally {
      if (saved.h) process.env.COMPANY_DB_HOST = saved.h;
      if (saved.u) process.env.COMPANY_DB_USER = saved.u;
      if (saved.p) process.env.COMPANY_DB_PASSWORD = saved.p;
    }
  });

  test('配置的连接参数使用 dateStrings，避免日期被转成 UTC', () => {
    const saved = { h: process.env.COMPANY_DB_HOST, u: process.env.COMPANY_DB_USER, p: process.env.COMPANY_DB_PASSWORD };
    process.env.COMPANY_DB_HOST = 'db.example';
    process.env.COMPANY_DB_USER = 'u';
    process.env.COMPANY_DB_PASSWORD = 'p';
    try {
      const cfg = getDbConnectionConfig();
      assert.equal(cfg?.dateStrings, true);
      assert.equal(cfg?.multipleStatements, false);
    } finally {
      for (const [k, v] of Object.entries({ COMPANY_DB_HOST: saved.h, COMPANY_DB_USER: saved.u, COMPANY_DB_PASSWORD: saved.p })) {
        if (v) process.env[k] = v;
        else delete process.env[k];
      }
    }
  });
});
