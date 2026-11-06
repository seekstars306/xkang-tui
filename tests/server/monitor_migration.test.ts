import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FeishuMonitorDb } from '../../server/src/feishu/monitor_db.ts';

function tempPath(): string {
  return path.join(os.tmpdir(), 'monitor-mig-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db');
}

test('旧库缺 origin_author_open_id 时，启动会自动补列并可写入', () => {
  const p = tempPath();
  try {
    // 先造一个“旧版本”的库：没有 origin_author_open_id
    const old = new DatabaseSync(p);
    old.exec(`
      CREATE TABLE feishu_tasks (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, chat_name TEXT,
        requester_open_id TEXT NOT NULL, requester_name TEXT,
        origin_message_id TEXT NOT NULL, trigger_message_id TEXT NOT NULL,
        status TEXT NOT NULL, queued_at TEXT NOT NULL, started_at TEXT,
        finished_at TEXT, duration_ms INTEGER, input_text TEXT,
        attachment_count INTEGER DEFAULT 0, answer_json TEXT, error_text TEXT,
        kept_count INTEGER, window_count INTEGER, review_status TEXT
      );
    `);
    old.close();

    // 用新代码打开同一个文件，应自动补列
    const db = new FeishuMonitorDb(p);
    db.createTask({
      id: 'x', chatId: 'oc', requesterOpenId: 'ou_b',
      originAuthorOpenId: 'ou_a', originMessageId: 'm', triggerMessageId: 't',
    });
    const row = db.listTasks()[0];
    assert.equal(row.origin_author_open_id, 'ou_a', '旧库补列后新字段必须能写入');
    db.close();
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('迁移是幂等的，重复打开不会报错', () => {
  const p = tempPath();
  try {
    const a = new FeishuMonitorDb(p);
    a.createTask({ id: 'y', chatId: 'oc', requesterOpenId: 'ou', originMessageId: 'm', triggerMessageId: 't' });
    // 同一个文件再开一次，应不抛错
    const b = new FeishuMonitorDb(p);
    assert.equal(b.listTasks().length, 1);
    a.close(); b.close();
  } finally {
    fs.rmSync(p, { force: true });
  }
});
