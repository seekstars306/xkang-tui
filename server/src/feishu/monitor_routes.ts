import type { Express, Request, Response } from 'express';
import { getMonitorDb } from '../feishu/monitor_db.js';
import { FEISHU_PATHS } from './runtime_paths.js';
import {
  clearSessionCookie,
  createMonitorAuth,
  createSessionCookie,
  verifyPassword,
  type MonitorAccount,
} from './monitor_auth.js';

/**
 * 飞书监控台 HTTP 接口。
 *
 * 鉴权：账号密码登录后拿签名会话 Cookie；脚本仍可用 Bearer 访问。
 * 只读：任务列表、详情、统计、筛选项。没有删除接口——详细输出要能长期追溯。
 */
export function mountFeishuMonitor(
  app: Express,
  options: { accounts: MonitorAccount[]; sessionSecret: string },
): void {
  const db = () => getMonitorDb();
  const auth = createMonitorAuth(options.accounts, options.sessionSecret);
  const enabled = options.accounts.length > 0;

  // 登录页不需要鉴权，否则无法进入
  app.get('/admin/feishu/login', (_req: Request, res: Response) => {
    res.sendFile('monitor-login.html', { root: FEISHU_PATHS.webRoot });
  });

  app.post('/admin/feishu/login', (req: Request, res: Response) => {
    if (!enabled) {
      res.status(503).json({ error: '监控台未配置登录账号，请在 XKANG_MONITOR_ACCOUNTS 中设置' });
      return;
    }
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    const account = options.accounts.find(a => a.username === username);
    // 用户名不存在与密码错误返回同一句话，不泄露账号是否存在
    if (!account || !verifyPassword(password, account.passwordHash)) {
      res.status(401).json({ error: '用户名或密码不正确' });
      return;
    }
    res.setHeader('Set-Cookie', createSessionCookie(username, options.sessionSecret));
    res.json({ ok: true, username });
  });

  app.post('/admin/feishu/logout', (_req: Request, res: Response) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.json({ ok: true });
  });

  app.get('/admin/feishu/stats', auth, (_req, res) => {
    try { res.json(db().stats()); } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.get('/admin/feishu/filters', auth, (_req, res) => {
    try {
      res.json({ chats: db().distinctChats(), requesters: db().distinctRequesters() });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.get('/admin/feishu/tasks', auth, (req, res) => {
    try {
      const { status, chatId, requester, limit, offset } = req.query as Record<string, string | undefined>;
      const tasks = db().listTasks({
        status: status || undefined,
        chatId: chatId || undefined,
        requester: requester || undefined,
        limit: limit ? Number(limit) : 50,
        offset: offset ? Number(offset) : 0,
      });
      // 列表页不返回大字段，避免一次拉几 MB
      res.json(tasks.map(t => ({
        id: t.id, chatId: t.chat_id, chatName: t.chat_name,
        requesterOpenId: t.requester_open_id, requesterName: t.requester_name,
        originAuthorOpenId: t.origin_author_open_id,
        status: t.status, queuedAt: t.queued_at, startedAt: t.started_at,
        finishedAt: t.finished_at, durationMs: t.duration_ms,
        attachmentCount: t.attachment_count, reviewStatus: t.review_status,
        keptCount: t.kept_count, windowCount: t.window_count,
        preview: (t.input_text ?? '').slice(0, 120),
        error: t.error_text,
      })));
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.get('/admin/feishu/tasks/:id', auth, (req, res) => {
    try {
      const row = db().getTask(String(req.params.id));
      if (!row) { res.status(404).json({ error: '任务不存在' }); return; }
      const { task, steps } = row;
      res.json({
        task: {
          id: task.id, chatId: task.chat_id, chatName: task.chat_name,
          requesterOpenId: task.requester_open_id, requesterName: task.requester_name,
          originAuthorOpenId: task.origin_author_open_id,
          originMessageId: task.origin_message_id, triggerMessageId: task.trigger_message_id,
          status: task.status, queuedAt: task.queued_at, startedAt: task.started_at,
          finishedAt: task.finished_at, durationMs: task.duration_ms,
          attachmentCount: task.attachment_count, reviewStatus: task.review_status,
          keptCount: task.kept_count, windowCount: task.window_count,
          inputText: task.input_text, answerJson: task.answer_json, error: task.error_text,
        },
        steps,
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // 监控台首页：未登录时由前端跳登录页
  app.get('/admin/feishu', auth, (_req: Request, res: Response) => {
    res.sendFile('monitor.html', { root: FEISHU_PATHS.webRoot });
  });
}
