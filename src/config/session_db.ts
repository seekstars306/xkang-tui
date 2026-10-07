/**
 * 小康排障客户端本地会话 SQLite 永久持久化模块
 * 存储路径: ~/.xkang/sessions.db (跨升级、重启、进程退出永久保留)
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Message } from '../types/index.js';

export interface PersistedSession {
  id: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  messages: Message[];
}

export interface SessionListItem {
  id: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
  lastSnippet: string;
}

export class SessionDatabase {
  private static instance: SessionDatabase | null = null;
  private db: DatabaseSync;

  constructor(customPath?: string) {
    const configDir = path.join(os.homedir(), '.xkang');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    const dbPath = customPath || path.join(configDir, 'sessions.db');
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.initSchema();
  }

  public static getInstance(customPath?: string): SessionDatabase {
    if (!SessionDatabase.instance) {
      SessionDatabase.instance = new SessionDatabase(customPath);
    }
    return SessionDatabase.instance;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        messages_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_active ON web_sessions (last_active_at DESC);
    `);
  }

  public saveSession(session: {
    id: string;
    title: string;
    createdAt: string;
    lastActiveAt: string;
    messages: Message[];
  }): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO web_sessions (id, title, created_at, last_active_at, messages_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          last_active_at = excluded.last_active_at,
          messages_json = excluded.messages_json;
      `);
      stmt.run(
        session.id,
        session.title,
        session.createdAt,
        session.lastActiveAt,
        JSON.stringify(session.messages)
      );
    } catch (err) {
      console.error('[SessionDatabase] 保存会话失败:', err);
    }
  }

  public getSession(id: string): PersistedSession | null {
    try {
      const stmt = this.db.prepare(
        'SELECT id, title, created_at, last_active_at, messages_json FROM web_sessions WHERE id = ?'
      );
      const row = stmt.get(id) as any;
      if (!row) return null;
      return {
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        lastActiveAt: row.last_active_at,
        messages: JSON.parse(row.messages_json || '[]'),
      };
    } catch (err) {
      console.error('[SessionDatabase] 获取会话失败:', err);
      return null;
    }
  }

  public listSessions(): SessionListItem[] {
    try {
      const stmt = this.db.prepare(
        'SELECT id, title, created_at, last_active_at, messages_json FROM web_sessions ORDER BY last_active_at DESC LIMIT 100'
      );
      const rows = stmt.all() as any[];
      return rows.map((r) => {
        let msgs: Message[] = [];
        try {
          msgs = JSON.parse(r.messages_json || '[]');
        } catch {}
        const userOrAssistantMsgs = msgs.filter((m) => m.role !== 'system');
        let lastSnippet = '';
        if (userOrAssistantMsgs.length > 0) {
          const last = userOrAssistantMsgs[userOrAssistantMsgs.length - 1];
          if (typeof last.content === 'string') {
            lastSnippet = last.content.slice(0, 60);
          } else if (Array.isArray(last.content)) {
            const txt = last.content.find((p) => p.type === 'text');
            lastSnippet = txt && 'text' in txt ? txt.text.slice(0, 60) : '[图片附件]';
          }
        }
        return {
          id: r.id,
          title: r.title,
          createdAt: r.created_at,
          lastActiveAt: r.last_active_at,
          messageCount: userOrAssistantMsgs.length,
          lastSnippet,
        };
      });
    } catch (err) {
      console.error('[SessionDatabase] 读取会话列表失败:', err);
      return [];
    }
  }

  public deleteSession(id: string): boolean {
    try {
      const stmt = this.db.prepare('DELETE FROM web_sessions WHERE id = ?');
      const info = stmt.run(id);
      return (info?.changes || 0) > 0;
    } catch (err) {
      console.error('[SessionDatabase] 删除会话失败:', err);
      return false;
    }
  }
}
