import type { Express, RequestHandler } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AuditLogger } from '../auth.js';
import { AgentService } from './service.js';

const inputSchema = z.union([z.string().min(1).max(30000), z.array(z.union([
  z.object({ type: z.literal('text'), text: z.string().max(30000) }).strict(),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string().regex(/^data:image\/(?:png|jpeg|webp|gif);base64,/).max(20_000_000) }).strict() }).strict(),
])).min(1).max(12)]);

export function mountAgentRoutes(app: Express, service: AgentService, employeeAuth: RequestHandler, adminAuth: RequestHandler, audit: AuditLogger) {
  app.use('/agent', employeeAuth);
  app.post('/agent/sessions', (req, res) => res.json(service.store.create(req.user!.subjectId!)));
  app.get('/agent/sessions', (req, res) => res.json(service.store.list(req.user!.subjectId!).map(s => service.get(req.user!.subjectId!, s.id))));
  app.get('/agent/sessions/:id', (req, res) => {
    const session = service.get(req.user!.subjectId!, req.params.id);
    if (!session) { res.status(404).json({ error: '会话不存在' }); return; }
    res.json(session);
  });
  app.delete('/agent/sessions/:id', (req, res) => {
    try { res.status(service.remove(req.user!.subjectId!, req.params.id) ? 200 : 404).json({ status: 'deleted' }); }
    catch { res.status(409).json({ error: '会话正在处理中，请结束后删除' }); }
  });
  app.post('/agent/sessions/:id/messages', (req, res) => {
    const input = inputSchema.safeParse(req.body?.message);
    if (!input.success) { res.status(400).json({ error: '请提供有效的业务问题或图片' }); return; }
    const session = service.get(req.user!.subjectId!, req.params.id);
    if (!session) { res.status(404).json({ error: '会话不存在' }); return; }
    if (session.status !== 'idle') { res.status(409).json({ error: '会话正在处理中' }); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    let closed = false;
    const heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 15000);
    const unsubscribe = service.start(req.user!.subjectId!, req.params.id, input.data, event => {
      if (closed) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'done') { clearInterval(heartbeat); res.end(); }
    });
    res.on('close', () => { closed = true; clearInterval(heartbeat); unsubscribe(); });
  });
  app.post('/agent/sessions/:id/questions/:qid/answer', (req, res) => {
    if (typeof req.body?.answer !== 'string' || req.body.answer.length > 30000) { res.status(400).json({ error: '请输入业务补充信息' }); return; }
    const ok = service.answerQuestion(req.user!.subjectId!, req.params.id, req.params.qid, req.body.answer);
    res.status(ok ? 200 : 404).json({ status: ok ? 'accepted' : 'not_found' });
  });
  app.post('/agent/migrations', (req, res) => {
    const parsed = z.object({ migrationId: z.string().min(1).max(120), hash: z.string().regex(/^[a-f0-9]{64}$/), source: z.object({ messages: z.array(z.any()).max(20000) }).strict() }).strict().safeParse(req.body);
    if (!parsed.success || parsed.data.source.messages.some(m => !m || !['user', 'assistant', 'system', 'tool'].includes(m.role))) { res.status(400).json({ error: '历史会话格式无效' }); return; }
    try { const { migrationId, hash, source } = parsed.data; res.json(service.migrate(req.user!.subjectId!, migrationId, hash, source)); }
    catch { res.status(409).json({ error: '迁移校验未通过，原记录尚未清理' }); }
  });
  app.get('/admin/agent/sessions/:id', adminAuth, (req, res) => {
    const detail = service.store.adminRead(String(req.params.id));
    audit.log({ timestamp: new Date().toISOString(), user: req.user!.name, type: 'admin_action', details: { action: 'read_agent_evidence', sessionId: req.params.id }, success: Boolean(detail) });
    res.status(detail ? 200 : 404).json(detail || { error: '不存在' });
  });
  app.use('/agent', ((err, _req, res, _next) => {
    const traceId = randomUUID();
    if (!res.headersSent) res.status(500).json({ error: '业务服务暂时不可用', traceId });
    else res.end();
  }) as import('express').ErrorRequestHandler);
}
