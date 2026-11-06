import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeishuMonitorDb } from '../../server/src/feishu/monitor_db.ts';
import { hashToken } from '../../server/src/feishu/share.ts';

function tempPath(): string {
  return path.join(os.tmpdir(), 'share-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db');
}

test('分享令牌只存哈希，库里没有明文', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    const token = 'plaintext-token-should-not-be-stored';
    db.createShare({ tokenHash: hashToken(token), taskId: 't1', expiresAt: new Date(Date.now() + 86400_000).toISOString() });
    const rows = db.db.prepare('SELECT token_hash FROM feishu_shares').all() as Array<{ token_hash: string }>;
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, token, '不能存明文 token');
    assert.equal(rows[0].token_hash, hashToken(token));
    db.close();
  } finally { fs.rmSync(p, { force: true }); }
});

test('有效期内可解析，过期后拒绝', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    const token = 'tok-ok';
    db.createShare({ tokenHash: hashToken(token), taskId: 't2', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal(db.resolveShare(hashToken(token))?.taskId, 't2');
    // 用一个“未来”的时间点检查过期
    assert.equal(db.resolveShare(hashToken(token), new Date(Date.now() + 7200_000)), null);
    db.close();
  } finally { fs.rmSync(p, { force: true }); }
});

test('撤销后立即失效', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    const token = 'tok-revoke';
    db.createShare({ tokenHash: hashToken(token), taskId: 't3', expiresAt: new Date(Date.now() + 86400_000).toISOString() });
    db.db.prepare('UPDATE feishu_shares SET revoked = 1 WHERE task_id = ?').run('t3');
    assert.equal(db.resolveShare(hashToken(token)), null);
    db.close();
  } finally { fs.rmSync(p, { force: true }); }
});

test('一份答案只接受一次评价，第二个提交被拒绝', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    const first = db.submitFeedback({ taskId: 't4', vote: 'up' });
    assert.equal(first.ok, true);
    const second = db.submitFeedback({ taskId: 't4', vote: 'down', comment: '想改成差评' });
    assert.equal(second.ok, false, '首个评价提交后必须锁定');
    assert.equal(db.getFeedback('t4')?.vote, 'up', '原有评价不能被覆盖');
    db.close();
  } finally { fs.rmSync(p, { force: true }); }
});

test('点踩可以不填说明', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    const r = db.submitFeedback({ taskId: 't5', vote: 'down', comment: null });
    assert.equal(r.ok, true, '说明是可选的，不能因为没填就拒绝');
    assert.equal(db.getFeedback('t5')?.vote, 'down');
    assert.equal(db.getFeedback('t5')?.comment, null);
    db.close();
  } finally { fs.rmSync(p, { force: true }); }
});

test('分享页只暴露公开字段，不含清洗前输入与步骤', () => {
  const src = fs.readFileSync('server/src/feishu/share.ts', 'utf8');
  // 响应体构造里不能出现 input_text / steps
  const jsonBlock = src.slice(src.indexOf('res.json({'), src.indexOf('feedback: db().getFeedback'));
  assert.doesNotMatch(jsonBlock, /input_text/, '不能把清洗前输入发给公网');
  assert.doesNotMatch(jsonBlock, /steps/, '不能把排查步骤发给公网');
});
