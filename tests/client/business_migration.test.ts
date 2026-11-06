import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BusinessSessions } from '../../src/config/business_sessions.ts';
import type { PublicSession } from '@xkang/agent-core/public';

test('仅在校验迁移回执并保存公开副本后清理旧库，失败保留唯一原文且不暴露', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xkang-migration-'));
  const legacyPath = path.join(dir, 'sessions.db');
  const legacy = new DatabaseSync(legacyPath);
  const secret = 'INTERNAL_MIGRATION_CANARY_PRIVATE_SQL';
  legacy.exec('PRAGMA journal_mode=WAL; CREATE TABLE web_sessions(id TEXT PRIMARY KEY,messages_json TEXT)');
  legacy.prepare('INSERT INTO web_sessions VALUES (?, ?)').run('old1', JSON.stringify([{ role: 'tool', content: secret }])); legacy.close();
  const cache = new BusinessSessions(dir);
  const session: PublicSession = { id: 'public1', title: '资料核对', createdAt: '', lastActiveAt: '', status: 'idle', turns: [{ id: 't1', userText: '联系电话0013812345678', answer: { conclusion: '历史记录已归档。', businessData: [{ label: '证件号码', value: '11010119900101001X' }], evidenceSummary: [], customerReply: '', pendingItems: [], reviewStatus: 'unreviewed', traceId: 'r1' } }] };
  try {
    assert.equal((await cache.migrate({ migrate: async () => { throw new Error('offline'); } })).complete, false);
    assert.deepEqual(cache.list(), []);
    const intact = new DatabaseSync(legacyPath); assert.ok(JSON.stringify(intact.prepare('SELECT * FROM web_sessions').all()).includes(secret)); intact.close();
    assert.equal((await cache.migrate({ migrate: async (_id, _hash) => ({ session, hash: 'incorrect' }) })).complete, false);
    let uploads = 0;
    assert.equal((await cache.migrate({ migrate: async (_id, hash, source) => { uploads++; assert.ok(JSON.stringify(source).includes(secret)); return { session, hash }; } })).complete, true);
    assert.equal((await cache.migrate({ migrate: async () => { throw new Error('already migrated'); } })).complete, true);
    assert.equal(uploads, 1);
    assert.ok(JSON.stringify(cache.list()).includes('11010119900101001X'));
    assert.equal(JSON.stringify(cache.list()).includes(secret), false);
    for (const name of fs.readdirSync(dir)) assert.equal(fs.readFileSync(path.join(dir, name)).includes(Buffer.from(secret)), false, name);
  } finally { cache.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
