import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FeishuMonitorDb } from '../../server/src/feishu/monitor_db.ts';

function tempPath(): string {
  return path.join(os.tmpdir(), 'zombie-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db');
}

test('打开监控库不再自动清理；中断恢复只由任务拥有者显式触发', () => {
  const p = tempPath();
  try {
    const a = new FeishuMonitorDb(p);
    a.createTask({ id: 'z1', chatId: 'oc', requesterOpenId: 'ou', originMessageId: 'm', triggerMessageId: 't' });
    a.markRunning('z1');
    // 把 started_at 改成很久以前，模拟上一次进程遗留下来的
    a.db.prepare("UPDATE feishu_tasks SET started_at = ? WHERE id = 'z1'").run(new Date(Date.now() - 600_000).toISOString());
    a.close();

    // 服务端(8600)只是打开同一个共享库，绝不能顺手把别人的任务判成中断。
    const b = new FeishuMonitorDb(p);
    const untouched = b.listTasks()[0];
    assert.equal(untouched.status, 'running', '仅打开库不应改动任务状态');
    assert.equal(untouched.error_text, null);

    // 飞书通道进程自己才知道哪些任务属于它，由它显式标记中断。
    const recovered = b.recoverInterruptedTasks();
    assert.equal(recovered, 1, '通道进程启动时应回收自己上次遗留的任务');
    const row = b.listTasks()[0];
    assert.equal(row.status, 'failed', '上次遗留的 running 应被标记为中断');
    assert.match(String(row.error_text), /重启/);
    b.close();
  } finally { fs.rmSync(p, { force: true }); }
});

test('刚启动的任务不会被同一个库的另一次打开误杀', () => {
  const p = tempPath();
  try {
    const a = new FeishuMonitorDb(p);
    a.createTask({ id: 'live', chatId: 'oc', requesterOpenId: 'ou', originMessageId: 'm', triggerMessageId: 't' });
    a.markRunning('live');   // started_at = 现在
    // 服务端进程此时也打开同一个库（两个进程共用），不能把通道正在跑的任务清掉
    const b = new FeishuMonitorDb(p);
    const row = b.listTasks()[0];
    assert.equal(row.status, 'running', '刚刚开始的任务必须保留，否则会误判为中断');
    a.close(); b.close();
  } finally { fs.rmSync(p, { force: true }); }
});
