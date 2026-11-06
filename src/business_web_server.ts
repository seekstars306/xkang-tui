import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { answerText, type PublicSession } from '@xkang/agent-core/public';
import { BusinessClient } from './adapters/business_client.js';
import { BusinessSessions } from './config/business_sessions.js';
import { loadConfig } from './config/models.js';
import { loadUserLocalConfig } from './config/user_config.js';
import { checkForUpdates, performAutoUpdate, CURRENT_CLIENT_VERSION } from './updater/index.js';

/** 特性开关只透传布尔值（R1 部分发布 / R2 时间预算等），畸形值按未开启处理 */
function publicFeatures(value: any): Record<string, boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, boolean> = {};
  for (const [key, flag] of Object.entries(value)) if (typeof flag === 'boolean') out[key] = flag;
  return out;
}
export function browserSession(session: PublicSession) {
  return { id: session.id, title: session.title, createdAt: session.createdAt, lastActiveAt: session.lastActiveAt,
    busy: session.status !== 'idle', pendingQuestion: session.pendingQuestion,
    // R2 冻结续查：status 仍只有三个枚举值，冻结态用可选字段表达（是否展示由 features.timeBudget 决定）
    ...(typeof session.frozen === 'boolean' ? { frozen: session.frozen } : {}),
    ...(Number.isInteger(session.extensions) ? { extensions: session.extensions } : {}),
    ...(Number.isInteger(session.activeBudgetMs) ? { activeBudgetMs: session.activeBudgetMs } : {}),
    // turnId 透传：前端反馈按公开回合 ID 绑定到具体某条回答（R4）
    messages: session.turns.flatMap(turn => [{ role: 'user', content: turn.userText, turnId: turn.id }, ...(turn.answer ? [{ role: 'assistant', content: answerText(turn.answer), publicReviewStatus: turn.answer.reviewStatus, turnId: turn.id, ...(turn.answer.claims ? { publicClaims: turn.answer.claims } : {}) }] : [])]) };
}
export async function startBusinessWebServer(options: { port?: number; autoOpen?: boolean; serverUrl?: string; token?: string; cacheDirectory?: string } = {}): Promise<http.Server> {
  const config = loadConfig(), user = loadUserLocalConfig();
  const port = options.port ?? Number(process.env.WEB_PORT || 8611);
  const url = options.serverUrl || config.serverUrl || '';
  const client = new BusinessClient(url, options.token || user.token || config.token || '');
  const cache = new BusinessSessions(options.cacheDirectory);
  const webCandidates = [path.join(process.cwd(), 'web'), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web')];
  const web = webCandidates.find(dir => fs.existsSync(path.join(dir, 'index.html'))) || webCandidates[0];
  let migration: Promise<boolean> | undefined;
  const ensureMigration = () => migration ||= cache.migrate(client).then(result => { if (!result.complete) migration = undefined; return result.complete; });
  const json = (res: http.ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const body = async (req: http.IncomingMessage): Promise<any> => {
    const parts: Buffer[] = []; let size = 0;
    for await (const part of req) { size += part.length; if (size > 40_000_000) throw new Error('请求过大'); parts.push(part); }
    return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
  };
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', `http://localhost:${port}`).pathname;
    if (req.headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(req.headers.origin)) { json(res, 403, { error: '请求来源不允许' }); return; }
    try {
      if (!pathname.startsWith('/api/')) {
        const name = pathname === '/' ? 'index.html' : pathname.slice(1);
        // Explicit asset allowlist; source files and legacy node entrypoints are not browser assets.
        if (!['index.html', 'app.js', 'answer.js', 'style.css', 'favicon.png', 'logo.png'].includes(name)) { res.writeHead(404); res.end(); return; }
        const content = fs.readFileSync(path.join(web, name));
        const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
        res.writeHead(200, { 'Content-Type': `${mime[path.extname(name)]}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(content); return;
      }
      if (pathname === '/api/bootstrap') {
        const config = await client.config();
        const available = config.businessApiVersion === 1;
        const migrated = available ? await ensureMigration() : false;
        const features = publicFeatures(config.features);
        json(res, 200, { mode: 'business', userName: user.userName || '客服专员', repoName: '业务服务中心', mcpConnected: available && migrated,
          migrationComplete: migrated, activeModelDisplayName: '小康业务助手', ...(features ? { features } : {}) }); return;
      }
      if (pathname === '/api/version/check') { json(res, 200, { ...await checkForUpdates(url), currentVersion: CURRENT_CLIENT_VERSION }); return; }
      if (pathname === '/api/version/update' && req.method === 'POST') {
        const update = await checkForUpdates(url);
        if (!update.downloadUrl) { json(res, 400, { error: '当前没有可用更新' }); return; }
        json(res, 200, await performAutoUpdate(update.downloadUrl)); return;
      }
      if (!(await ensureMigration())) { json(res, 503, { error: '历史会话迁移尚未完成，请连接业务服务后重试。' }); return; }
      if (pathname === '/api/sessions') {
        const sessions = await client.list();
        for (const session of sessions) cache.save(session);
        json(res, 200, { sessions: sessions.map(s => ({ id: s.id, title: s.title, createdAt: s.createdAt, lastActiveAt: s.lastActiveAt,
          messageCount: s.turns.length * 2, lastSnippet: s.turns.at(-1)?.answer?.conclusion || '', verdict: s.turns.at(-1)?.answer?.reviewStatus || null })) }); return;
      }
      if (pathname === '/api/session' && req.method === 'POST') {
        const session = await client.create(); cache.save(session);
        json(res, 200, { sessionId: session.id, title: session.title, createdAt: session.createdAt }); return;
      }
      const match = pathname.match(/^\/api\/session\/([\w-]+)(?:\/(chat|answer|continue))?$/);
      if (match) {
        const id = match[1];
        if (match[2] === 'chat' && req.method === 'POST') {
          const input = await body(req);
          // UI detail is a display hint, not part of the server's accepted image DTO.
          const message = input.parts ? input.parts.map((p: any) => p.type === 'image_url' ? { type: 'image_url', image_url: { url: p.image_url.url } } : { type: 'text', text: p.text }) : input.message;
          let closed = false;
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          res.on('close', () => { closed = true; });
          const send = (event: unknown) => { if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
          try { await client.chat(id, message, event => send(event)); }
          catch { send({ type: 'error', message: '连接暂时中断，请重新打开会话查看处理结果。' }); }
          finally {
            try { cache.save(await client.get(id)); } catch { /* Server remains authoritative after disconnect. */ }
            if (!closed) res.end();
          }
          return;
        }
        // R2：续查代理（冻结会话追加 15 分钟），事件协议与 chat 一致
        if (match[2] === 'continue' && req.method === 'POST') {
          let closed = false;
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          res.on('close', () => { closed = true; });
          const send = (event: unknown) => { if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
          try { await client.continue(id, event => send(event)); }
          catch (error) { send({ type: 'error', message: error instanceof Error ? error.message : '续查未开始，请稍后重试。' }); }
          finally {
            try { cache.save(await client.get(id)); } catch { /* Server remains authoritative after disconnect. */ }
            if (!closed) res.end();
          }
          return;
        }
        if (match[2] === 'answer' && req.method === 'POST') {
          const input = await body(req); await client.answer(id, String(input.requestId), String(input.answer)); json(res, 200, { status: 'accepted' }); return;
        }
        if (!match[2] && req.method === 'DELETE') { await client.delete(id); cache.remove(id); json(res, 200, { status: 'deleted' }); return; }
        if (!match[2] && req.method === 'GET') { const session = await client.get(id); cache.save(session); json(res, 200, browserSession(session)); return; }
      }
      if (pathname === '/api/feedback' && req.method === 'POST') {
        const input = await body(req);
        const result = await client.request('/api/feedback', 'POST', { content: String(input.content || ''), feedbackType: String(input.feedbackType || ''), sessionId: input.sessionId, turnId: input.turnId, answerId: input.answerId, verdict: input.verdict });
        json(res, 200, { status: 'success', feedbackId: result.feedbackId }); return;
      }
      json(res, 404, { error: '请求不存在' });
    } catch {
      if (!res.headersSent) json(res, 503, { error: '业务服务暂时未完成请求，请稍后重试。' });
      else res.end();
    }
  });
  server.on('close', () => cache.close());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  if (options.autoOpen !== false && process.env.WEB_NO_OPEN !== '1') spawn('cmd', ['/c', 'start', '', `http://localhost:${port}`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  return server;
}
