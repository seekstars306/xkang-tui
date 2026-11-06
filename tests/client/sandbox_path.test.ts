import assert from 'node:assert/strict';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { validatePathInRepo } from '../../src/tools/sandbox.ts';
import { createJunctionEnv, type JunctionEnv } from '../helpers/junction_env.ts';

let env: JunctionEnv;

before(() => { env = createJunctionEnv(); });
after(() => env.cleanup());

test('junction 越界：validatePathInRepo 拒绝经连接点逃逸的路径（写/编辑工具用）', (t) => {
  if (!env.linked) { t.skip('连接点创建失败（权限受限环境）'); return; }
  assert.throws(() => validatePathInRepo('link/secret.txt', env.root), /安全拦截/);
  assert.throws(() => validatePathInRepo('link', env.root), /安全拦截/);
  assert.throws(() => validatePathInRepo(path.join(env.root, 'link', 'secret.txt'), env.root), /安全拦截/);
});

test('正常子路径与尚不存在的新文件路径放行；返回值不展开软链/短文件名', () => {
  const existing = validatePathInRepo('src/App.java', env.root);
  assert.equal(existing.safePath, path.resolve(env.root, 'src', 'App.java'));
  // 相对路径沿用 path.relative 的原有格式（Windows 下为反斜杠），不因 realpath 校验而改变
  assert.equal(existing.relativePath, path.join('src', 'App.java'));
  const fresh = validatePathInRepo(path.join('src', 'new', 'NewFile.java'), env.root);
  assert.equal(fresh.safePath, path.resolve(env.root, 'src', 'new', 'NewFile.java'));
  assert.equal(fresh.relativePath, path.join('src', 'new', 'NewFile.java'));
});

test('.git 内部与空路径仍然硬拦截', () => {
  assert.throws(() => validatePathInRepo('.git/config', env.root), /\.git/);
  assert.throws(() => validatePathInRepo(path.join('src', '.git', 'HEAD'), env.root), /\.git/);
  assert.throws(() => validatePathInRepo('   ', env.root), /不能为空/);
  assert.throws(() => validatePathInRepo('../outside/secret.txt', env.root), /安全拦截/);
});
