import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Message } from '@xkang/agent-core';
import type { PublicSession } from '@xkang/agent-core/public';

export class AgentStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      private_json TEXT NOT NULL, public_json TEXT NOT NULL,
      migration_id TEXT, migration_hash TEXT, UNIQUE(owner_id, migration_id)
    ); CREATE INDEX IF NOT EXISTS agent_sessions_owner ON agent_sessions(owner_id, updated_at);`);
    // R2：冻结续查状态（旧库平滑加列，不引入迁移框架）
    const columns = db.prepare('PRAGMA table_info(agent_sessions)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'run_state')) db.exec('ALTER TABLE agent_sessions ADD COLUMN run_state TEXT');
    if (!columns.some(column => column.name === 'frozen_answer')) db.exec('ALTER TABLE agent_sessions ADD COLUMN frozen_answer TEXT');
  }
  create(owner: string): PublicSession {
    const now = new Date().toISOString();
    const session: PublicSession = { id: `s_${randomUUID().replaceAll('-', '')}`, title: '新排障会话', createdAt: now, lastActiveAt: now, status: 'idle', turns: [] };
    this.db.prepare('INSERT INTO agent_sessions (id, owner_id, created_at, updated_at, private_json, public_json) VALUES (?, ?, ?, ?, ?, ?)').run(session.id, owner, now, now, '[]', JSON.stringify(session));
    return session;
  }
  load(owner: string, id: string): { public: PublicSession; messages: Message[] } | null {
    const row = this.db.prepare('SELECT private_json, public_json FROM agent_sessions WHERE id=? AND owner_id=?').get(id, owner) as any;
    return row ? { public: JSON.parse(row.public_json), messages: JSON.parse(row.private_json) } : null;
  }
  list(owner: string): PublicSession[] {
    return (this.db.prepare('SELECT public_json FROM agent_sessions WHERE owner_id=? ORDER BY updated_at DESC LIMIT 100').all(owner) as any[]).map(row => JSON.parse(row.public_json));
  }
  save(owner: string, session: PublicSession, messages: Message[]): void {
    const result = this.db.prepare('UPDATE agent_sessions SET private_json=?, public_json=?, updated_at=? WHERE id=? AND owner_id=?').run(JSON.stringify(messages), JSON.stringify(session), session.lastActiveAt, session.id, owner);
    if (!result.changes) throw new Error('Session no longer exists');
  }
  delete(owner: string, id: string): boolean {
    return Boolean(this.db.prepare('DELETE FROM agent_sessions WHERE id=? AND owner_id=?').run(id, owner).changes);
  }
  adminRead(id: string): unknown {
    const row = this.db.prepare('SELECT owner_id, private_json, public_json FROM agent_sessions WHERE id=?').get(id) as any;
    return row ? { ownerId: row.owner_id, messages: JSON.parse(row.private_json), session: JSON.parse(row.public_json) } : null;
  }
  migration(owner: string, migrationId: string): { session: PublicSession; hash: string } | null {
    const row = this.db.prepare('SELECT public_json, migration_hash FROM agent_sessions WHERE owner_id=? AND migration_id=?').get(owner, migrationId) as any;
    return row ? { session: JSON.parse(row.public_json), hash: row.migration_hash } : null;
  }
  markMigration(owner: string, id: string, migrationId: string, hash: string) {
    this.db.prepare('UPDATE agent_sessions SET migration_id=?, migration_hash=? WHERE id=? AND owner_id=?').run(migrationId, hash, id, owner);
  }
  /** R2：持久化冻结时的运行状态与已核实答案（续查的恢复点） */
  saveRunState(owner: string, id: string, runState: unknown, frozenAnswer: string | null): void {
    this.db.prepare('UPDATE agent_sessions SET run_state=?, frozen_answer=? WHERE id=? AND owner_id=?').run(JSON.stringify(runState), frozenAnswer, id, owner);
  }
  loadRunState(owner: string, id: string): { runState: any; frozenAnswer: string | null } | null {
    const row = this.db.prepare('SELECT run_state, frozen_answer FROM agent_sessions WHERE id=? AND owner_id=?').get(id, owner) as any;
    if (!row?.run_state) return null;
    return { runState: JSON.parse(row.run_state), frozenAnswer: row.frozen_answer ?? null };
  }
  clearRunState(owner: string, id: string): void {
    this.db.prepare('UPDATE agent_sessions SET run_state=NULL, frozen_answer=NULL WHERE id=? AND owner_id=?').run(id, owner);
  }
  static hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
