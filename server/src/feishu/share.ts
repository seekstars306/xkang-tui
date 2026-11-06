import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { getMonitorDb } from './monitor_db.js';
import { FEISHU_PATHS } from './runtime_paths.js';

/**
 * 公网只读结论页。
 *
 * 设计要点：
 * - 令牌随机生成，库里只存 SHA-256 哈希；明文只在生成时给一次，
 *   所以拿到数据库也推不出有效链接。
 * - 默认 72 小时有效（要求至少 24 小时），可配置；到期或撤销后返回 410。
 * - 只暴露 PublicAnswer 快照（结论/业务信息/依据/待确认/话术），
 *   不暴露清洗前输入、工具日志、群原始消息或任何内部标识。
 * - 评价按 task_id 主键唯一：一份答案只接受一次，首个提交后锁定，
 *   并发重复提交只有一个成功，其余返回 409 并回传已有评价。
 */

const DEFAULT_TTL_HOURS = Number(process.env.SHARE_TTL_HOURS || '72');
const MIN_TTL_HOURS = 24;

export function buildShareUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, '')}/share/${token}`;
}

/** 生成分享链接；返回明文 token，仅此一次 */
export function createShareLink(taskId: string, baseUrl: string, ttlHours = DEFAULT_TTL_HOURS): { url: string; expiresAt: string } {
  const hours = Math.max(MIN_TTL_HOURS, Number.isFinite(ttlHours) ? ttlHours : DEFAULT_TTL_HOURS);
  const token = randomBytes(24).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
  getMonitorDb().createShare({ tokenHash, taskId, expiresAt });
  return { url: buildShareUrl(baseUrl, token), expiresAt };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 分享页路由。
 *
 * 页面本身不需要登录——链接本身就是凭据；但链接不可枚举（24 字节随机），
 * 并且只返回已脱敏的答案快照。
 */
export function mountShareRoutes(app: Express): void {
  const db = () => getMonitorDb();

  const resolve = (token: string) => db().resolveShare(hashToken(token));

  app.get('/share/:token', (req: Request, res: Response) => {
    // 浏览器直接访问时给页面，带 Accept: application/json 时给数据
    const wantsJson = String(req.headers.accept ?? '').includes('application/json')
      && !String(req.headers.accept ?? '').includes('text/html');
    if (!wantsJson) {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile('share.html', { root: FEISHU_PATHS.webRoot });
      return;
    }
    const hit = resolve(String(req.params.token));
    if (!hit) { res.status(410).json({ error: '链接已失效' }); return; }
    const row = db().getTask(hit.taskId);
    if (!row) { res.status(410).json({ error: '结论不存在' }); return; }
    const { task } = row;
    let answer: unknown = null;
    try { answer = task.answer_json ? JSON.parse(task.answer_json) : null; } catch { answer = null; }
    // 只给公开字段，绝不带 input_text / steps / 原始消息
    // answer 是完整结构（结论/业务信息/依据/待确认），text 只是发群里的精简文本。
    // 分享页要展示完整内容，所以优先用 answer；只有老数据（没有 answer）才退回拆 text。
    const record = (answer && typeof answer === 'object') ? answer as Record<string, unknown> : null;
    const full = record && typeof record.answer === 'object' && record.answer !== null
      ? record.answer as Record<string, unknown>
      : null;
    const payload = full
      ? {
          conclusion: String(full.conclusion ?? ''),
          businessData: Array.isArray(full.businessData) ? full.businessData : [],
          evidenceSummary: Array.isArray(full.evidenceSummary) ? full.evidenceSummary : [],
          customerReply: full.customerReply ? String(full.customerReply) : '',
          pendingItems: Array.isArray(full.pendingItems) ? full.pendingItems : [],
          reviewStatus: task.review_status ?? (full.reviewStatus ? String(full.reviewStatus) : undefined),
        }
      : (record && typeof record.text === 'string' ? parseAnswerText(record.text) : null);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      task: {
        id: task.id,
        startedAt: task.started_at,
        finishedAt: task.finished_at,
        reviewStatus: task.review_status,
      },
      answer: payload,
      feedback: db().getFeedback(task.id),
    });
  });

  app.post('/share/:token/feedback', (req: Request, res: Response) => {
    const hit = resolve(String(req.params.token));
    if (!hit) { res.status(410).json({ error: '链接已失效' }); return; }
    const vote = req.body?.vote;
    if (vote !== 'up' && vote !== 'down') { res.status(400).json({ error: '请选择准确或不准确' }); return; }
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.slice(0, 2000) : null;
    const result = db().submitFeedback({ taskId: hit.taskId, vote, comment });
    if (!result.ok) {
      res.status(409).json({ error: '该答案已被评价', feedback: db().getFeedback(hit.taskId) });
      return;
    }
    res.json({ ok: true });
  });
}

/**
 * 群里发的是格式化后的文本，但监控页存的是 { text }。
 * 这里把文本拆回结构化字段，供分享页按段展示。
 */
export function parseAnswerText(text: string): Record<string, unknown> {
  const sections: Record<string, string[]> = { conclusion: [], businessData: [], pendingItems: [] };
  let current: keyof typeof sections = 'conclusion';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '【结论】') { current = 'conclusion'; continue; }
    if (line === '【业务信息】') { current = 'businessData'; continue; }
    if (line === '【还需确认】') { current = 'pendingItems'; continue; }
    sections[current].push(line.replace(/^·\s*/, ''));
  }
  const businessData = sections.businessData
    .map(l => { const i = l.indexOf('：'); return i > 0 ? { label: l.slice(0, i), value: l.slice(i + 1) } : null; })
    .filter(Boolean);
  return {
    conclusion: sections.conclusion.join('\n'),
    businessData,
    evidenceSummary: [],
    customerReply: '',
    pendingItems: sections.pendingItems,
    reviewStatus: undefined,
    traceId: undefined,
  };
}
