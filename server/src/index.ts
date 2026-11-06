import express, { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { loadServerConfig } from './config.js';
import { AuditLogger, RateLimiter, createAuthMiddleware, createAdminMiddleware } from './auth.js';
import { setupMcpServer } from './mcp.js';
import { setupLlmProxy, PUBLIC_MODEL_ALIAS } from './llm.js';
import { ActiveModelManager, ALL_MANAGED_MODELS, ManagedModelId, MODEL_PROFILES } from './model_state.js';
import { getCodeGraphService, getCodeSyncManager, initCodeSyncScheduler } from './tools/codegraph.js';
import { setupDownloadRoutes } from './updater.js';
import { TokenManager } from './token_manager.js';
import { AppDatabase } from './db.js';
import { FeedbackManager } from './feedback_manager.js';
import { AgentStore } from './agent/store.js';
import { AgentService } from './agent/service.js';
import { mountAgentRoutes } from './agent/routes.js';
import { fileOutputDir, signFileToken, verifyFileToken } from './tools/file_write.js';
import { mountFeishuMonitor } from './feishu/monitor_routes.js';
import { mountFeishuConsole } from './feishu/console_routes.js';
import { mountShareRoutes } from './feishu/share.js';
import { reviewMode } from './agent/review_mode.js';
import { answerGuide } from './agent/answer_guide.js';

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.platform === 'win32'
  ? entryPath.toLowerCase() === modulePath.toLowerCase()
  : entryPath === modulePath;

function lifecycle(event: string, details: Record<string, string | number> = {}): void {
  if (!directExecution) return;
  try {
    fs.mkdirSync(path.resolve('data'), { recursive: true });
    fs.appendFileSync(path.resolve('data/service-lifecycle.jsonl'), JSON.stringify({
      timestamp: new Date().toISOString(), pid: process.pid, event, ...details,
    }) + '\n');
  } catch {
    console.error('[Server] 无法写入启动/退出诊断日志。');
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Process-level crash guards: a misbehaving client (abrupt SSE disconnect,
// malformed request, broken pipe) must NEVER take down the whole server.
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err: Error) => {
  lifecycle('uncaught_exception', { code: errorCode(err) });
  console.error('[CrashGuard] 捕获未处理异常，请检查 /healthz:', err?.message || err);
});

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  lifecycle('unhandled_rejection', { code: errorCode(reason) });
  console.error('[CrashGuard] 捕获未处理 Promise 拒绝，请检查 /healthz:', msg);
});

export function startServer() {
  const config = loadServerConfig();
  const appDb = AppDatabase.getInstance({ dataDir: './data' });
  const audit = new AuditLogger(appDb.db);
  const limiter = new RateLimiter(config.rateLimitPerMinute);
  const modelManager = new ActiveModelManager(appDb.db, config.defaultActiveModel);
  const feedbackManager = new FeedbackManager(appDb.db);

  // Initialize persistent token manager backed by SQLite
  const tokenManager = new TokenManager(appDb.db);
  tokenManager.seedInitialTokens(config.tokens);

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // 1. Health check & Client Download/Update Routes (unauthenticated)
  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'xkang-company-server',
      version: '2.0.0',
      activeModelAlias: PUBLIC_MODEL_ALIAS,
      timestamp: new Date().toISOString(),
    });
  });

  // Client capability discovery: never publish the company's checkout location.
  app.get('/config/client', (_req, res) => {
    res.json({
      businessApiVersion: 1,
      serverVersion: '2.0.0',
      publicModelAlias: PUBLIC_MODEL_ALIAS,
      features: config.features,
    });
  });

  // Client binary release & one-click Windows installer routes
  setupDownloadRoutes(app, './data/releases');

  // 2. Admin routes: model switching, token management & device unbinding
  const adminAuth = createAdminMiddleware(config, audit);
  const employeeAuth = createAuthMiddleware(config, audit, limiter, tokenManager);
  const agentService = new AgentService(new AgentStore(appDb.db), config, audit, modelManager);
  // 导出文件下载：write_file / write_xlsx 落在导出目录，客服凭链接取文件。
  // 目录受限（见 tools/file_write.ts 的沙箱），链接文件名由模型生成时应带随机串，避免被猜到。
  // 带 48 小时签名令牌的下载：链接会发到飞书群，裸静态目录等于把护照号公开。
  app.get('/files/:name', (req, res) => {
    const name = String(req.params.name ?? '');
    // 允许中文等非 ASCII 文件名（模型常起中文名），但禁止路径分隔符与向上跳级。
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || /[\u0000-\u001f]/.test(name)) {
      res.status(400).json({ error: '非法文件名' });
      return;
    }
    if (!verifyFileToken(name, String(req.query.e ?? ''), String(req.query.s ?? ''))) {
      res.status(403).json({ error: '链接无效或已过期（有效期 48 小时）' });
      return;
    }
    res.sendFile(name, { root: fileOutputDir(), dotfiles: 'deny' });
  });
  mountAgentRoutes(app, agentService, employeeAuth, adminAuth, audit);
  // 飞书监控台：账号密码登录 + 只读接口，与 admin Bearer 鉴权分离
  mountFeishuMonitor(app, {
    accounts: config.monitorAccounts,
    sessionSecret: config.monitorSessionSecret,
  });
  // 服务端控制台：与监控台同页、同一套登录态；启停与配置编辑都在这里
  mountFeishuConsole(app, {
    accounts: config.monitorAccounts,
    sessionSecret: config.monitorSessionSecret,
    config,
  });
  // 结论分享页：链接本身是凭据，只返回已脱敏的答案快照
  mountShareRoutes(app);

  app.get('/admin/model', adminAuth, (_req: Request, res: Response) => {
    const active = modelManager.getActive();
    res.json({
      activeModel: active,
      activeProfile: modelManager.getActiveProfile(),
      availableModels: modelManager.availableModels(config),
      modelProfiles: MODEL_PROFILES,
      publicAlias: PUBLIC_MODEL_ALIAS,
      mockMode: config.mockLlm,
    });
  });

  app.post('/admin/model', adminAuth, (req: Request, res: Response) => {
    const targetModel = req.body?.model as ManagedModelId;
    if (!targetModel || !ALL_MANAGED_MODELS.includes(targetModel)) {
      res.status(400).json({
        error: `无效的模型标识 "${targetModel}"。可选范围: ${ALL_MANAGED_MODELS.join(', ')}`,
      });
      return;
    }

    const available = modelManager.availableModels(config);
    if (!available.includes(targetModel)) {
      res.status(400).json({
        error: `模型 "${targetModel}" 在服务端未配置对应 API Key，无法切换。`,
        availableModels: available,
      });
      return;
    }

    const { previous, current, profile } = modelManager.setActive(targetModel);

    audit.log({
      timestamp: new Date().toISOString(),
      user: req.user?.name || 'admin',
      type: 'admin_action',
      details: { action: 'switch_model', previous, current, promptTier: profile.promptTier },
      success: true,
    });

    res.json({
      status: 'success',
      previousModel: previous,
      currentModel: current,
      currentProfile: profile,
      publicAlias: PUBLIC_MODEL_ALIAS,
      message: `已成功将公司模型切换为 [${current}] (提示词级别: ${profile.promptTier.toUpperCase()})。正在执行的任务将继续使用原模型完成，新发起的排障请求将自动路由到新模型，对话上下文不受影响。`,
    });
  });

  // Admin Token Management APIs
  app.get('/admin/tokens', adminAuth, (_req: Request, res: Response) => {
    res.json({
      status: 'success',
      tokens: tokenManager.listTokens(),
    });
  });

  app.post('/admin/tokens', adminAuth, (req: Request, res: Response) => {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      res.status(400).json({ error: '员工姓名 (name) 不能为空' });
      return;
    }
    const record = tokenManager.createToken(name);
    audit.log({
      timestamp: new Date().toISOString(),
      user: req.user?.name || 'admin',
      type: 'admin_action',
      details: { action: 'create_token', name, token: record.token },
      success: true,
    });
    res.json({ status: 'success', token: record });
  });

  app.post('/admin/tokens/unbind', adminAuth, (req: Request, res: Response) => {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      res.status(400).json({ error: 'token 参数不能为空' });
      return;
    }
    const result = tokenManager.unbindDevice(token);
    audit.log({
      timestamp: new Date().toISOString(),
      user: req.user?.name || 'admin',
      type: 'admin_action',
      details: { action: 'unbind_device', token },
      success: result.success,
    });
    res.json(result);
  });

  app.post('/admin/tokens/status', adminAuth, (req: Request, res: Response) => {
    const { token, enabled } = req.body;
    if (!token || typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'token 与 enabled (boolean) 参数为必填项' });
      return;
    }
    const result = tokenManager.setTokenStatus(token, enabled);
    res.json(result);
  });

  // Admin Feedback Management APIs
  app.get('/admin/feedbacks', adminAuth, (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 100;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const feedbacks = feedbackManager.listFeedbacks(limit, status);
    res.json({
      status: 'success',
      total: feedbacks.length,
      feedbacks,
    });
  });

  app.post('/admin/feedbacks/status', adminAuth, (req: Request, res: Response) => {
    const { id, status, notes } = req.body;
    if (!id || !status) {
      res.status(400).json({ error: 'id 与 status 为必填项' });
      return;
    }
    const ok = feedbackManager.updateStatus(id, status, notes);
    res.json({ status: ok ? 'success' : 'not_found' });
  });

  // Public/Employee feedback submission API
  app.post('/api/feedback', employeeAuth, (req: Request, res: Response) => {
    const { content, feedbackType = '排障异常反馈', sessionId, sessionTitle, turnId, answerId, verdict } = req.body;
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
    const userName = token ? tokenManager.getToken(token)?.name || '客服专员' : '客服专员';
    const owned = sessionId ? agentService.store.load(req.user!.subjectId!, String(sessionId)) : null;
    if (sessionId && !owned) { res.status(404).json({ error: '会话不存在' }); return; }

    if (!content || !String(content).trim()) {
      res.status(400).json({ error: 'content 反馈内容不能为空' });
      return;
    }

    // R4：不写明文 Bearer Token（存员工标识或令牌哈希）与上下文脱敏作为凭据安全修复无条件生效；
    // feedbackBinding 开关控制是否绑定单回合（turnId/answerId/verdict 与同回合幂等去重）。
    const bound = Boolean(config.features?.feedbackBinding);
    const userToken = req.user?.subjectId || (token ? createHash('sha256').update(token).digest('hex').slice(0, 16) : undefined);
    const feedbackContext = owned ? agentService.feedbackContext(req.user!.subjectId!, String(sessionId), bound ? turnId : '__all__') : undefined;

    const record = feedbackManager.createFeedback({
      userName,
      userToken,
      feedbackType,
      content: String(content).trim(),
      sessionId,
      sessionTitle: owned?.public.title,
      turnId: bound ? turnId : undefined,
      answerId: bound ? answerId : undefined,
      verdict: bound ? verdict : undefined,
      context: feedbackContext ?? undefined,
    });

    res.json({
      status: 'success',
      feedbackId: record.id,
      message: '排障问题与会话上下文已成功录入系统数据库！',
    });
  });

  // Admin CodeGraph Manual Sync & Hot-rebuild API
  // 未配置 CODE_REPO_PATH 时为 null：管理接口明确回答"没配置"，不再拿硬编码路径顶着
  const syncManager = getCodeSyncManager(config);

  app.get('/admin/codegraph/status', adminAuth, (_req: Request, res: Response) => {
    if (!syncManager) {
      res.status(503).json({ status: 'error', error: '未配置 CODE_REPO_PATH，代码同步未启用。请在 server/.env 配置后重启。' });
      return;
    }
    res.json({
      status: 'success',
      ...syncManager.getStatus(),
    });
  });

  app.post('/admin/codegraph/sync', adminAuth, async (req: Request, res: Response) => {
    const forceRebuild = Boolean(req.body?.forceRebuild);
    if (!syncManager) {
      res.status(503).json({ status: 'error', error: '未配置 CODE_REPO_PATH，代码同步未启用。请在 server/.env 配置后重启。' });
      return;
    }
    try {
      const syncResult = await syncManager.syncAndRebuild(forceRebuild);
      audit.log({
        timestamp: new Date().toISOString(),
        user: req.user?.name || 'admin',
        type: 'admin_action',
        details: {
          action: 'sync_codegraph',
          totalRepos: syncResult.totalRepos,
          updatedRepos: syncResult.updatedRepos,
          indexRebuilt: syncResult.indexRebuilt,
        },
        success: true,
      });
      res.json({
        status: 'success',
        result: syncResult,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        status: 'error',
        error: msg,
      });
    }
  });

  // 3. Employee auth middleware for protected MCP & LLM routes (with device binding gate)
  app.use(['/mcp', '/codegraph'], adminAuth);
  app.use('/v1', employeeAuth);

  // 4. Mount CodeGraph query API
  app.post('/codegraph/api/query', (req: Request, res: Response) => {
    const { symbol, queryType = 'definitions', repo } = req.body;
    if (!symbol) {
      res.status(400).json({ error: 'symbol parameter is required' });
      return;
    }
    if (!config.codeRepoPath) {
      res.status(503).json({ error: '未配置 CODE_REPO_PATH，代码图谱查询未启用。请在 server/.env 配置后重启。' });
      return;
    }
    const service = getCodeGraphService(config.codeRepoPath);
    const result = service.query(symbol, queryType, repo);
    res.json(result);
  });

  // 5. Mount MCP tool service
  setupMcpServer(app, config, audit);

  // 6. Mount LLM proxy service with dynamic model manager
  const llmHandler = setupLlmProxy(config, audit, modelManager, { localOnly: true });
  app.post('/v1/chat/completions', llmHandler);
  app.use(((error, _req, res, _next) => {
    if (!res.headersSent) res.status(500).json({ error: '请求未完成，请稍后重试。' });
    else res.end();
  }) as import('express').ErrorRequestHandler);

  const server = createServer(app);
  let scheduler: ReturnType<typeof initCodeSyncScheduler> = null;
  server.on('error', error => {
    lifecycle('http_error', { port: config.port, code: errorCode(error) });
    console.error('[Server] HTTP 监听错误:', errorCode(error));
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      try {
        // 只有监听成功后才启动后台同步，失败实例不能修改代码镜像。
        scheduler = initCodeSyncScheduler(config);
        console.log(`====================================================`);
        console.log(`🚀 xkang 公司核心服务端已启动`);
        console.log(`   进程 PID: ${process.pid}`);
        console.log(`   监听端口: http://localhost:${config.port}`);
        console.log(`   当前活跃模型 (服务端调度): ${modelManager.getActive()}`);
        console.log(`   客户端公开别名: ${PUBLIC_MODEL_ALIAS}`);
        console.log(`   MCP SSE 端点: http://localhost:${config.port}/mcp/sse`);
        // 复核模式按进程环境生效（见 scripts/start_production.ps1），启动时打出来，便于核对线上实际值
        console.log(`   复核模式 REVIEW_MODE: ${reviewMode()}`);
        console.log(`   推理档位 DEEPSEEK_REASONING_EFFORT: ${config.deepseekReasoningEffort ?? '未设置（不传）'}；上下文阈值 CONTEXT_TOKENS: ${config.contextTokens ?? '默认 140000'}；答案写法 ANSWER_GUIDE: ${answerGuide()}`);
        console.log(`   LLM 代理端点: http://localhost:${config.port}/v1/chat/completions`);
        console.log(`   管理员接口: http://localhost:${config.port}/admin/model`);
        console.log(`   已授权员工令牌: ${config.tokens.size} 个, 管理员令牌: ${config.adminTokens.size} 个`);
        // 代码库路径丢失时，代码检索/读文件/git/图谱四类工具会全部不可用。
        // 以前只有工具调用时才逐条报错，启动横幅看不出来，2026-11-03 因此拖了 20 小时。
        if (!config.codeRepoPath) {
          console.warn('   ⚠️ 未配置 CODE_REPO_PATH：search_code / read_file_lines / git_inspect / codegraph_explore 全部不可用，请在 server/.env 配置后重启。');
        } else {
          console.log(`   代码库路径 CODE_REPO_PATH: ${config.codeRepoPath}`);
        }
        console.log(`====================================================`);
        resolve();
      } catch (error) {
        server.close();
        reject(error);
      }
    });
  });
  // 旧嵌入式调用方仍可监听 server 事件；CLI 和新调用方等待 ready。
  void ready.catch(() => {});
  server.once('close', () => scheduler?.stop());
  server.listen(config.port);

  return { app, server, config, modelManager, ready };
}

async function runDirect(): Promise<void> {
  let port = 0;
  let exitReason = 'event_loop_finished';
  process.once('exit', exitCode => lifecycle('exit', { port, exitCode, reason: exitReason }));
  try {
    port = loadServerConfig().port;
    const diagnostics = path.resolve('data/diagnostics');
    fs.mkdirSync(diagnostics, { recursive: true });
    if (process.report) {
      process.report.directory = diagnostics;
      process.report.excludeEnv = true;
    }
    lifecycle('starting', { port, parentPid: process.ppid, heapLimitBytes: getHeapStatistics().heap_size_limit });
    // 在创建业务数据库、加载大图谱前检查端口；真实监听仍由 ready 再次确认。
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer(socket => socket.destroy());
      probe.once('error', reject);
      probe.listen(port, () => probe.close(error => error ? reject(error) : resolve()));
    });
    const { server, ready } = startServer();
    await ready;
    lifecycle('started', { port, rssBytes: process.memoryUsage().rss });
    let stopping = false;
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      exitReason = signal;
      lifecycle('stop_requested', { port, signal });
      console.log(`[Server] 收到 ${signal}，正在停止服务（PID ${process.pid}）。`);
      server.close(() => process.exit(0));
      server.closeAllConnections();
      setTimeout(() => process.exit(1), 5000).unref();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
    server.once('close', () => {
      if (!stopping) exitReason = 'listener_closed';
      lifecycle('http_closed', { port, reason: exitReason });
    });
  } catch (error) {
    exitReason = 'startup_failed';
    const code = errorCode(error);
    lifecycle('startup_failed', { port, code });
    const message = code === 'EADDRINUSE'
      ? `端口 ${port} 已被占用，本次进程（PID ${process.pid}）未启动。请确认已有服务，或先停止它再启动。`
      : code === 'EACCES' ? `没有权限监听端口 ${port}。`
      : error instanceof Error ? error.message : String(error);
    console.error('[启动失败]', message);
    process.exit(1);
  }
}

if (directExecution) void runDirect();
