/**
 * 真实系统集成测试（只读）：D:\skt_project 代码库、公司数据库（MyCat）、Grafana/Loki 日志，以及隔离服务端的 MCP 端到端。
 * 运行：npm run test:integration（内网不可达时，依赖数据库/日志的用例会注明原因并跳过；XKANG_IT=0 可整体跳过）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyServerEnvToProcess, startIsolatedServer, IsolatedServer, isTcpReachable } from '../helpers/isolated_server.ts';

const RUN = process.env.XKANG_IT !== '0';
const REPO = 'D:/skt_project';

if (RUN) applyServerEnvToProcess();

const { executeSearchCode, executeReadFileLines, executeGitInspect } = await import('../../server/src/tools/code_search.ts');
const { executeDatabaseTool, closeDbPool } = await import('../../server/src/tools/database.ts');
const { executeLookupOrder } = await import('../../server/src/tools/order_lookup.ts');
const { executeSearchLogs, executeListLogApps } = await import('../../server/src/tools/log_search.ts');

after(async () => {
  await closeDbPool();
});

const cfg: any = { codeRepoPath: REPO, repoAllowlist: ['*'] };
async function reachability(configured: boolean, host: string | undefined, port: number, label: string): Promise<string | false> {
  if (!RUN) return 'XKANG_IT 未开启';
  if (!configured || !host) return `${label} 未配置`;
  return (await isTcpReachable(host, port)) ? false : `${label} ${host}:${port} 当前不可达（内网/VPN 未连接），跳过`;
}
const dbSkip = await reachability(Boolean(process.env.COMPANY_DB_HOST && process.env.COMPANY_DB_PASSWORD), process.env.COMPANY_DB_HOST, Number(process.env.COMPANY_DB_PORT || 8066), '公司数据库');
const grafanaUrl = process.env.GRAFANA_URL ? new URL(process.env.GRAFANA_URL) : null;
const logSkip = await reachability(Boolean(grafanaUrl && process.env.GRAFANA_PASSWORD), grafanaUrl?.hostname, Number(grafanaUrl?.port || 80), 'Grafana 日志系统');

describe('真实代码库 D:/skt_project', { skip: !RUN }, () => {
  test('前端检索能找到页面（历史：22 次前端检索 20 次"未检索到"）', async () => {
    const out = await executeSearchCode({ keyword: '乘机中文名 OR 账户类型 OR 是否领导', scope: 'frontend', output_mode: 'files_with_matches' }, cfg);
    const files = out.split('\n').filter((l) => l.startsWith('- '));
    assert.ok(files.length >= 10, out.slice(0, 500));
    assert.ok(files.every((l) => l.startsWith('- skt-front/')));
  });

  test('后端检索不混入前端代码', async () => {
    const out = await executeSearchCode({ keyword: '账户类型', scope: 'backend', output_mode: 'files_with_matches' }, cfg);
    assert.doesNotMatch(out, /skt-front\//);
  });

  test('读取 OrderAirOperationServiceImpl 1120-1160 行时能看到后续把收款状态重置为 0 的代码（历史误判）', async () => {
    const out = await executeReadFileLines(
      { filePath: 'skt-back/skt_cxy/cxy-web/src/main/java/com/llb/cxy/sktAir/orderair/service/impl/OrderAirOperationServiceImpl.java', startLine: 1120, endLine: 1160 },
      cfg
    );
    assert.match(out, /orderAirCopy/);
    assert.match(out, /setReceivableState\(0\)/);
  });

  test('git_inspect 能查询嵌套子仓库的提交历史（历史：恒报 not a git repository）', async () => {
    const out = await executeGitInspect(
      { action: 'log', filePath: 'skt-back/skt_cxy/cxy-web/src/main/java/com/llb/cxy/sktAir/orderair/service/impl/OrderAirOperationServiceImpl.java', maxCount: 3 },
      cfg
    );
    assert.match(out, /仓库: skt-back\/skt_cxy/);
    assert.doesNotMatch(out, /not a git repository/);
  });

  test('大范围检索输出受控且明确告知未展示的部分', async () => {
    const out = await executeSearchCode({ keyword: 'setReceivableState', scope: 'backend', filePattern: '*.java' }, cfg);
    assert.ok(out.length <= 17000, `输出过长: ${out.length}`);
    assert.match(out, /命中 \d+ 个文件/);
    assert.match(out, /offset=/);
  });
});

describe('真实数据库（只读）', { skip: !RUN }, () => {
  test('describe_table 返回索引信息', { skip: dbSkip }, async () => {
    const out = JSON.parse(await executeDatabaseTool({ action: 'describe_table', database: 'skt', tableName: 'order_air' }, cfg, 'it'));
    assert.equal(out.status, 'success', JSON.stringify(out));
    assert.ok(out.indexes.some((i: any) => i.columns[0] === 'air_id'), JSON.stringify(out.indexes));
  });

  test('长数字 ID 自动加引号，日期为数据库本地时间格式（历史：307 个时间值以 UTC ...Z 返回）', { skip: dbSkip }, async () => {
    const out = JSON.parse(
      await executeDatabaseTool({ action: 'query', sql: "SELECT air_id, CAST('2026-10-09 12:34:56' AS DATETIME) AS sample_time FROM skt.order_air WHERE air_id = 1540797466482442240" }, cfg, 'it')
    );
    assert.equal(out.status, 'success', JSON.stringify(out));
    assert.match(out.executedSql, /air_id = '1540797466482442240'/);
    assert.equal(out.rowCount, 1);
    const cDate = out.rows[0][out.columns.indexOf('sample_time')];
    assert.match(String(cDate), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    assert.doesNotMatch(String(cDate), /T.*Z$/);
  });

  test('超过 limit 时标注 complete=false', { skip: dbSkip }, async () => {
    const out = JSON.parse(await executeDatabaseTool({ action: 'query', sql: 'SELECT air_id FROM skt.order_air', limit: 5 }, cfg, 'it'));
    assert.equal(out.status, 'success', JSON.stringify(out));
    assert.equal(out.rowCount, 5);
    assert.equal(out.complete, false);
    assert.match(out.notes.join(''), /结果不完整/);
  });

  test('表别名不会被当成库名', { skip: dbSkip }, async () => {
    const out = JSON.parse(
      await executeDatabaseTool({ action: 'query', sql: 'SELECT u.id, u.realname FROM skt.sys_user_info u LIMIT 1' }, cfg, 'it')
    );
    assert.equal(out.status, 'success', JSON.stringify(out));
    assert.equal(out.database, 'skt');
  });

  test('lookup_order：历史上被当成机票/火车票的单号，实际定位为酒店订单', { skip: dbSkip }, async () => {
    const out = await executeLookupOrder({ id: '1541491413412347905' }, cfg);
    assert.match(out, /✅ 命中/, out);
    assert.match(out, /【酒店】skt\.skt_hotel_order/, out);
    assert.doesNotMatch(out, /【机票】|【火车票】/, out);
  });

  test('lookup_order：机票与打车单号', { skip: dbSkip }, async () => {
    const air = await executeLookupOrder({ id: '1540797466482442240' }, cfg);
    assert.match(air, /【机票】skt\.order_air（按 air_id 匹配/, air);
    const taxi = await executeLookupOrder({ id: '1530517490084478976' }, cfg);
    assert.match(taxi, /【打车】skt\.taxi_order_info/, taxi);
  });

  test('lookup_order：不存在的单号如实说明查过哪些表', { skip: dbSkip }, async () => {
    const out = await executeLookupOrder({ id: '1000000000000000001' }, cfg);
    assert.match(out, /❌ 在下面所有候选主表中都没有找到/, out);
    assert.match(out, /未命中（已查询，0 行）/, out);
  });
});

describe('真实日志系统（只读）', { skip: !RUN }, () => {
  test('list_log_apps 可用', { skip: logSkip }, async () => {
    const out = JSON.parse(await executeListLogApps({}, cfg, 'it'));
    assert.ok(out.count > 0);
  });

  test('OR 关键词可以正常查询（历史：被当成字面量导致 0 条）', { skip: logSkip }, async () => {
    const out = await executeSearchLogs({ app: 'cxy-web', keyword: 'Exception OR ERROR', minutes_ago: 10, limit: 5 }, cfg, 'it');
    assert.doesNotMatch(out, /日志查询失败|错误:/, out);
    assert.match(out, /\|~ "\(\?i\)\(Exception\|ERROR\)"/, out);
  });
});

describe('隔离服务端 MCP 端到端', { skip: !RUN }, () => {
  let server: IsolatedServer;
  before(async () => {
    server = await startIsolatedServer(8691);
  });
  after(async () => {
    await server?.stop();
  });

  test('工具列表、调用与集中技能下发', async () => {
    const { McpRemoteClient } = await import('../../src/mcp/client.ts');
    const client = new McpRemoteClient({ serverUrl: server.url, token: server.adminToken });
    assert.equal(await client.connect(), true, server.logs.join('').slice(-2000));
    try {
      const names = (await client.listTools()).map((t) => t.name);
      for (const n of ['lookup_order', 'search_code', 'read_file_lines', 'git_inspect', 'company_db_query', 'search_logs', 'codegraph_explore']) {
        assert.ok(names.includes(n), `缺少工具 ${n}`);
      }
      assert.ok(!names.includes('knowledge_search') && !names.includes('kg_query'));
      const out = String(await client.callTool('search_code', { keyword: '账户类型', scope: 'frontend', output_mode: 'count' }));
      assert.match(out, /skt-front\//);
      const graph = String(await client.callTool('codegraph_explore', { symbol: 'orderAirCopy', queryType: 'callers' }));
      assert.match(graph, /代码图谱知识库/);
      const skills = await client.fetchSkills();
      assert.ok(skills.some((s) => s.version === '3.0.0'));
    } finally {
      await client.close();
    }
  });

  test('代码同步调度器在测试实例中保持关闭', () => {
    assert.match(server.logs.join(''), /已按配置关闭定时代码同步/);
    assert.doesNotMatch(server.logs.join(''), /开始同步代码库/);
  });

  test('员工不能直接取得原始工具、技能、图谱或公司目录', async () => {
    for (const route of ['/mcp/tools/list', '/mcp/skills', '/mcp/sse', '/codegraph/api/query']) {
      const res = await fetch(server.url + route, { method: route.includes('query') ? 'POST' : 'GET', headers: { Authorization: `Bearer ${server.token}`, 'x-device-id': 'privacy-it' } });
      assert.equal(res.status, 403, route);
    }
    const config = await (await fetch(server.url + '/config/client')).json() as any;
    assert.equal(config.businessApiVersion, 1);
    assert.equal(config.codeRepoPath, undefined);
  });
});
