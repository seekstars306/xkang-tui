import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIdentifier, executeLookupOrder } from '../../server/src/tools/order_lookup.ts';
import { buildLogQL, resolveWindow, executeSearchLogs, executeListLogApps } from '../../server/src/tools/log_search.ts';
import { createCompanyTools } from '../../server/src/tools/index.ts';
import { executeWebSearch } from '../../server/src/tools/web_search.ts';
import { executeCodeGraph, isCodeSyncEnabled } from '../../server/src/tools/codegraph.ts';
import { executeDatabaseTool, closeDbPool } from '../../server/src/tools/database.ts';

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.finally(restore) as T;
    restore();
    return r;
  } catch (e) {
    restore();
    throw e;
  }
}

describe('lookup_order 单号识别', () => {
  test('按单号形态选择候选表', () => {
    const snow = classifyIdentifier('1541491413412347905');
    assert.match(snow.kind, /19 位/);
    const tables = snow.targets.map((t) => `${t.table}.${t.column}`);
    assert.ok(tables.includes('order.order_id'));
    assert.ok(tables.includes('order_air.air_id'));
    assert.ok(tables.includes('skt_hotel_order.id'));
    assert.ok(tables.includes('train_order.order_id'));
    assert.ok(tables.includes('taxi_order_info.id'));

    assert.equal(classifyIdentifier('9993903209296').targets[0].column, 'ticket_no');
    assert.equal(classifyIdentifier('999-3903209296').normalized, '9993903209296');
    assert.equal(classifyIdentifier('hvbjee').normalized, 'HVBJEE');
    assert.equal(classifyIdentifier('HVBJEE').targets[0].column, 'pnr_no');
    assert.equal(classifyIdentifier('E792574029').targets[0].column, 'order_number');
    assert.equal(classifyIdentifier('1132548263460526').targets[0].column, 'source_order_no');
  });

  test('手机号与无法识别的格式给出建议而不是乱查', () => {
    const phone = classifyIdentifier('18798927113');
    assert.equal(phone.targets.length, 0);
    assert.match(phone.advice || '', /手机号/);
    assert.equal(classifyIdentifier('abc-123').targets.length, 0);
  });

  test('未配置数据库时明确说明', async () => {
    const out = await withEnv({ COMPANY_DB_HOST: undefined, COMPANY_DB_USER: undefined, COMPANY_DB_PASSWORD: undefined }, () =>
      executeLookupOrder({ id: '1541491413412347905' }, {} as any)
    );
    assert.match(out, /未配置数据库连接/);
  });

  test('手机号直接返回建议，不查库', async () => {
    const out = await withEnv({ COMPANY_DB_HOST: 'h', COMPANY_DB_USER: 'u', COMPANY_DB_PASSWORD: 'p' }, () =>
      executeLookupOrder({ id: '18798927113' }, {} as any)
    );
    assert.match(out, /这是手机号不是单号/);
  });

  test('数据库不可达时快速失败并如实说明（不逐表等待超时，也不给出"加索引"之类的误导建议）', async () => {
    const env = { COMPANY_DB_HOST: '127.0.0.1', COMPANY_DB_PORT: '1', COMPANY_DB_USER: 'u', COMPANY_DB_PASSWORD: 'p' };
    try {
      const t0 = Date.now();
      const out = await withEnv(env, () => executeLookupOrder({ id: '1541491413412347905' }, {} as any));
      assert.ok(Date.now() - t0 < 8000, '应在一次连接失败后立即返回');
      assert.match(out, /^【单号定位失败】/);
      assert.match(out, /不能据此判断单号是否存在/);
      const q = JSON.parse(await withEnv(env, () => executeDatabaseTool({ action: 'query', sql: 'SELECT 1' }, {} as any, 'u')));
      assert.equal(q.status, 'error');
      assert.match(q.guidance, /数据库连接失败/);
      assert.doesNotMatch(q.guidance, /索引/);
    } finally {
      await closeDbPool();
    }
  });
});

describe('search_logs', () => {
  test('OR 关键词转为不区分大小写的正则（历史 bug：被当成字面量 "A OR B"）', () => {
    const q = buildLogQL({ app: 'cxy-web', keyword: 'exportBatchInvoiceByGids OR FileNotFoundException' });
    assert.equal(q, '{namespace="cxy", app="cxy-web"} |~ "(?i)(exportBatchInvoiceByGids|FileNotFoundException)"');
  });

  test('单个英文词不区分大小写，纯数字按字面精确匹配，特殊字符被转义', () => {
    assert.equal(buildLogQL({ keyword: 'Exception' }), '{namespace="cxy"} |~ "(?i)Exception"');
    assert.equal(buildLogQL({ keyword: '1541491413412347905' }), '{namespace="cxy"} |= "1541491413412347905"');
    assert.equal(buildLogQL({ keyword: '/api/order(1)' }), '{namespace="cxy"} |~ "(?i)/api/order\\\\(1\\\\)"');
  });

  test('时间窗口计算与 2 小时上限', () => {
    const now = new Date('2026-08-25T12:00:00').getTime();
    const w = resolveWindow({ target_time: '2026-08-25 13:19:20', window_minutes: 5 }, now);
    assert.ok(!('error' in w));
    if (!('error' in w)) assert.equal(w.endMs - w.startMs, 10 * 60 * 1000);
    const dflt = resolveWindow({}, now);
    assert.ok(!('error' in dflt) && /默认只查最近 30 分钟/.test(dflt.note || ''));
    assert.ok('error' in resolveWindow({ start_time: '2026-08-25 08:00:00', end_time: '2026-08-25 13:00:00' }, now));
    assert.ok('error' in resolveWindow({ target_time: 'not a time' }, now));
  });

  const grafanaEnv = { GRAFANA_URL: 'http://grafana.test', GRAFANA_USERNAME: 'u', GRAFANA_PASSWORD: 'p', GRAFANA_LOKI_UID: 'uid1' };
  const fakeFetch = (payload: any, captured: string[] = []) => (async (url: string) => {
    captured.push(url);
    return { ok: true, status: 200, text: async () => '', json: async () => payload };
  }) as any;

  test('达到 limit 时明确说明只拿到了最近的若干条，结果按时间正序展示', async () => {
    const base = BigInt(new Date('2026-08-25T13:20:00').getTime()) * 1000000n;
    const values = [0n, 2n, 1n].map((d) => [String(base + d * 1000000000n), `line-${d}`]);
    const out = await withEnv(grafanaEnv, () =>
      executeSearchLogs({ keyword: 'x', target_time: '2026-08-25 13:20:00', limit: 3 }, {} as any, 'u', fakeFetch({ status: 'success', data: { result: [{ stream: { app: 'cxy-web', pod: 'p1' }, values }] } }))
    );
    assert.match(out, /已达到 limit=3 上限/);
    const order = ['line-0', 'line-1', 'line-2'].map((l) => out.indexOf(l));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  test('没有日志时说明"没查到 ≠ 没发生"', async () => {
    const out = await withEnv(grafanaEnv, () =>
      executeSearchLogs({ keyword: 'x', minutes_ago: 30 }, {} as any, 'u', fakeFetch({ status: 'success', data: { result: [] } }))
    );
    assert.match(out, /没查到 ≠ 没发生/);
  });

  test('未配置 Grafana 凭据时明确报错（代码中不再保留默认密码）', async () => {
    const out = await withEnv({ GRAFANA_URL: undefined, GRAFANA_USERNAME: undefined, GRAFANA_PASSWORD: undefined, GRAFANA_LOKI_UID: undefined }, () =>
      executeSearchLogs({ keyword: 'x' }, {} as any, 'u')
    );
    assert.match(out, /未配置 GRAFANA_URL/);
    const apps = await withEnv({ GRAFANA_URL: undefined }, () => executeListLogApps({}, {} as any, 'u'));
    assert.match(apps, /未配置 GRAFANA_URL/);
  });
});

describe('服务端工具注册', () => {
  test('不再注册返回固定文案的脚手架工具；新增 lookup_order', () => {
    const names = withEnv({ SEARCH_API_KEY: undefined, EXA_API_KEY: undefined }, () => createCompanyTools({} as any).map((t) => t.name));
    assert.ok(names.includes('lookup_order'));
    assert.ok(!names.includes('knowledge_search'));
    assert.ok(!names.includes('kg_query'));
    assert.ok(!names.includes('web_search'), '未配置搜索 Key 时不注册 web_search');
  });

  test('配置了搜索 Key 才注册 web_search', () => {
    const names = withEnv({ SEARCH_API_KEY: 'k' }, () => createCompanyTools({} as any).map((t) => t.name));
    assert.ok(names.includes('web_search'));
  });

  test('工具描述中不再要求"必须盲查"', () => {
    const tools = createCompanyTools({} as any);
    for (const t of tools) {
      assert.doesNotMatch(t.description, /必须至少盲查|必须立即调用本工具进行盲查|排障必用/, t.name);
    }
  });

  test('web_search 失败时如实报错，不再编造搜索结果', async () => {
    const none = await withEnv({ SEARCH_API_KEY: undefined, EXA_API_KEY: undefined }, () => executeWebSearch({ query: 'Spring Cloud Gateway 504' }, {} as any, 'u'));
    assert.match(none, /不可用/);
    assert.doesNotMatch(none, /stackoverflow|github\.com\/search/);
    const failed = await withEnv({ SEARCH_API_KEY: 'k' }, () =>
      executeWebSearch({ query: 'x' }, {} as any, 'u', (async () => ({ ok: false, status: 503 })) as any)
    );
    assert.match(failed, /搜索失败/);
  });

  test('codegraph 区分"图谱中没有"与"查询失败"，都不再声称"未发现更多关联"', async () => {
    const cfg: any = { repoAllowlist: ['*'], codeGraphEndpoint: '' };
    const notFound = await executeCodeGraph({ symbol: 'Foo', queryType: 'callers' }, cfg, fetch, {
      query: () => ({ status: 'not_found', symbol: 'Foo', queryType: 'callers', totalMatches: 0, results: [], message: '未检索到符号 [Foo] 的 callers 关系。' }),
    } as any);
    assert.match(notFound, /不代表代码里不存在该关系/);
    const failed = await executeCodeGraph({ symbol: 'Foo', queryType: 'callers' }, cfg, fetch, {
      query: () => {
        throw new Error('index not loaded');
      },
    } as any);
    assert.match(failed, /CodeGraph 查询失败/);
    assert.doesNotMatch(failed + notFound, /未发现更多相关关联/);
  });

  test('定时代码同步可以关闭（测试实例不会去 git pull / reset 真实代码库）', () => {
    withEnv({ CODE_SYNC_ENABLED: 'false' }, () => assert.equal(isCodeSyncEnabled({ codeSyncIntervalMinutes: 10 } as any), false));
    withEnv({ CODE_SYNC_ENABLED: undefined }, () => {
      assert.equal(isCodeSyncEnabled({ codeSyncIntervalMinutes: 0 } as any), false);
      assert.equal(isCodeSyncEnabled({ codeSyncIntervalMinutes: 10 } as any), true);
    });
  });
});
