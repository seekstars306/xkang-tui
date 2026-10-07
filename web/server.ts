/**
 * xhang Web UI 本地预览服务
 * - 托管 web/ 下的静态页面(免构建)
 * - 通过 SSE 将 AgentHarness 的流式事件(内容/工具/审批门/提问门)桥接到浏览器
 * - 支持会话持久管理(新建会话、会话列表、历史记录回溯)
 * - 移除客户端模型切换(统一使用服务端集中调度底座)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/models.js';
import { ModelGateway } from '../src/adapters/gateway.js';
import { AgentHarness } from '../src/harness/agent.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import type { ToolRegistry } from '../src/tools/registry.js';
import { McpRemoteClient } from '../src/mcp/client.js';
import { loadUserLocalConfig } from '../src/config/user_config.js';
import { runBindWizard } from './bind_wizard.js';
import { AppDatabase } from '../server/src/db.js';
import { TokenManager } from '../server/src/token_manager.js';
import { FeedbackManager } from '../server/src/feedback_manager.js';
import type { MessageContentPart, StreamEvent } from '../src/types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = __dirname;
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
const config = loadConfig();
let mcpConnected = false;

function openBrowser(url: string): void {
  if (process.env.WEB_NO_OPEN === '1') return;
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // 自动打开失败不影响服务,用户可手动访问
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
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function createSession(title?: string): WebSession {
  const localCfg = loadUserLocalConfig();
  const effectiveToken = localCfg.token || config.token;
  const gateway = new ModelGateway(config);
  const registry = createDefaultToolRegistry();
  const harness = new AgentHarness({
    gateway,
    registry,
    context: {
      repoPath: localCfg.codeRepoPath || config.codeRepoPath,
      localCwd: process.cwd(),
      serverUrl: config.serverUrl,
      token: effectiveToken,
    },
  });
  const now = new Date().toISOString();
  const session: WebSession = {
    id: `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    title: title || '新排障会话',
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

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(WEB_DIR, rel));
  if (!filePath.startsWith(WEB_DIR)) {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // ---- 静态资源 ----
    if (!pathname.startsWith('/api/')) {
      serveStatic(res, pathname);
      return;
    }

    // ---- 引导信息: Key 生成时绑定的真实姓名 / 业务中心 / 统一调度底座 ----
    if (pathname === '/api/bootstrap' && req.method === 'GET') {
      const localCfg = loadUserLocalConfig();
      const tokenManager = new TokenManager(AppDatabase.getInstance({ dataDir: './server/data' }).db);
      
      let realUserName = '未绑定用户';
      if (localCfg.token) {
        const tokenRec = tokenManager.getToken(localCfg.token);
        if (tokenRec && tokenRec.name) {
          realUserName = tokenRec.name;
        } else if (localCfg.userName) {
          realUserName = localCfg.userName;
        }
      } else if (localCfg.userName) {
        realUserName = localCfg.userName;
      }

      json(res, 200, {
        repoName: '业务排障服务中心',
        userName: realUserName,
        userToken: localCfg.token ? `${localCfg.token.slice(0, 8)}...` : '',
        serverUrl: config.serverUrl || '',
        mcpConnected,
        activeModelAlias: 'xkang-managed',
        activeModelDisplayName: '小康智能排障引擎 (Managed)',
      });
      return;
    }

    // ---- 获取所有历史会话列表 ----
    if (pathname === '/api/sessions' && req.method === 'GET') {
      const list = Array.from(sessions.values()).map((s) => {
        const msgs = s.harness.getMessages().filter((m) => m.role !== 'system');
        let lastSnippet = '';
        if (msgs.length > 0) {
          const last = msgs[msgs.length - 1];
          if (typeof last.content === 'string') {
            lastSnippet = last.content.slice(0, 60);
          } else if (Array.isArray(last.content)) {
            const txt = last.content.find((p) => p.type === 'text');
            lastSnippet = txt && 'text' in txt ? txt.text.slice(0, 60) : '[图片附件]';
          }
        }
        return {
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          lastActiveAt: s.lastActiveAt,
          messageCount: msgs.length,
          lastSnippet,
        };
      }).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
      json(res, 200, { sessions: list });
      return;
    }

    // ---- 创建新会话 ----
    if (pathname === '/api/session' && req.method === 'POST') {
      const body = await readBody(req);
      const session = createSession(typeof body.title === 'string' ? body.title : undefined);
      json(res, 200, {
        sessionId: session.id,
        title: session.title,
        createdAt: session.createdAt,
      });
      return;
    }

    // ---- 获取指定会话历史记录 ----
    const sessionGetMatch = pathname.match(/^\/api\/session\/([\w-]+)$/);
    if (sessionGetMatch && req.method === 'GET') {
      const session = sessions.get(sessionGetMatch[1]);
      if (!session) {
        json(res, 404, { error: '会话不存在' });
        return;
      }
      const rawMessages = session.harness.getMessages();
      const messages = rawMessages.filter((m) => m.role !== 'system');
      json(res, 200, {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        messages,
      });
      return;
    }

    // ---- 删除会话 ----
    if (sessionGetMatch && req.method === 'DELETE') {
      const exists = sessions.delete(sessionGetMatch[1]);
      json(res, 200, { status: exists ? 'deleted' : 'not_found' });
      return;
    }

    // ---- 会话消息: SSE 流式返回 Agent 事件 (支持字符串或多模态数组) ----
    const chatMatch = pathname.match(/^\/api\/session\/([\w-]+)\/chat$/);
    if (chatMatch && req.method === 'POST') {
      const session = sessions.get(chatMatch[1]);
      if (!session) {
        json(res, 404, { error: '会话不存在或已失效,请刷新页面' });
        return;
      }
      if (session.busy) {
        json(res, 409, { error: '当前会话正在处理中,请稍候' });
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

      // 自动从第一条消息提取会话标题
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
        session.title = textForTitle.trim().replace(/\s+/g, ' ').slice(0, 24);
      }
      session.lastActiveAt = new Date().toISOString();

      session.busy = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (payload: unknown) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

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
        send({ type: 'stream_end' });
        res.end();
      }
      return;
    }

    // ---- 审批门决定 ----
    const approveMatch = pathname.match(/^\/api\/session\/([\w-]+)\/approve$/);
    if (approveMatch && req.method === 'POST') {
      const session = sessions.get(approveMatch[1]);
      const body = await readBody(req);
      const requestId = String(body.requestId || '');
      const resolve = session?.pendingApprovals.get(requestId);
      if (!resolve) {
        json(res, 404, { error: '审批请求不存在或已处理' });
        return;
      }
      session.pendingApprovals.delete(requestId);
      resolve(Boolean(body.approved));
      json(res, 200, { status: 'ok' });
      return;
    }

    // ---- 提问门回答 ----
    const answerMatch = pathname.match(/^\/api\/session\/([\w-]+)\/answer$/);
    if (answerMatch && req.method === 'POST') {
      const session = sessions.get(answerMatch[1]);
      const body = await readBody(req);
      const requestId = String(body.requestId || '');
      const resolve = session?.pendingQuestions.get(requestId);
      if (!resolve) {
        json(res, 404, { error: '提问请求不存在或已处理' });
        return;
      }
      session.pendingQuestions.delete(requestId);
      resolve(String(body.answer || ''));
      json(res, 200, { status: 'ok' });
      return;
    }

    // ---- 提交错误与排障反馈接口 (统一写入 SQLite cs_feedbacks) ----
    if (pathname === '/api/feedback' && req.method === 'POST') {
      const body = await readBody(req);
      const content = String(body.content || '').trim();
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
      const feedbackType = String(body.feedbackType || '排障异常反馈');
      const localCfg = loadUserLocalConfig();

      if (!content) {
        json(res, 400, { error: '反馈描述不能为空' });
        return;
      }

      // 获取当前会话的历史上下文与工具证据
      let contextMessages: unknown[] = [];
      let sessionTitle = '未关联会话';
      if (sessionId && sessions.has(sessionId)) {
        const targetSession = sessions.get(sessionId)!;
        sessionTitle = targetSession.title;
        contextMessages = targetSession.harness.getMessages().filter((m) => m.role !== 'system');
      } else if (Array.isArray(body.messages)) {
        contextMessages = body.messages;
      }

      const feedbackManager = new FeedbackManager(AppDatabase.getInstance().db);
      const record = feedbackManager.createFeedback({
        userName: localCfg.userName || config.userName || '客服专员',
        userToken: localCfg.token,
        feedbackType,
        content,
        sessionId,
        sessionTitle,
        context: contextMessages,
      });

      console.log(`[feedback] 收到来自 [${record.userName}] 的反馈: [${feedbackType}] ${content.slice(0, 40)} (已存入 SQLite cs_feedbacks, 附带 ${contextMessages.length} 条上下文)`);

      json(res, 200, {
        status: 'success',
        feedbackId: record.id,
        message: '排障问题与会话上下文已成功录入数据库！',
      });
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

// 启动主流程:未绑定 Key 时先在当前终端完成激活向导,再启动 Web 服务
async function main(): Promise<void> {
  let localCfg = loadUserLocalConfig();
  if (!localCfg.token) {
    console.log('====================================================');
    console.log('🔒 检测到本机尚未绑定访问 Key,请先在下方终端向导中完成绑定。');
    console.log('   (绑定成功后将自动启动 Web UI;按 Ctrl+C 可取消退出)');
    console.log('====================================================');
    const ok = await runBindWizard();
    if (!ok) {
      console.log('\n❌ 未完成 Key 绑定,Web UI 未启动。可随时重新运行 npm run web。');
      process.exit(1);
    }
    localCfg = loadUserLocalConfig();
    if (!localCfg.token) {
      console.log('\n❌ 绑定结果未写入本地配置,Web UI 未启动。');
      process.exit(1);
    }
    console.log(`\n✅ Key 绑定成功${localCfg.userName ? ` (${localCfg.userName})` : ''},正在启动 Web UI...`);
  }

  // 后台尝试连接公司服务端 MCP(失败不影响本地工具使用)
  if (config.serverUrl && localCfg.token) {
    (async () => {
      try {
        const registry = createDefaultToolRegistry();
        const mcpClient = new McpRemoteClient({
          serverUrl: config.serverUrl!,
          token: localCfg.token!,
        });
        const result = await registry.syncWithRemote(mcpClient);
        mcpConnected = result.connected;
        console.log(`[web] 公司服务端 MCP ${mcpConnected ? '已连接' : '未连接'}: ${config.serverUrl}`);
      } catch (err) {
        console.log(`[web] 公司服务端 MCP 连接失败(继续使用本地工具): ${err instanceof Error ? err.message : err}`);
      }
    })();
  }

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log('====================================================');
    console.log('🖥️  xhang Web UI 智能排障终端已启动');
    console.log(`   访问地址: ${url}`);
    console.log(`   绑定用户: ${localCfg.userName || '(未提供姓名)'}`);
    console.log(`   代码仓库: ${config.codeRepoPath}`);
    console.log(`   服务端:   ${config.serverUrl || '(未配置)'} [MCP${mcpConnected ? '已连接' : '未连接'}]`);
    console.log(`   调度底座: xkang-managed (集中统一调度,客户端免配置)`);
    console.log('   停止服务: 在终端按 Ctrl+C');
    console.log('====================================================');
    openBrowser(url);
  });
}

main().catch((err) => {
  console.error('[web] 启动失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
