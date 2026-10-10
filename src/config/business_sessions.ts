import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PublicSession } from '@xkang/agent-core/public';
import { BusinessClient, publicSession } from '../adapters/business_client.js';

/** Public cache only. Legacy raw history is read solely by the acknowledged migration path. */
export class BusinessSessions {
  private db: DatabaseSync;
  private legacyPath: string;
  constructor(directory = path.join(os.homedir(), '.xkang')) {
    fs.mkdirSync(directory, { recursive: true });
    this.legacyPath = path.join(directory, 'sessions.db');
    this.db = new DatabaseSync(path.join(directory, 'business-sessions.db'));
    this.db.exec('PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS public_sessions (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
  }
  save(session: PublicSession) {
    const safe = publicSession(session);
    this.db.prepare('INSERT INTO public_sessions VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET content=excluded.content').run(safe.id, JSON.stringify(safe));
  }
  list(): PublicSession[] { return (this.db.prepare('SELECT content FROM public_sessions').all() as any[]).map(row => publicSession(JSON.parse(row.content))); }
  remove(id: string) { this.db.prepare('DELETE FROM public_sessions WHERE id=?').run(id); }
  async migrate(client: Pick<BusinessClient, 'migrate'>): Promise<{ complete: boolean; migrated: number }> {
    if (!fs.existsSync(this.legacyPath)) return { complete: true, migrated: 0 };
    const legacy = new DatabaseSync(this.legacyPath);
    let migrated = 0;
    try {
      if (!legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='web_sessions'").get()) return { complete: true, migrated };
      legacy.exec('PRAGMA secure_delete=ON');
      const rows = legacy.prepare('SELECT id, messages_json FROM web_sessions').all() as Array<{ id: string; messages_json: string }>;
      for (const row of rows) {
        const source = { messages: JSON.parse(row.messages_json) };
        const hash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
        const migratedResult = await client.migrate(row.id, hash, source);
        if (migratedResult.hash !== hash) throw new Error('Migration hash mismatch');
        this.save(migratedResult.session);
        legacy.prepare('DELETE FROM web_sessions WHERE id=? AND messages_json=?').run(row.id, row.messages_json);
        migrated++;
      }
      legacy.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
      const remaining = legacy.prepare('SELECT count(*) AS n FROM web_sessions').get() as { n: number };
      return { complete: remaining.n === 0, migrated };
    } catch { return { complete: false, migrated }; }
    finally { legacy.close(); }
  }
  close() { this.db.close(); }
}
