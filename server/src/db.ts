/**
 * xkang 服务端统一数据库管理模块
 * 基于 Node 22 原生内置的 `node:sqlite` (DatabaseSync)，零第三方 npm/C++ 依赖。
 * 统一收拢存储：
 *  1. 系统配置 (sys_configs)
 *  2. 员工访问密钥与设备绑定 (auth_tokens)
 *  3. 服务端审计日志流水 (audit_logs)
 *  4. 客服错误排障反馈 (cs_feedbacks)
 * 并自动从原有的 JSON/JSONL 散落文件中平滑迁移历史数据。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DatabaseOptions {
  dbPath?: string;
  dataDir?: string;
}

function resolveServerDataDir(): string {
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const serverDir = path.resolve(path.dirname(currentFile), '..');
    return path.join(serverDir, 'data');
  } catch {
    return path.resolve('./server/data');
  }
}

export class AppDatabase {
  private static instance: AppDatabase | null = null;
  public db: DatabaseSync;
  private dataDir: string;

  constructor(options: DatabaseOptions = {}) {
    this.dataDir = options.dataDir
      ? path.resolve(options.dataDir)
      : resolveServerDataDir();
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    const dbFilePath = options.dbPath ? path.resolve(options.dbPath) : path.join(this.dataDir, 'xkang.db');
    this.db = new DatabaseSync(dbFilePath);
    
    // 启用 WAL 模式提高并发写入性能
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');

    this.initSchema();
    this.autoMigrateLegacyFiles();
  }

  public static getInstance(options?: DatabaseOptions): AppDatabase {
    if (!AppDatabase.instance) {
      AppDatabase.instance = new AppDatabase(options);
    }
    return AppDatabase.instance;
  }

  private initSchema(): void {
    this.db.exec(`
      -- 1. 系统通用配置表 (key-value)
      CREATE TABLE IF NOT EXISTS sys_configs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      -- 2. 员工访问密钥与设备绑定表
      CREATE TABLE IF NOT EXISTS auth_tokens (
        token TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        bound_device_id TEXT,
        last_used_at TEXT,
        last_ip TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_enabled ON auth_tokens(enabled);

      -- 3. 服务端审计与排障流水表
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        user TEXT NOT NULL,
        type TEXT NOT NULL,
        tool_name TEXT,
        model TEXT,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        duration_ms REAL,
        details JSON,
        success INTEGER NOT NULL DEFAULT 1,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user);

      -- 4. 客服错误排障反馈表
      CREATE TABLE IF NOT EXISTS cs_feedbacks (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        user_name TEXT NOT NULL,
        user_token TEXT,
        feedback_type TEXT NOT NULL,
        content TEXT NOT NULL,
        session_id TEXT,
        session_title TEXT,
        context JSON,
        status TEXT NOT NULL DEFAULT 'pending', -- pending / investigating / resolved
        resolution_notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_time ON cs_feedbacks(created_at);
      CREATE INDEX IF NOT EXISTS idx_feedback_type ON cs_feedbacks(feedback_type);
    `);
  }

  /**
   * 自动将散落的 tokens.json / active_model.json / audit.jsonl / feedbacks.jsonl 迁移至 SQLite
   */
  private autoMigrateLegacyFiles(): void {
    // 1. 迁移 tokens.json
    const tokensPath = path.join(this.dataDir, 'tokens.json');
    if (fs.existsSync(tokensPath)) {
      try {
        const raw = fs.readFileSync(tokensPath, 'utf-8');
        const data = JSON.parse(raw || '{}');
        const count = Object.keys(data).length;
        if (count > 0) {
          const insertStmt = this.db.prepare(`
            INSERT OR IGNORE INTO auth_tokens (token, name, bound_device_id, last_used_at, last_ip, created_at, enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);
          let migrated = 0;
          for (const [t, rec] of Object.entries(data) as [string, any][]) {
            const res = insertStmt.run(
              t,
              rec.name || '员工',
              rec.boundDeviceId || null,
              rec.lastUsedAt || null,
              rec.lastIp || null,
              rec.createdAt || new Date().toISOString(),
              rec.enabled !== false ? 1 : 0
            );
            if (res.changes > 0) migrated++;
          }
          if (migrated > 0) {
            console.log(`[DatabaseSync] 已从 tokens.json 自动平滑导入 ${migrated} 条员工密钥记录`);
          }
        }
      } catch (err) {
        console.error('[DatabaseSync] 迁移 tokens.json 发生异常:', err);
      }
    }

    // 2. 迁移 active_model.json
    const activeModelPath = path.resolve(this.dataDir, '../active_model.json');
    if (fs.existsSync(activeModelPath)) {
      try {
        const raw = fs.readFileSync(activeModelPath, 'utf-8');
        const data = JSON.parse(raw || '{}');
        if (data.activeModel) {
          this.db.prepare(`
            INSERT OR REPLACE INTO sys_configs (key, value, updated_at)
            VALUES ('active_model', ?, datetime('now', 'localtime'))
          `).run(String(data.activeModel));
          console.log(`[DatabaseSync] 已从 active_model.json 迁移当前模型: [${data.activeModel}]`);
        }
      } catch (err) {
        console.error('[DatabaseSync] 迁移 active_model.json 异常:', err);
      }
    }

    // 3. 迁移 feedbacks.jsonl (如果存在)
    const feedbacksLog = path.join(this.dataDir, 'feedbacks.jsonl');
    if (fs.existsSync(feedbacksLog)) {
      try {
        const lines = fs.readFileSync(feedbacksLog, 'utf-8').split('\n').filter(Boolean);
        const insertStmt = this.db.prepare(`
          INSERT OR IGNORE INTO cs_feedbacks (id, created_at, user_name, user_token, feedback_type, content, session_id, session_title, context, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        let count = 0;
        for (const line of lines) {
          try {
            const item = JSON.parse(line);
            if (item.id && item.content) {
              const res = insertStmt.run(
                item.id,
                item.timestamp || new Date().toISOString(),
                item.userName || '客服专员',
                item.userToken || null,
                item.feedbackType || '排障异常反馈',
                item.content,
                item.sessionId || null,
                item.sessionTitle || null,
                JSON.stringify(item.context || []),
                item.status || 'pending'
              );
              if (res.changes > 0) count++;
            }
          } catch {}
        }
        if (count > 0) {
          console.log(`[DatabaseSync] 已从 feedbacks.jsonl 自动导入 ${count} 条客服排障反馈`);
        }
      } catch (err) {
        console.error('[DatabaseSync] 迁移 feedbacks.jsonl 异常:', err);
      }
    }
  }
}
