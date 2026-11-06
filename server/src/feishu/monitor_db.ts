import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { FEISHU_PATHS } from './runtime_paths.js';

/**
 * 飞书任务台账。
 *
 * 单独一个 SQLite 文件（feishu_monitor.db），不动 xkang 主库：
 * - 主库的 agent_sessions 是员工会话模型，飞书任务有群/客服/排队等额外语义；
 * - 监控要做到“详细输出不过期”，与主库的清理策略解耦更安全。
 *
 * 记录的是可复核的原始材料：清洗后的输入、每条工具调用、最终答案，
 * 不记录模型内部推理（那是不可复现的，记了也当不了证据）。
 */

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'timeout';

export interface TaskRow {
  id: string;
  chat_id: string;
  chat_name: string | null;
  requester_open_id: string;
  requester_name: string | null;
  /** 原问题作者；与 requester 不同说明是“A 发问题、B 来 @” */
  origin_author_open_id: string | null;
  origin_message_id: string;
  trigger_message_id: string;
  status: TaskStatus;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  /** 清洗后的输入（给模型看的完整上下文） */
  input_text: string | null;
  /** 附带的图片数量 */
  attachment_count: number;
  /** 答案 JSON */
  answer_json: string | null;
  /** 失败原因 */
  error_text: string | null;
  /** 窗口统计：保留条数 / 窗口条数 */
  kept_count: number | null;
  window_count: number | null;
  /** 复核状态 */
  review_status: string | null;
}

export interface StepRow {
  id: number;
  task_id: string;
  seq: number;
  at: string;
  kind: string;
  summary: string;
  detail: string | null;
}

export class FeishuMonitorDb {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feishu_tasks (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        chat_name TEXT,
        requester_open_id TEXT NOT NULL,
        requester_name TEXT,
        origin_author_open_id TEXT,
        origin_message_id TEXT NOT NULL,
        trigger_message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER,
        input_text TEXT,
        attachment_count INTEGER DEFAULT 0,
        answer_json TEXT,
        error_text TEXT,
        kept_count INTEGER,
        window_count INTEGER,
        review_status TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_feishu_tasks_queued ON feishu_tasks(queued_at DESC);
      CREATE INDEX IF NOT EXISTS idx_feishu_tasks_status ON feishu_tasks(status);
      CREATE TABLE IF NOT EXISTS feishu_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_feishu_steps_task ON feishu_steps(task_id, seq);
      -- 分享链接：token 只存哈希，原文只在生成时返回一次
      CREATE TABLE IF NOT EXISTS feishu_shares (
        token_hash TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_feishu_shares_task ON feishu_shares(task_id);
      -- 一个问题（以原消息为标识）跨多轮排查的状态。
      -- 客服要求"继续"时，要复用同一个 agent 会话，把之前查到的证据接着用，
      -- 而不是从零重查；last_reply_message_id 用来认出"回复的是不是我们的结论"。
      CREATE TABLE IF NOT EXISTS feishu_issues (
        origin_message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        requester_open_id TEXT NOT NULL,
        session_id TEXT,
        last_reply_message_id TEXT,
        rounds INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feishu_issues_reply ON feishu_issues(last_reply_message_id);
      -- 一个问题的机器人在群里发过的每一条消息。
      -- 只记 last_reply_message_id 时，多轮问题只有最后一条能对上：
      -- 客服引用第一轮的那条结论就被判成"查不到对应原问题"，然后什么也不做。
      CREATE TABLE IF NOT EXISTS feishu_issue_replies (
        reply_message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        origin_message_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feishu_issue_replies_origin ON feishu_issue_replies(origin_message_id);
      -- 评价：一份答案只接受一次，首个提交后锁定
      CREATE TABLE IF NOT EXISTS feishu_feedback (
        task_id TEXT PRIMARY KEY,
        vote TEXT NOT NULL,
        comment TEXT,
        created_at TEXT NOT NULL,
        actor_open_id TEXT,
        answer_version TEXT
      );
    `);
    // 兼容已有库：CREATE TABLE IF NOT EXISTS 不会补列，新增列必须显式 ALTER。
    // 缺了迁移会让写入整条失败（旧库上遇到过 origin_author_open_id 不存在）。
    this.ensureColumn('feishu_tasks', 'origin_author_open_id', 'TEXT');
    // 这个问题上一轮是不是"预算用尽被冻结"。
    // 客服直接 @ 说"继续"时要靠它找到该续哪一条，不必非要引用结论消息。
    this.ensureColumn('feishu_issues', 'frozen', 'INTEGER NOT NULL DEFAULT 0');
    // 中断任务恢复已移出 migrate：改由 recoverInterruptedTasks() 显式调用。
    // 监控库由服务端(8600)与飞书通道共用，构造时清理会把另一进程正在跑的任务误判失败。
    // 步骤必须挂在存在的任务上。之前任务写入失败时步骤照样写进去，
    // 结果留下一批 task_id 找不到任务的孤儿记录，只能事后手工清。
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      DELETE FROM feishu_steps WHERE task_id NOT IN (SELECT id FROM feishu_tasks);
    `);
  }

  /**
   * 标记“指定时刻之前就已开始”的中断任务，返回更新条数。
   * 只应由任务拥有者（飞书通道进程）显式调用：
   * 服务端(8600)与飞书通道共用同一个库文件，
   * 若在构造时无条件清理，会把另一进程正在跑的任务误判成失败。
   */
  recoverInterruptedTasks(options: { olderThanMs?: number } = {}): number {
    try {
      const startedBefore = new Date(Date.now() - (options.olderThanMs ?? 3_000)).toISOString();
      return this.db.prepare(
        `UPDATE feishu_tasks SET status='failed', error_text=?, finished_at=?
         WHERE status IN ('running','queued') AND (started_at IS NULL OR started_at < ?)`,
      ).run('进程重启导致中断', new Date().toISOString(), startedBefore).changes as number;
    } catch { return 0; }
  }

  /** 记录步骤；任务不存在时直接跳过，避免产生孤儿 */
  private stepSafe(taskId: string, kind: string, summary: string, detail: string | null): void {
    const exists = this.db.prepare('SELECT 1 AS ok FROM feishu_tasks WHERE id = ?').get(taskId);
    if (!exists) return;
    const next = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM feishu_steps WHERE task_id=?').get(taskId) as { n: number };
    this.db.prepare('INSERT INTO feishu_steps (task_id, seq, at, kind, summary, detail) VALUES (?,?,?,?,?,?)')
      .run(taskId, next.n, new Date().toISOString(), kind, summary, detail);
  }

  /** 幂等补列：已存在则跳过，供表结构演进使用 */
  private ensureColumn(table: string, column: string, ddlType: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    if (cols.some(c => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  }

  createTask(input: {
    id: string; chatId: string; chatName?: string | null;
    requesterOpenId: string; requesterName?: string | null;
    originAuthorOpenId?: string | null;
    originMessageId: string; triggerMessageId: string;
  }): void {
    this.db.prepare(`
      INSERT INTO feishu_tasks (id, chat_id, chat_name, requester_open_id, requester_name,
        origin_author_open_id, origin_message_id, trigger_message_id, status, queued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
    `).run(input.id, input.chatId, input.chatName ?? null, input.requesterOpenId, input.requesterName ?? null,
      input.originAuthorOpenId ?? null, input.originMessageId, input.triggerMessageId, new Date().toISOString());
  }

  markRunning(taskId: string): void {
    this.db.prepare(`UPDATE feishu_tasks SET status='running', started_at=? WHERE id=?`)
      .run(new Date().toISOString(), taskId);
  }

  saveInput(taskId: string, inputText: string, attachmentCount: number, kept: number, window: number): void {
    this.db.prepare(`UPDATE feishu_tasks SET input_text=?, attachment_count=?, kept_count=?, window_count=? WHERE id=?`)
      .run(inputText, attachmentCount, kept, window, taskId);
  }

  finish(taskId: string, answerJson: string, reviewStatus: string | null): void {
    const now = new Date().toISOString();
    const row = this.db.prepare('SELECT started_at FROM feishu_tasks WHERE id=?').get(taskId) as { started_at?: string } | undefined;
    const duration = row?.started_at ? Date.now() - new Date(row.started_at).getTime() : null;
    this.db.prepare(`UPDATE feishu_tasks SET status='done', finished_at=?, duration_ms=?, answer_json=?, review_status=? WHERE id=?`)
      .run(now, duration, answerJson, reviewStatus, taskId);
  }

  fail(taskId: string, errorText: string, status: TaskStatus = 'failed'): void {
    const now = new Date().toISOString();
    const row = this.db.prepare('SELECT started_at FROM feishu_tasks WHERE id=?').get(taskId) as { started_at?: string } | undefined;
    const duration = row?.started_at ? Date.now() - new Date(row.started_at).getTime() : null;
    this.db.prepare(`UPDATE feishu_tasks SET status=?, finished_at=?, duration_ms=?, error_text=? WHERE id=?`)
      .run(status, now, duration, errorText, taskId);
  }

  addStep(taskId: string, kind: string, summary: string, detail?: string | null): void {
    this.stepSafe(taskId, kind, summary, detail ?? null);
  }

  listTasks(filter: { status?: string; chatId?: string; requester?: string; limit?: number; offset?: number } = {}): TaskRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    if (filter.chatId) { where.push('chat_id = ?'); params.push(filter.chatId); }
    if (filter.requester) { where.push('requester_open_id = ?'); params.push(filter.requester); }
    const sql = `SELECT * FROM feishu_tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY queued_at DESC LIMIT ? OFFSET ?`;
    params.push(filter.limit ?? 50, filter.offset ?? 0);
    // node:sqlite 的 all() 返回 Record<string, SQLOutputValue>[]，这里的列名与 TaskRow 一致，
    // 需要经 unknown 中转才能通过严格模式的类型收窄。
    return this.db.prepare(sql).all(...params) as unknown as TaskRow[];
  }

  getTask(id: string): { task: TaskRow; steps: StepRow[] } | null {
    const task = this.db.prepare('SELECT * FROM feishu_tasks WHERE id=?').get(id) as TaskRow | undefined;
    if (!task) return null;
    const steps = this.db.prepare('SELECT * FROM feishu_steps WHERE task_id=? ORDER BY seq').all(id) as unknown as StepRow[];
    return { task, steps };
  }

  stats(): { running: number; queued: number; todayDone: number; total: number } {
    const one = (sql: string, ...args: Array<string | number>) => Number((this.db.prepare(sql).get(...args) as { n: number }).n);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    return {
      running: one("SELECT COUNT(*) n FROM feishu_tasks WHERE status='running'"),
      queued: one("SELECT COUNT(*) n FROM feishu_tasks WHERE status='queued'"),
      todayDone: one("SELECT COUNT(*) n FROM feishu_tasks WHERE status='done' AND finished_at >= ?", todayStart.toISOString()),
      total: one('SELECT COUNT(*) n FROM feishu_tasks'),
    };
  }

  /** 建分享令牌：只存哈希，明文由调用方返回给用户 */
  createShare(input: { tokenHash: string; taskId: string; expiresAt: string }): void {
    this.db.prepare('INSERT INTO feishu_shares (token_hash, task_id, created_at, expires_at) VALUES (?,?,?,?)')
      .run(input.tokenHash, input.taskId, new Date().toISOString(), input.expiresAt);
  }

  /** 校验分享令牌：未撤销、未过期才返回 task_id */
  resolveShare(tokenHash: string, now = new Date()): { taskId: string } | null {
    const row = this.db.prepare('SELECT task_id, expires_at, revoked FROM feishu_shares WHERE token_hash = ?')
      .get(tokenHash) as { task_id: string; expires_at: string; revoked: number } | undefined;
    if (!row || row.revoked) return null;
    if (new Date(row.expires_at).getTime() < now.getTime()) return null;
    return { taskId: row.task_id };
  }

  /**
   * 提交评价：一份答案只接受一次。
   * 用 task_id 主键做唯一约束，第二个提交会因冲突失败——这就是“首个提交后锁定”。
   * 不提供修改入口：允许改票会让统计口径不可解释。
   */
  submitFeedback(input: { taskId: string; vote: 'up' | 'down'; comment?: string | null; actorOpenId?: string | null; answerVersion?: string | null }):
    { ok: true } | { ok: false; reason: 'already_rated' } {
    try {
      this.db.prepare('INSERT INTO feishu_feedback (task_id, vote, comment, created_at, actor_open_id, answer_version) VALUES (?,?,?,?,?,?)')
        .run(input.taskId, input.vote, input.comment ?? null, new Date().toISOString(), input.actorOpenId ?? null, input.answerVersion ?? null);
      return { ok: true };
    } catch {
      // 主键冲突 = 已经有人评过
      return { ok: false, reason: 'already_rated' };
    }
  }

  getFeedback(taskId: string): { vote: string; comment: string | null; createdAt: string } | null {
    const row = this.db.prepare('SELECT vote, comment, created_at FROM feishu_feedback WHERE task_id = ?').get(taskId) as
      { vote: string; comment: string | null; created_at: string } | undefined;
    return row ? { vote: row.vote, comment: row.comment, createdAt: row.created_at } : null;
  }

  /** 记录/更新问题的 agent 会话，供"继续"时复用 */
  saveIssueSession(input: { originMessageId: string; chatId: string; requesterOpenId: string; sessionId: string }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO feishu_issues (origin_message_id, chat_id, requester_open_id, session_id, rounds, created_at, updated_at)
      VALUES (?,?,?,?,1,?,?)
      ON CONFLICT(origin_message_id) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at
    `).run(input.originMessageId, input.chatId, input.requesterOpenId, input.sessionId, now, now);
  }

  /** 记下机器人最后一条结论消息，用于识别"回复我们的结论 = 要求继续" */
  setIssueReply(originMessageId: string, replyMessageId: string): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE feishu_issues SET last_reply_message_id = ?, updated_at = ? WHERE origin_message_id = ?')
      .run(replyMessageId, now, originMessageId);
    // 每一条发出过的消息都记下来：多轮问题里客服可能引用任何一条，
    // 只留最后一条会让前面几轮的结论完全不可引用。
    const row = this.db.prepare('SELECT chat_id FROM feishu_issues WHERE origin_message_id = ?').get(originMessageId) as { chat_id: string } | undefined;
    if (row) {
      this.db.prepare('INSERT OR REPLACE INTO feishu_issue_replies (reply_message_id, chat_id, origin_message_id, created_at) VALUES (?, ?, ?, ?)')
        .run(replyMessageId, row.chat_id, originMessageId, now);
    }
  }

  /**
   * 按"被回复的机器人消息"反查属于哪个问题；不是我们的结论就返回 null。
   *
   * 必须带上 chatId 校验：只有"同一个群里"引用的结论才算继续。
   * 少了这一条，一旦某条消息把别的群的问题算过来，A 的继续就会记到 B 头上。
   */
  /** 记录这个问题当前是否处于"预算用尽、可继续"状态 */
  setIssueFrozen(originMessageId: string, frozen: boolean): void {
    this.db.prepare('UPDATE feishu_issues SET frozen = ?, updated_at = ? WHERE origin_message_id = ?')
      .run(frozen ? 1 : 0, new Date().toISOString(), originMessageId);
  }

  /**
   * 找这个人当前可以继续的那个问题（同群）。
   *
   * 客服手上通常只有一个问题，所以"直接 @ 说继续"不必引用也能对上。
   * 只认 frozen=1 的：已经正常得出结论的问题不该被一句"继续"重新激活。
   * 万一有多条，取最近更新的那条。
   */
  findContinuableIssue(chatId: string, requesterOpenId: string): {
    originMessageId: string; sessionId: string | null; rounds: number;
  } | null {
    const row = this.db.prepare(
      `SELECT origin_message_id, session_id, rounds FROM feishu_issues
       WHERE chat_id = ? AND requester_open_id = ? AND frozen = 1 AND session_id IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(chatId, requesterOpenId) as
      { origin_message_id: string; session_id: string | null; rounds: number } | undefined;
    if (!row) return null;
    return { originMessageId: row.origin_message_id, sessionId: row.session_id, rounds: row.rounds };
  }

  findIssueByReply(replyMessageId: string, chatId?: string): {
    originMessageId: string; chatId: string; requesterOpenId: string; sessionId: string | null; rounds: number;
  } | null {
    // 先查"发过的所有消息"，再回退到 last_reply_message_id（老数据只有这一列）
    const row = (this.db.prepare(
      `SELECT i.origin_message_id, i.chat_id, i.requester_open_id, i.session_id, i.rounds
         FROM feishu_issue_replies r JOIN feishu_issues i ON i.origin_message_id = r.origin_message_id
        WHERE r.reply_message_id = ?${chatId ? ' AND r.chat_id = ?' : ''}`,
    ).get(...(chatId ? [replyMessageId, chatId] : [replyMessageId]))
      ?? this.db.prepare(
        `SELECT origin_message_id, chat_id, requester_open_id, session_id, rounds FROM feishu_issues
         WHERE last_reply_message_id = ?${chatId ? ' AND chat_id = ?' : ''}`,
      ).get(...(chatId ? [replyMessageId, chatId] : [replyMessageId]))) as
      { origin_message_id: string; chat_id: string; requester_open_id: string; session_id: string | null; rounds: number } | undefined;
    if (!row) return null;
    return {
      originMessageId: row.origin_message_id,
      chatId: row.chat_id,
      requesterOpenId: row.requester_open_id,
      sessionId: row.session_id,
      rounds: row.rounds,
    };
  }

  getIssue(originMessageId: string): { sessionId: string | null; rounds: number; requesterOpenId: string } | null {
    const row = this.db.prepare(
      'SELECT session_id, rounds, requester_open_id FROM feishu_issues WHERE origin_message_id = ?',
    ).get(originMessageId) as { session_id: string | null; rounds: number; requester_open_id: string } | undefined;
    return row ? { sessionId: row.session_id, rounds: row.rounds, requesterOpenId: row.requester_open_id } : null;
  }

  /** 记一轮加预算；返回累计轮次 */
  bumpIssueRound(originMessageId: string): number {
    this.db.prepare('UPDATE feishu_issues SET rounds = rounds + 1, updated_at = ? WHERE origin_message_id = ?')
      .run(new Date().toISOString(), originMessageId);
    const row = this.db.prepare('SELECT rounds FROM feishu_issues WHERE origin_message_id = ?').get(originMessageId) as { rounds: number } | undefined;
    return row?.rounds ?? 1;
  }

  /** 关闭句柄；Windows 下不关会导致文件无法删除（测试与优雅退出都需要） */
  close(): void {
    try { this.db.close(); } catch { /* 已关闭时忽略 */ }
  }

  distinctChats(): Array<{ chat_id: string; chat_name: string | null; n: number }> {
    return this.db.prepare('SELECT chat_id, MAX(chat_name) chat_name, COUNT(*) n FROM feishu_tasks GROUP BY chat_id ORDER BY n DESC').all() as Array<{ chat_id: string; chat_name: string | null; n: number }>;
  }

  distinctRequesters(): Array<{ requester_open_id: string; requester_name: string | null; n: number }> {
    return this.db.prepare('SELECT requester_open_id, MAX(requester_name) requester_name, COUNT(*) n FROM feishu_tasks GROUP BY requester_open_id ORDER BY n DESC').all() as Array<{ requester_open_id: string; requester_name: string | null; n: number }>;
  }
}

let instance: FeishuMonitorDb | null = null;

export function getMonitorDb(dbPath?: string): FeishuMonitorDb {
  if (instance) return instance;
  const target = dbPath ?? FEISHU_PATHS.monitorDbPath;
  instance = new FeishuMonitorDb(target);
  return instance;
}
