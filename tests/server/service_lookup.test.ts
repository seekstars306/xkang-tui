import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadServiceMap, lookupService, listServices } from '../../server/src/tools/service_lookup.ts';

const REAL = path.resolve('server/data/service_map.json');

test('真实映射文件可加载，且包含部署名与配置目录不一致的已知案例', { skip: !fs.existsSync(REAL) }, () => {
  const map = loadServiceMap(REAL);
  assert.ok(map, '映射应能解析');
  // 这条是本项目最反直觉的一处：部署名 cxy-booking 的配置在 cxy-dpxt 目录
  assert.equal(map!.services['cxy-booking']?.configDir, 'skt-back/prod-config/cxy-dpxt');
});

test('按部署名查：返回配置目录与仓库，并给出日志 app 名', { skip: !fs.existsSync(REAL) }, () => {
  const map = loadServiceMap(REAL)!;
  const r = lookupService(map, 'cxy-booking');
  assert.equal(r.matchedBy, 'deployName');
  assert.equal(r.services[0].repo, 'skt_dpxt_background');
  assert.match(r.hint, /app="cxy-booking"/, '提示里要说明查日志用哪个 app');
});

test('按类全名查：取前 3 段包根反查服务', { skip: !fs.existsSync(REAL) }, () => {
  const map = loadServiceMap(REAL)!;
  const r = lookupService(map, 'com.company.project.hotel.remote.service.HotelQueryService');
  assert.equal(r.matchedBy, 'className');
  assert.equal(r.packageRoot, 'com.company.project');
  assert.ok(r.services.some(s => s.deployName === 'cxy-booking'), 'T007 的类应能定位到 cxy-booking');
});

test('按仓库名查：反查同一仓库承载的多个服务', { skip: !fs.existsSync(REAL) }, () => {
  const map = loadServiceMap(REAL)!;
  const r = lookupService(map, 'skt_dpxt_background');
  assert.equal(r.matchedBy, 'repo');
  const names = r.services.map(s => s.deployName);
  assert.ok(names.includes('cxy-booking') && names.includes('cxy-booking-timer'), '一个仓库多个服务必须全部列出');
});

test('未命中时给出可执行的下一步，而不是空结果', () => {
  const tmp = path.join(os.tmpdir(), 'sm-' + Date.now() + '.json');
  fs.writeFileSync(tmp, JSON.stringify({ generatedAt: '', logicalRoot: '', warnings: [], services: {} }));
  try {
    const map = loadServiceMap(tmp)!;
    const r = lookupService(map, 'not-a-service');
    assert.equal(r.found, false);
    assert.match(r.hint, /list_log_apps/, '未命中时要指引用 list_log_apps 兜底');
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('映射文件缺失时 loadServiceMap 返回 null，由调用方给出提示', () => {
  assert.equal(loadServiceMap(path.join(os.tmpdir(), 'definitely-missing-' + Date.now() + '.json')), null);
});

test('listServices 输出全部服务并带上告警说明', { skip: !fs.existsSync(REAL) }, () => {
  const map = loadServiceMap(REAL)!;
  const r = listServices(map);
  assert.ok(r.count > 0);
  assert.ok(r.warnings.some(w => w.includes('部署名与配置目录名不一致')), '告警要显式说明命名不一致');
});
