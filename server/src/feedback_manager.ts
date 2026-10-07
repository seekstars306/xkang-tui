/**
 * FeedbackManager - 基于 SQLite 统一存储的客服排障错误反馈管理器
 */
import { DatabaseSync } from 'node:sqlite';
import { AppDatabase } from './db.js';

export interface FeedbackRecord {
  id: string;
  createdAt: string;
  userName: string;
  userToken?: string;
  feedbackType: string;
  content: string;
  sessionId?: string;
  sessionTitle?: string;
  context?: unknown[];
  status: 'pending' | 'investigating' | 'resolved';
  resolutionNotes?: string;
}

export class FeedbackManager {
  private db: DatabaseSync;

  constructor(dbOrPath?: DatabaseSync | string) {
    if (dbOrPath && typeof dbOrPath === 'object' && 'prepare' in dbOrPath) {
      this.db = dbOrPath;
    } else {
      this.db = AppDatabase.getInstance().db;
    }
  }

  public createFeedback(data: {
    userName: string;
    userToken?: string;
    feedbackType: string;
    content: string;
    sessionId?: string;
    sessionTitle?: string;
    context?: unknown[];
  }): FeedbackRecord {
    const id = `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const createdAt = new Date().toISOString();
    const status = 'pending';

    this.db.prepare(`
      INSERT INTO cs_feedbacks (
        id, created_at, user_name, user_token, feedback_type, content,
        session_id, session_title, context, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      createdAt,
      data.userName,
      data.userToken || null,
      data.feedbackType,
      data.content,
      data.sessionId || null,
      data.sessionTitle || null,
      data.context ? JSON.stringify(data.context) : null,
      status
    );

    return {
      id,
      createdAt,
      userName: data.userName,
      userToken: data.userToken,
      feedbackType: data.feedbackType,
      content: data.content,
      sessionId: data.sessionId,
      sessionTitle: data.sessionTitle,
      context: data.context,
      status,
    };
  }

  public listFeedbacks(limit = 100, status?: string): FeedbackRecord[] {
    let sql = `
      SELECT id, created_at as createdAt, user_name as userName, user_token as userToken,
             feedback_type as feedbackType, content, session_id as sessionId,
             session_title as sessionTitle, context, status, resolution_notes as resolutionNotes
      FROM cs_feedbacks
    `;
    const params: (string | number)[] = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      userName: r.userName,
      userToken: r.userToken || undefined,
      feedbackType: r.feedbackType,
      content: r.content,
      sessionId: r.sessionId || undefined,
      sessionTitle: r.sessionTitle || undefined,
      context: r.context ? JSON.parse(r.context) : undefined,
      status: r.status,
      resolutionNotes: r.resolutionNotes || undefined,
    }));
  }

  public updateStatus(id: string, status: 'pending' | 'investigating' | 'resolved', notes?: string): boolean {
    const res = this.db.prepare(`
      UPDATE cs_feedbacks
      SET status = ?, resolution_notes = ?
      WHERE id = ?
    `).run(status, notes || null, id);
    return res.changes > 0;
  }
}
