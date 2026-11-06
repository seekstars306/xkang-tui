import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = path.join(repoRoot, 'server/src/codegraph/sync_manager.ts');

/** 去掉注释再断言：否则"我们不走 exec"这种说明文字本身就会命中断言 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('代码同步的 git 命令不走 shell：不会经 cmd.exe，也就不会闪窗口', () => {
  const src = codeOnly(fs.readFileSync(file, 'utf8'));
  // promisify(exec(字符串)) 一律经 shell；Windows 上服务端没有控制台时，
  // 每个 cmd.exe 都会被新开一个可见控制台，一次同步闪一百多个窗口。
  assert.doesNotMatch(src, /promisify/, '不能再 promisify(exec)');
  assert.doesNotMatch(src, /\bexec\s*\(/, '不能再直接用 exec(');
  assert.match(src, /execFile\(/, '应改用 execFile');
  assert.match(src, /windowsHide/, 'execFile 也要 windowsHide');
});

test('代码同步不执行任何硬重置', () => {
  const src = codeOnly(fs.readFileSync(file, 'utf8'));
  for (const forbidden of ['reset --hard', 'checkout --force', 'clean -fd']) {
    assert.doesNotMatch(src, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '不允许出现 ' + forbidden);
  }
  assert.match(src, /pull --ff-only/, '只允许 fast-forward 拉取');
});
