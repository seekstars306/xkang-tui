import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeishuMonitorDb } from '../../server/src/feishu/monitor_db.ts';

function tempPath(): string {
  return path.join(os.tmpdir(), 'monitor-orphan-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db');
}

test('给不存在的任务写步骤会被跳过，不产生孤儿记录', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    // 不建任务，直接写步骤
    db.addStep('nonexistent-1', 'event', '不该被写入');
    const n = (db.db.prepare('SELECT COUNT(*) n FROM feishu_steps').get() as { n: number }).n;
    assert.equal(n, 0, '任务不存在时不能写步骤，否则事后要手工清理');
    db.close();
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('正常任务仍能写入步骤并保持顺序', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    db.createTask({ id: 'ok-1', chatId: 'oc', requesterOpenId: 'ou', originMessageId: 'm', triggerMessageId: 't' });
    db.addStep('ok-1', 'event', '第一步');
    db.addStep('ok-1', 'context', '第二步');
    const steps = db.getTask('ok-1')!.steps;
    assert.equal(steps.length, 2);
    assert.deepEqual(steps.map(s => s.seq), [1, 2]);
    db.close();
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('打开旧库时自动清理历史孤儿步骤', () => {
  const p = tempPath();
  try {
    // 先写一条任务 + 步骤，再手工删掉任务，制造孤儿
    const a = new FeishuMonitorDb(p);
    a.createTask({ id: 'gone-1', chatId: 'oc', requesterOpenId: 'ou', originMessageId: 'm', triggerMessageId: 't' });
    a.addStep('gone-1', 'event', 'x');
    a.db.prepare('DELETE FROM feishu_tasks WHERE id = ?').run('gone-1');
    a.close();

    // 重新打开时应清掉孤儿
    const b = new FeishuMonitorDb(p);
    const n = (b.db.prepare('SELECT COUNT(*) n FROM feishu_steps').get() as { n: number }).n;
    assert.equal(n, 0, '启动时应清理历史孤儿');
    b.close();
  } finally {
    fs.rmSync(p, { force: true });
  }
});
