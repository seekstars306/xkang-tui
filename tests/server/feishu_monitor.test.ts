import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeishuMonitorDb } from '../../server/src/feishu/monitor_db.ts';

function tempDb(): { db: FeishuMonitorDb; cleanup: () => void } {
  const p = path.join(os.tmpdir(), 'monitor-test-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db');
  return { db: new FeishuMonitorDb(p), cleanup: () => { try { fs.rmSync(p, { force: true }); } catch {} } };
}

test('任务全生命周期可记录并读回', () => {
  const { db, cleanup } = tempDb();
  try {
    db.createTask({ id: 't1', chatId: 'oc_1', chatName: '测试群', requesterOpenId: 'ou_1', requesterName: '张三', originMessageId: 'om_a', triggerMessageId: 'om_b' });
    assert.equal(db.listTasks()[0].status, 'queued');
    db.markRunning('t1');
    assert.equal(db.listTasks()[0].status, 'running');
    db.saveInput('t1', '清洗后的输入', 2, 10, 14);
    db.finish('t1', JSON.stringify({ text: '结论' }), 'reviewed');
    const row = db.listTasks()[0];
    assert.equal(row.status, 'done');
    assert.equal(row.attachment_count, 2);
    assert.equal(row.kept_count, 10);
    assert.equal(row.window_count, 14);
    assert.ok(row.duration_ms !== null, '完成时应算出耗时');
  } finally { cleanup(); }
});

test('每一步都按顺序留痕，且能读回完整过程', () => {
  const { db, cleanup } = tempDb();
  try {
    db.createTask({ id: 't2', chatId: 'oc_1', requesterOpenId: 'ou_1', originMessageId: 'om_a', triggerMessageId: 'om_b' });
    db.addStep('t2', 'event', '收到 @');
    db.addStep('t2', 'context', '取上下文');
    db.addStep('t2', 'model', '调用模型');
    const got = db.getTask('t2');
    assert.equal(got!.steps.length, 3);
    assert.deepEqual(got!.steps.map(s => s.seq), [1, 2, 3], 'seq 必须递增');
    assert.equal(got!.steps[0].kind, 'event');
  } finally { cleanup(); }
});

test('失败也留痕，并记录原因', () => {
  const { db, cleanup } = tempDb();
  try {
    db.createTask({ id: 't3', chatId: 'oc_1', requesterOpenId: 'ou_1', originMessageId: 'om_a', triggerMessageId: 'om_b' });
    db.markRunning('t3');
    db.fail('t3', '模型超时');
    const row = db.listTasks()[0];
    assert.equal(row.status, 'failed');
    assert.equal(row.error_text, '模型超时');
  } finally { cleanup(); }
});

test('按状态、群组、客服筛选', () => {
  const { db, cleanup } = tempDb();
  try {
    db.createTask({ id: 'a', chatId: 'oc_1', requesterOpenId: 'ou_1', originMessageId: 'm', triggerMessageId: 't' });
    db.createTask({ id: 'b', chatId: 'oc_2', requesterOpenId: 'ou_2', originMessageId: 'm', triggerMessageId: 't' });
    db.markRunning('a');
    assert.equal(db.listTasks({ status: 'running' }).length, 1);
    assert.equal(db.listTasks({ chatId: 'oc_2' }).length, 1);
    assert.equal(db.listTasks({ requester: 'ou_1' }).length, 1);
    assert.equal(db.listTasks().length, 2);
  } finally { cleanup(); }
});

test('统计给出运行中/排队/今日完成', () => {
  const { db, cleanup } = tempDb();
  try {
    // 三个任务：x 运行中、y 已完成、z 仍在排队
    db.createTask({ id: 'x', chatId: 'oc', requesterOpenId: 'ou', originMessageId: 'm', triggerMessageId: 't' });
    db.createTask({ id: 'y', chatId: 'oc', requesterOpenId: 'ou', originMessageId: 'm', triggerMessageId: 't' });
    db.createTask({ id: 'z', chatId: 'oc', requesterOpenId: 'ou', originMessageId: 'm', triggerMessageId: 't' });
    db.markRunning('x');
    db.finish('y', '{}', null);
    const s = db.stats();
    assert.equal(s.running, 1);
    assert.equal(s.queued, 1, '只有从未开始过的 z 算排队');
    assert.equal(s.todayDone, 1);
    assert.equal(s.total, 3);
  } finally { cleanup(); }
});

test('输入文本完整保存，不被截断', () => {
  const { db, cleanup } = tempDb();
  try {
    const long = 'x'.repeat(20000);
    db.createTask({ id: 'z', chatId: 'oc', requesterOpenId: 'ou', originMessageId: 'm', triggerMessageId: 't' });
    db.saveInput('z', long, 0, 1, 1);
    assert.equal(db.getTask('z')!.task.input_text!.length, 20000, '详细输出要能长期追溯，输入不能截断存储');
  } finally { cleanup(); }
});
