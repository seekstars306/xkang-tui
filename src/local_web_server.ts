/**
 * xhang Web UI 核心服务
 * - 托管 web/ 静态页面
 * - 通过 SSE 将 AgentHarness 流式事件桥接到浏览器
 * - 会话管理与多模态交互
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/models.js';
import { ModelGateway } from './adapters/gateway.js';
import { AgentHarness } from './harness/agent.js';
import { isReminderMessage } from './harness/context.js';
import { createDefaultToolRegistry } from './tools/index.js';
import type { ToolRegistry } from './tools/registry.js';
import { McpRemoteClient } from './mcp/client.js';
import { loadUserLocalConfig } from './config/user_config.js';
import { SessionDatabase } from './config/session_db.js';
import { checkForUpdates, performAutoUpdate, CURRENT_CLIENT_VERSION } from './updater/index.js';
import type { MessageContentPart, StreamEvent, ToolDefinition, RemoteSkill } from './types/index.js';

const PORT = Number(process.env.WEB_PORT || 8611);

interface WebSession {
  id: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  harness: AgentHarness;
  gateway: ModelGateway;
  registry: ToolRegistry;
  busy: boolean;
  pendingApprovals: Map<string, (approved: boolean) => void>;
  pendingQuestions: Map<string, (answer: string) => void>;
}

const sessions = new Map<string, WebSession>();

// 服务端集中分发的远程 Tools / Skills 缓存：启动与重连时后台同步，
// 会话创建时注入各自 registry（工具与技能随服务端热更新，客户端无需重发版）
let cachedRemoteSkills: RemoteSkill[] = [];
let cachedRemoteTools: ToolDefinition[] = [];
let globalMcpClient: McpRemoteClient | null = null;
let mcpConnected = false;

async function syncGlobalMcp(_url?: string, _token?: string): Promise<boolean> { return false; }

function openBrowser(url: string): void {
  if (process.env.WEB_NO_OPEN === '1') return;
  try {
    if (process.platform === 'win32') {
      // Windows 平台使用 start 唤起默认浏览器，避免终端阻塞
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    // 自动打开失败不影响服务
  }
}

function json(res: http.ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const buf = Buffer.concat(chunks);
  if (buf.length === 0) return {};

  // 1. 标准模式：全链路优先以标准 UTF-8 解码
  let raw = buf.toString('utf-8');

  // 2. 容错保护：若包含 Unicode 替换字符 \uFFFD（说明被 Windows 控制台/curl 误传了 GBK 字节流）
  // 自动自适应使用 TextDecoder('gbk') 还原原始中文字符，防止入库乱码
  if (raw.includes('\uFFFD')) {
    try {
      const gbkDecoder = new TextDecoder('gbk');
      const gbkDecoded = gbkDecoder.decode(buf);
      if (!gbkDecoded.includes('\uFFFD')) {
        raw = gbkDecoded;
      }
    } catch {}
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveWebDir(): string {
  // 1. Check relative to current process.cwd()
  const cwdWeb = path.join(process.cwd(), 'web');
  if (fs.existsSync(cwdWeb)) return cwdWeb;

  // 2. Check relative to compiled directory
  const currentFile = fileURLToPath(import.meta.url);
  const parentWeb = path.join(path.dirname(currentFile), '..', 'web');
  if (fs.existsSync(parentWeb)) return parentWeb;

  const sameLevelWeb = path.join(path.dirname(currentFile), 'web');
  if (fs.existsSync(sameLevelWeb)) return sameLevelWeb;

  return cwdWeb;
}

function getOrCreateSession(
  config: ReturnType<typeof loadConfig>,
  sessionId?: string,
  title?: string
): WebSession {
  const sessionDb = SessionDatabase.getInstance(path.join(os.homedir(), '.xkang', 'local-sessions.db'));

  if (sessionId && sessions.has(sessionId)) {
    return sessions.get(sessionId)!;
  }

  // 尝试从本地 SQLite 数据库恢复会话
  if (sessionId) {
    const persisted = sessionDb.getSession(sessionId);
    if (persisted) {
      const localCfg = loadUserLocalConfig();
      const effectiveToken = localCfg.token || config.token;
      const gateway = new ModelGateway(config);
      const registry = createDefaultToolRegistry();
      for (const tool of cachedRemoteTools) {
        registry.registerRemote(tool);
      }
      registry.setRemoteSkills(cachedRemoteSkills);
      const harness = new AgentHarness({
        gateway,
        registry,
        context: {
          repoPath: process.cwd(),
          localCwd: process.cwd(),
          serverUrl: config.serverUrl,
          token: effectiveToken,
        },
      });
      harness.restoreMessages(persisted.messages);
      const session: WebSession = {
        id: persisted.id,
        title: persisted.title,
        createdAt: persisted.createdAt,
        lastActiveAt: persisted.lastActiveAt,
        harness,
        gateway,
        registry,
        busy: false,
        pendingApprovals: new Map(),
        pendingQuestions: new Map(),
      };
      sessions.set(session.id, session);
      return session;
    }
  }

  // 创建全新会话并立即落库 SQLite
  const localCfg = loadUserLocalConfig();
  const effectiveToken = localCfg.token || config.token;
  const gateway = new ModelGateway(config);
  const registry = createDefaultToolRegistry();
  for (const tool of cachedRemoteTools) {
    registry.registerRemote(tool);
  }
  registry.setRemoteSkills(cachedRemoteSkills);
  const harness = new AgentHarness({
    gateway,
    registry,
    context: {
      repoPath: process.cwd(),
      localCwd: process.cwd(),
      serverUrl: config.serverUrl,
      token: effectiveToken,
    },
  });
  const now = new Date().toISOString();
  const newId = sessionId || `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const newTitle = title || '新排障会话';
  const session: WebSession = {
    id: newId,
    title: newTitle,
    createdAt: now,
    lastActiveAt: now,
    harness,
    gateway,
    registry,
    busy: false,
    pendingApprovals: new Map(),
    pendingQuestions: new Map(),
  };
  sessions.set(session.id, session);
  sessionDb.saveSession({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    messages: harness.getMessages(),
  });
  return session;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res: http.ServerResponse, urlPath: string, webDir: string): void {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(webDir, rel));
  // 必须带分隔符比较，防止 webDir 同前缀的兄弟目录 (如 web-secret) 绕过校验
  const allowedPrefix = webDir.endsWith(path.sep) ? webDir : webDir + path.sep;
  if (filePath !== webDir && !filePath.startsWith(allowedPrefix)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

export function startLocalWebServer(options?: { port?: number; autoOpen?: boolean }): Promise<http.Server> {
  const port = options?.port || PORT;
  const autoOpen = options?.autoOpen !== false;
  const config = loadConfig();
  const localCfg = loadUserLocalConfig();
  const webDir = resolveWebDir();

  // Background MCP Sync：拉取远程工具与集中 Skills 缓存（供后续会话注入）
  if (config.serverUrl && localCfg.token) {
    syncGlobalMcp(config.serverUrl, localCfg.token);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = url.pathname;

    try {
      // 静态文件服务
      if (!pathname.startsWith('/api/')) {
        serveStatic(res, pathname, webDir);
        return;
      }

      // Bootstrap 信息接口
      if (pathname === '/api/bootstrap' && req.method === 'GET') {
        const currentCfg = loadUserLocalConfig();
        if (!mcpConnected && config.serverUrl && currentCfg.token) {
          syncGlobalMcp(config.serverUrl, currentCfg.token);
        }
        json(res, 200, {
          repoName: '本机助手', mode: 'local',
          userName: currentCfg.userName || '客服专员',
          userToken: currentCfg.token ? `${currentCfg.token.slice(0, 8)}...` : '',
          serverUrl: '',
          mcpConnected,
          activeModelAlias: 'xkang-managed',
          activeModelDisplayName: '小康智能排障引擎 (Managed)',
        });
        return;
      }

      // 获取会话列表 (从 SQLite 永久读取)
      if (pathname === '/api/sessions' && req.method === 'GET') {
        const list = SessionDatabase.getInstance(path.join(os.homedir(), '.xkang', 'local-sessions.db')).listSessions();
        json(res, 200, { sessions: list });
        return;
      }

      // 创建新会话
      if (pathname === '/api/session' && req.method === 'POST') {
        const body = await readBody(req);
        const session = getOrCreateSession(
          config,
          undefined,
          typeof body.title === 'string' ? body.title : undefined
        );
        json(res, 200, {
          sessionId: session.id,
          title: session.title,
          createdAt: session.createdAt,
        });
        return;
      }

      // 获取指定会话消息 (内存优先，不存在时从 SQLite 自动恢复)
      const sessionGetMatch = pathname.match(/^\/api\/session\/([\w-]+)$/);
      if (sessionGetMatch && req.method === 'GET') {
        const session = getOrCreateSession(config, sessionGetMatch[1]);
        if (!session) {
          json(res, 404, { error: '会话不存在' });
          return;
        }
        const rawMessages = session.harness.getMessages();
        // 系统提示词与 harness 注入的提醒不是对话内容，不在界面展示
        const messages = rawMessages.filter((m) => m.role !== 'system' && !isReminderMessage(m));
        json(res, 200, {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
          busy: session.busy,
          messages,
        });
        return;
      }

      // 删除会话 (同时从内存与 SQLite 中移除)
      if (sessionGetMatch && req.method === 'DELETE') {
        const sid = sessionGetMatch[1];
        sessions.delete(sid);
        const exists = SessionDatabase.getInstance(path.join(os.homedir(), '.xkang', 'local-sessions.db')).deleteSession(sid);
        json(res, 200, { status: exists ? 'deleted' : 'not_found' });
        return;
      }

      // 会话流式 SSE 聊天
      const chatMatch = pathname.match(/^\/api\/session\/([\w-]+)\/chat$/);
      if (chatMatch && req.method === 'POST') {
        const session = getOrCreateSession(config, chatMatch[1]);
        if (!session) {
          json(res, 404, { error: '会话不存在或已失效，请刷新页面' });
          return;
        }
        if (session.busy) {
          json(res, 409, { error: '当前会话正在处理中，请稍候' });
          return;
        }
        const body = await readBody(req);
        let inputPayload: string | MessageContentPart[] = '';
        if (Array.isArray(body.parts) && body.parts.length > 0) {
          inputPayload = body.parts as MessageContentPart[];
        } else if (typeof body.message === 'string') {
          inputPayload = body.message;
        }

        if (!inputPayload || (typeof inputPayload === 'string' && !inputPayload.trim())) {
          json(res, 400, { error: '消息内容不能为空' });
          return;
        }

        let textForTitle = '';
        if (typeof inputPayload === 'string') {
          textForTitle = inputPayload;
        } else if (Array.isArray(inputPayload)) {
          const textPart = inputPayload.find((p) => p.type === 'text');
          if (textPart && 'text' in textPart) {
            textForTitle = textPart.text;
          } else {
            textForTitle = '图片排障会话';
          }
        }
        if (textForTitle.trim() && (session.title === '新排障会话' || !session.title)) {
          const clean = textForTitle.trim().replace(/\uFFFD/g, '').replace(/\s+/g, ' ').slice(0, 24);
          session.title = clean || '排障会话';
        }
        session.lastActiveAt = new Date().toISOString();

        // 立即持久化会话标题与活跃时间
        SessionDatabase.getInstance(path.join(os.homedir(), '.xkang', 'local-sessions.db')).saveSession({
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
          messages: session.harness.getMessages(),
        });

        session.busy = true;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        let clientDisconnected = false;
        const send = (payload: unknown) => {
          if (clientDisconnected) return;
          try {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          } catch {
            clientDisconnected = true;
          }
        };

        // 客户端中途断开（刷新/关页）时，自动放行挂起中的审批与提问门，
        // 让排障任务在后端继续完成并落库 SQLite；客服刷新页面后通过对账机制取回完整结果。
        // 否则 harness 会永远 await 无人触发的 Promise，busy 永久为 true 导致会话死锁。
        res.on('close', () => {
          if (session.busy) {
            clientDisconnected = true;
            for (const [reqId, resolve] of session.pendingApprovals.entries()) {
              resolve(false);
              session.pendingApprovals.delete(reqId);
            }
            for (const [reqId, resolve] of session.pendingQuestions.entries()) {
              resolve('（客户端已断开连接，客服未作答）');
              session.pendingQuestions.delete(reqId);
            }
          }
        });

        const forward = (event: StreamEvent) => {
          if (event.type === 'approval_requested') {
            session.pendingApprovals.set(event.request.id, event.resolve);
            send({ type: 'approval_requested', request: event.request });
          } else if (event.type === 'question_requested') {
            session.pendingQuestions.set(event.request.id, event.resolve);
            send({ type: 'question_requested', request: event.request });
          } else {
            send(event);
          }
        };

        try {
          await session.harness.run(inputPayload, forward);
        } catch (err) {
          send({ type: 'error', error: err instanceof Error ? err.message : String(err) });
        } finally {
          session.busy = false;
          session.pendingApprovals.clear();
          session.pendingQuestions.clear();
          session.lastActiveAt = new Date().toISOString();
          
          // 对话完成，全量同步落库 SQLite
          SessionDatabase.getInstance(path.join(os.homedir(), '.xkang', 'local-sessions.db')).saveSession({
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            lastActiveAt: session.lastActiveAt,
            messages: session.harness.getMessages(),
          });

          send({ type: 'stream_end' });
          try { res.end(); } catch { /* 连接可能已被客户端提前关闭 */ }
        }
        return;
      }

      // 审批门回调
      const approveMatch = pathname.match(/^\/api\/session\/([\w-]+)\/approve$/);
      if (approveMatch && req.method === 'POST') {
        const session = sessions.get(approveMatch[1]);
        if (!session) {
          json(res, 404, { error: '会话不存在' });
          return;
        }
        const body = await readBody(req);
        const requestId = String(body.requestId || '');
        const resolve = session.pendingApprovals.get(requestId);
        if (!resolve) {
          json(res, 404, { error: '审批请求不存在或已处理' });
          return;
        }
        session.pendingApprovals.delete(requestId);
        resolve(Boolean(body.approved));
        json(res, 200, { status: 'ok' });
        return;
      }

      // 提问门回答
      const answerMatch = pathname.match(/^\/api\/session\/([\w-]+)\/answer$/);
      if (answerMatch && req.method === 'POST') {
        const session = sessions.get(answerMatch[1]);
        if (!session) {
          json(res, 404, { error: '会话不存在' });
          return;
        }
        const body = await readBody(req);
        const requestId = String(body.requestId || '');
        const resolve = session.pendingQuestions.get(requestId);
        if (!resolve) {
          json(res, 404, { error: '提问请求不存在或已处理' });
          return;
        }
        session.pendingQuestions.delete(requestId);
        resolve(String(body.answer || ''));
        json(res, 200, { status: 'ok' });
        return;
      }

      // 提交排障反馈 (转发现给主服务端)
      if (pathname === '/api/feedback' && req.method === 'POST') {
        const body = await readBody(req);
        const currentCfg = loadUserLocalConfig();
        if (config.serverUrl && currentCfg.token) {
          try {
            const forwardRes = await fetch(`${config.serverUrl.replace(/\/$/, '')}/api/feedback`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${currentCfg.token}`,
              },
              body: JSON.stringify(body),
            });
            const data = await forwardRes.json();
            json(res, forwardRes.status, data);
            return;
          } catch (e) {
            // fallback
          }
        }
        json(res, 200, {
          status: 'success',
          message: '反馈已记录',
        });
        return;
      }

      // 版本检测接口
      if (pathname === '/api/version/check' && req.method === 'GET') {
        const result = await checkForUpdates(config.serverUrl);
        json(res, 200, {
          ...result,
          currentVersion: CURRENT_CLIENT_VERSION,
        });
        return;
      }

      // 在线一键热更新接口
      if (pathname === '/api/version/update' && req.method === 'POST') {
        const body = await readBody(req);
        const downloadUrl = String(body.downloadUrl || '');
        if (!downloadUrl) {
          const checkRes = await checkForUpdates(config.serverUrl);
          if (!checkRes.downloadUrl) {
            json(res, 400, { error: '未找到可用的下载更新地址' });
            return;
          }
          const updateRes = await performAutoUpdate(checkRes.downloadUrl);
          json(res, 200, updateRes);
          return;
        }
        const updateRes = await performAutoUpdate(downloadUrl);
        json(res, 200, updateRes);
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((resolve) => {
    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        const url = `http://localhost:${port}`;
        console.log(`\n💡 检测到 Web 服务已在后台运行中 (${url})，正在为您唤起浏览器...`);
        if (autoOpen) {
          openBrowser(url);
        }
        resolve(server);
      } else {
        console.error('Web 服务启动异常:', err.message);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const url = `http://localhost:${port}`;
      console.log('====================================================');
      console.log('🖥️  【小康 Web UI 智能排障终端】已启动');
      console.log(`   访问地址: ${url}`);
      console.log(`   绑定用户: ${localCfg.userName || '(已授权账号)'}`);
      console.log(`   调度底座: xkang-managed (集中统一调度, 免配置)`);
      console.log('====================================================');
      if (autoOpen) {
        openBrowser(url);
      }
      resolve(server);
    });
  });
}

// 直接以 `node dist/web_server.js` 运行时启动服务
if (process.argv[1] && process.argv[1].endsWith('local_web_server.js')) {
  startLocalWebServer({ autoOpen: process.env.WEB_NO_OPEN !== '1' });
}
