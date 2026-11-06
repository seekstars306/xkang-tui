import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { EXCLUDED_DIR_NAMES, EXCLUDED_FILE_GLOBS, excludedReason, isExcludedDir, isExcludedPath } from '../../server/src/codegraph/path_policy.ts';
import { executeGitInspect, executeReadFileLines, executeSearchCode, isInside, resolveRepoFile } from '../../server/src/tools/code_search.ts';
import { createJunctionEnv, type JunctionEnv } from '../helpers/junction_env.ts';

test('排除判定表：prod-config、备份文件、构建产物一律排除', () => {
  for (const rel of [
    'skt-back/prod-config/cxy-transfer/application.yml',
    'skt-back/prod-config/nacos/application.properties',
    'skt-back/prod-config',
    'any/dir/foo.bak',
    'any/dir/foo.bak.20261010',
    'any/dir/foo.old',
    'any/dir/foo.orig',
    'node_modules/lib/index.js',
    'skt-back/svc/target/classes/App.class',
    'skt-back/svc/.git/config',
    'skt-back/svc/build/out.js',
    'skt-back/svc/dist/app.js',
    'skt-back/svc/bin/run.sh',
    'skt-back/svc/.idea/workspace.xml',
    'skt-back/svc/.vscode/settings.json',
    'skt-back\\prod-config\\cxy-transfer\\application.yml',
  ]) {
    assert.ok(isExcludedPath(rel), rel);
    assert.ok(excludedReason(rel), rel);
  }
});

test('排除判定表：正常源码与普通配置不得误伤（含 old/new 字样的文件名）', () => {
  for (const rel of [
    'skt-back/skt_cxy/src/main/java/com/x/SktHotelCLOrderServiceImpl.java',
    'skt-back/skt_dpxt_background/src/main/java/com/x/OrderNewServiceImpl.java',
    'skt-back/sktprojecthotel/skt-system/src/main/resources/application-web.yml',
    'skt-back/svc/src/main/java/com/x/OrderServiceOld.java',
    'skt-back/svc/src/main/java/com/x/OrderServiceNew.java',
    'skt-back/svc/src/main/resources/application.yml',
    'skt-back/svc/notes/readme.md',
  ]) {
    assert.equal(isExcludedPath(rel), false, rel);
    assert.equal(excludedReason(rel), null, rel);
  }
});

test('目录名按段完整匹配，不是子串', () => {
  assert.ok(isExcludedDir('prod-config'));
  assert.ok(isExcludedDir('node_modules'));
  assert.ok(isExcludedDir('target'));
  assert.equal(isExcludedDir('prod-config-backup'), false);
  assert.equal(isExcludedDir('src'), false);
  assert.equal(isExcludedPath('skt-back/prod-config-backup/application.yml'), false);
  assert.ok(EXCLUDED_DIR_NAMES.has('prod-config'));
  for (const glob of ['!**/prod-config/**', '!**/*.bak', '!**/*.bak.*', '!**/*.old', '!**/*.orig', '!**/node_modules/**', '!**/package-lock.json']) {
    assert.ok(EXCLUDED_FILE_GLOBS.includes(glob), glob);
  }
});

test('排除原因说明指向具体规则', () => {
  assert.match(excludedReason('skt-back/prod-config/a.yml') || '', /prod-config/);
  assert.match(excludedReason('a/b/foo.bak') || '', /备份/);
  assert.match(excludedReason('a/b/foo.old') || '', /备份/);
  assert.match(excludedReason('skt-back/svc/target/x.class') || '', /target/);
});

let fx: { root: string; cleanup: () => void };
let cfg: any;

before(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-policy-'));
  const write = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  write('skt-back/svc/src/main/java/com/x/OrderService.java', 'class OrderService { void pay() { refundFee(); } }\n');
  write('skt-back/svc/src/main/java/com/x/AuthService.java', 'class AuthService { String password = "x"; }\n');
  write('skt-back/skt_cxy/SktHotelCLOrderServiceImpl.java', 'class SktHotelCLOrderServiceImpl {}\n');
  write('skt-back/skt_dpxt_background/OrderNewServiceImpl.java', 'class OrderNewServiceImpl {}\n');
  write('skt-back/sktprojecthotel/skt-system/src/main/resources/application-web.yml', 'hotel:\n  name: x\n');
  write('skt-back/prod-config/cxy-transfer/application.yml', 'spring:\n  datasource:\n    password: fake\n');
  write('skt-back/prod-config/nacos/application.properties', 'db.password=fake\n');
  write('skt-back/prod-config/legacy/application.yml.bak.20261010', 'password: old\n');
  write('skt-back/svc/legacy/OldOrderService.java.bak', 'password: old\n');
  write('skt-back/svc/target/classes/App.class', 'binary');
  fx = { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  cfg = { codeRepoPath: root };
});
after(() => fx.cleanup());

test('resolveRepoFile：prod-config 与备份文件返回"已排除"并说明原因，不是"文件不存在"', () => {
  for (const rel of [
    'skt-back/prod-config/cxy-transfer/application.yml',
    'skt-back/prod-config/nacos/application.properties',
    'skt-back/prod-config/legacy/application.yml.bak.20261010',
    'skt-back/svc/legacy/OldOrderService.java.bak',
    'skt-back/svc/target/classes/App.class',
  ]) {
    const r = resolveRepoFile(fx.root, rel);
    assert.equal(r.ok, false, rel);
    if (!r.ok) {
      assert.match(r.message, /已排除/, rel);
      assert.doesNotMatch(r.message, /文件不存在/, rel);
    }
  }
  assert.match((resolveRepoFile(fx.root, 'skt-back/prod-config/cxy-transfer/application.yml') as any).message, /prod-config/);
  assert.match((resolveRepoFile(fx.root, 'skt-back/svc/legacy/OldOrderService.java.bak') as any).message, /备份/);
});

test('resolveRepoFile：正常源码、普通配置与 old/new 文件名不受影响', () => {
  for (const rel of [
    'skt-back/svc/src/main/java/com/x/OrderService.java',
    'skt-back/skt_cxy/SktHotelCLOrderServiceImpl.java',
    'skt-back/skt_dpxt_background/OrderNewServiceImpl.java',
    'skt-back/sktprojecthotel/skt-system/src/main/resources/application-web.yml',
  ]) {
    const r = resolveRepoFile(fx.root, rel);
    assert.equal(r.ok, true, rel);
  }
});

test('read_file_lines 与 git_inspect 同样拿不到 prod-config 内容', async () => {
  const read = await executeReadFileLines({ filePath: 'skt-back/prod-config/cxy-transfer/application.yml' }, cfg);
  assert.match(read, /已排除/);
  assert.doesNotMatch(read, /password/);
  const git = await executeGitInspect({ action: 'log', filePath: 'skt-back/prod-config/cxy-transfer/application.yml' }, cfg);
  assert.match(git, /已排除/);
});

test('search_code 不再检索 prod-config 与备份文件，正常文件照常命中', async () => {
  const out = await executeSearchCode({ keyword: 'password', scope: 'all', output_mode: 'files_with_matches' }, cfg);
  assert.match(out, /AuthService\.java/);
  assert.doesNotMatch(out, /prod-config/);
  assert.doesNotMatch(out, /\.bak/);
});

let env: JunctionEnv;

before(() => { env = createJunctionEnv(); });
after(() => env.cleanup());

test('junction 越界：isInside 拒绝经连接点逃逸的路径（真实仓库里不建连接点）', (t) => {
  if (!env.linked) { t.skip('连接点创建失败（权限受限环境）'); return; }
  assert.equal(isInside(env.root, env.root), true);
  assert.equal(isInside(env.root, path.join(env.root, 'src', 'App.java')), true);
  assert.equal(isInside(env.root, path.join(env.root, 'src', 'new', 'New.java')), true, '尚不存在的新文件路径仍放行');
  assert.equal(isInside(env.root, path.join(env.root, 'link')), false);
  assert.equal(isInside(env.root, path.join(env.root, 'link', 'secret.txt')), false);
  assert.equal(isInside(env.root, path.join(env.root, '..', 'outside', 'secret.txt')), false);
});
