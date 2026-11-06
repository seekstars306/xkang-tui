import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { saveBase64ImagesToDiskAndExtractPaths } from '../../server/src/llm.ts';

function imageMessage(base64: string): any[] {
  return [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }] }];
}

function currentMonthDir(baseDir: string): string {
  const now = new Date();
  return path.join(baseDir, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
}

test('同一张截图多轮对话只落盘一次，_savedLocalPath 稳定', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-img-'));
  try {
    const a = Buffer.from('screenshot-content-a').toString('base64');
    const first = imageMessage(a);
    const savedFirst = saveBase64ImagesToDiskAndExtractPaths(first, baseDir);
    const savedSecond = saveBase64ImagesToDiskAndExtractPaths(imageMessage(a), baseDir);
    assert.equal(savedFirst.length, 1);
    assert.equal(savedSecond.length, 1);
    assert.equal(savedFirst[0], savedSecond[0]);
    assert.equal(first[0].content[0]._savedLocalPath, savedFirst[0]);
    assert.equal(fs.readdirSync(currentMonthDir(baseDir)).length, 1);
    assert.equal(fs.readFileSync(savedFirst[0]).toString('base64'), a);
    assert.match(path.basename(savedFirst[0]), /^img_[0-9a-f]{16}\.png$/);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('两张不同的图分别落盘，文件名按内容哈希区分', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-img-'));
  try {
    const a = Buffer.from('screenshot-content-a').toString('base64');
    const b = Buffer.from('screenshot-content-b').toString('base64');
    const saved = saveBase64ImagesToDiskAndExtractPaths([...imageMessage(a), ...imageMessage(b)], baseDir);
    assert.equal(saved.length, 2);
    assert.notEqual(saved[0], saved[1]);
    assert.equal(fs.readdirSync(currentMonthDir(baseDir)).length, 2);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
