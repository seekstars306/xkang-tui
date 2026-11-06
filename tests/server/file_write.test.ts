import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { executeWriteFile, fileOutputDir, resolveInsideSandbox } from '../../server/src/tools/file_write.ts';

const cfg = {} as any;

function withSandbox<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xkang-write-'));
  const saved = process.env.XKANG_FILE_OUTPUT_DIR;
  process.env.XKANG_FILE_OUTPUT_DIR = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (saved === undefined) delete process.env.XKANG_FILE_OUTPUT_DIR; else process.env.XKANG_FILE_OUTPUT_DIR = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }) as Promise<T>;
}

test('相对路径写在导出目录内', () => withSandbox(async dir => {
  assert.equal(fileOutputDir(), path.resolve(dir));
  const out = await executeWriteFile({ path: 'a.csv', content: 'x,y\n1,2' }, cfg);
  assert.equal(JSON.parse(out).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'a.csv'), 'utf8'), 'x,y\n1,2');
}));

test('支持子目录并自动创建', () => withSandbox(async dir => {
  await executeWriteFile({ path: 'sub/b.txt', content: 'hi' }, cfg);
  assert.equal(fs.readFileSync(path.join(dir, 'sub', 'b.txt'), 'utf8'), 'hi');
}));

test('append 追加而不是覆盖', () => withSandbox(async dir => {
  await executeWriteFile({ path: 'g.csv', content: 'head\n' }, cfg);
  await executeWriteFile({ path: 'g.csv', content: 'row1\n', append: true }, cfg);
  assert.equal(fs.readFileSync(path.join(dir, 'g.csv'), 'utf8'), 'head\nrow1\n');
}));

test('绝对路径被拒绝', () => withSandbox(() => {
  assert.throws(() => resolveInsideSandbox('/etc/passwd'));
  assert.throws(() => resolveInsideSandbox('C:\\Windows\\win.ini'));
}));

test('.. 逃逸被拒绝', () => withSandbox(() => {
  assert.throws(() => resolveInsideSandbox('../outside.txt'));
  assert.throws(() => resolveInsideSandbox('sub/../../outside.txt'));
}));

test('空路径被拒绝', () => withSandbox(() => {
  assert.throws(() => resolveInsideSandbox('   '));
}));

test('超过 5MB 被拒绝', () => withSandbox(async () => {
  const huge = 'a'.repeat(5 * 1024 * 1024 + 1);
  await assert.rejects(() => executeWriteFile({ path: 'big.txt', content: huge }, cfg));
}));
