import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import type { ServerConfig } from '../types.js';
import { getMonitorDb } from './monitor_db.js';
import { readSession, type MonitorAccount, type SessionPayload } from './monitor_auth.js';
import {
  CONFIG_FIELDS, configField, describeConfig, editableKeys, envFilePath, validateConfigValue, writeEnvFile,
  type EnvChange,
} from './console_config.js';
import { listMcpStatus, startMcpService, stopMcpService } from './console_mcp.js';
import {
  appendAudit, ensureKeeper, KEEPER_PORT, findBridge, findServerProcesses, isRunning, planServerRestart, planServerStop, repoRoot, startBridge, startServerProcess, terminate,
} from './console_process.js';

/**
 * 服务端控制台接口（挂在 /admin/feishu/console 下，复用监控台登录态）。
 *
 * 设计上的三条克制：
 *   1. 能把自己锁在门外的配置（监控台账号/会话密钥、员工/管理员令牌）只读，不给改；
 *      端口、监听地址这类改错就连不上的，也在 hint 里写清后果。
 *   2. 停止/重启前先看在途任务：start_production.ps1 的注释早就写明"看到任务在跑仍强行重启"
 *      会打断同事的排查，2026-11-04 我犯过一次，这里把校验做进接口而不是靠人记得。
 *   3. 每个动作都写审计（谁、什么时候、影响了哪些 pid/键），密钥值一律不记录。
 */

export interface ConsoleOptions {
  accounts: MonitorAccount[];
  sessionSecret: string;
  config: ServerConfig;
}

interface RestartStatusFile {
  state?: string;
  at?: string;
  pid?: number;
  error?: string;
  command?: string;
}

function diagnosticsDir(): string {
  return path.join(repoRoot(import.meta.url), 'server/data/diagnostics');
}

function readRestartStatus(): RestartStatusFile | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(diagnosticsDir(), 'restart-status.json'), 'utf8'));
  } catch { return null; }
}

/**
 * 控制台鉴权：监控台会话 Cookie，或**校验过的**管理员令牌。
 *
 * 为什么不直接复用监控台的 auth：monitor_auth.ts 的 createMonitorAuth 对 Bearer 是"非空即过"
 * （脚本兼容分支），只读接口这么办可以接受；但控制台多了"重启服务端"和"改 .env"这类写操作，
 * 再放行任意 Bearer 字符串，等于把这台机器的控制权开放给任何能连上 8600 的人。
 */
export function consoleAuth(options: ConsoleOptions) {
  const accounts = new Map(options.accounts.map(a => [a.username, a]));
  return (req: Request, res: Response, next: () => void): void => {
    const session = readSession(req, options.sessionSecret) as SessionPayload | null;
    if (session && accounts.has(session.u)) {
      (req as any).user = { token: '', name: session.u };
      next();
      return;
    }
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7).trim();
      const name = options.config.adminTokens.get(token);
      if (name) {
        (req as any).user = { token, name: 'admin:' + name };
        next();
        return;
      }
      res.status(403).json({ error: '需要有效的监控台会话或管理员令牌' });
      return;
    }
    const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
    if (wantsHtml && req.method === 'GET') { res.redirect(302, '/admin/feishu/login'); return; }
    res.status(401).json({ error: '未登录' });
  };
}

export function mountFeishuConsole(app: Express, options: ConsoleOptions): void {
  const auth = consoleAuth(options) as unknown as (req: Request, res: Response, next: () => void) => void;
  const db = () => getMonitorDb();
  // 接棒小服务：服务端被控制台停掉之后，页面还能靠它把服务端拉回来。
  // 定时兜底两个作用：keeper 自己挂了要拉起来；keeper 发现脚本更新自行退出后，
  // 15 秒内要有新的一份接上（否则改完代码不重启服务端，旧 keeper 会一直跑旧逻辑）。
  const keeper = ensureKeeper(import.meta.url);
  const keeperTimer = setInterval(() => { ensureKeeper(import.meta.url); }, 15000);
  keeperTimer.unref();
  const actor = (req: Request) => String((req as any).user?.name || 'unknown');

  /** 在途任务：跑着的 + 排队的。重启/停桥都会打断它们，必须先给人看。 */
  const inFlight = () => {
    const rows = [...db().listTasks({ status: 'running', limit: 200 }), ...db().listTasks({ status: 'queued', limit: 200 })];
    return rows.map(t => ({ id: t.id, chatName: t.chat_name, status: t.status, startedAt: t.started_at, preview: (t.input_text ?? '').slice(0, 80) }));
  };

  app.get('/admin/feishu/console/status', auth, (_req, res) => {
    try {
      const bridge = findBridge();
      const running = inFlight();
      res.json({
        server: {
          pid: process.pid,
          startedAt: new Date(process.uptime() ? Date.now() - process.uptime() * 1000 : Date.now()).toISOString(),
          uptimeSeconds: Math.round(process.uptime()),
          node: process.version,
          platform: process.platform,
          cwd: process.cwd(),
          port: options.config.port,
          reviewMode: process.env.REVIEW_MODE ?? '(未设置→gate)',
          reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT ?? '(未设置)',
          contextTokens: options.config.contextTokens ?? '(未设置)',
          codeRepoPath: options.config.codeRepoPath || '(未配置)',
          activeModel: process.env.ACTIVE_MODEL ?? '(未设置)',
          serverProcessCount: findServerProcesses().length,
        },
        serverRunning: true,
        keeper: { ok: keeper.ok, port: KEEPER_PORT, error: keeper.error },
        bridge: {
          running: isRunning(bridge),
          pid: bridge?.pid ?? null,
          startedAt: bridge?.startedAt ?? null,
          commandLine: bridge?.commandLine ?? null,
        },
        inFlight: running,
        restart: readRestartStatus(),
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.post('/admin/feishu/console/bridge/:action', auth, (req, res) => {
    const action = String(req.params.action);
    if (!['start', 'stop', 'restart'].includes(action)) { res.status(400).json({ error: '动作只能是 start/stop/restart' }); return; }
    const current = findBridge();
    const running = inFlight();
    const who = actor(req);
    try {
      if (action === 'start') {
        if (isRunning(current)) { res.json({ ok: true, already: true, pid: current!.pid }); return; }
        const r = startBridge(import.meta.url);
        appendAudit(import.meta.url, { at: new Date().toISOString(), actor: who, action: 'bridge.start', detail: { ok: r.ok, pid: r.pid, error: r.error } });
        res.json(r.ok ? { ok: true, already: (r as any).already === true, pid: r.pid, logFile: r.logFile } : { ok: false, error: r.error });
        return;
      }
      if (!isRunning(current)) {
        appendAudit(import.meta.url, { at: new Date().toISOString(), actor: who, action: 'bridge.' + action, detail: { ok: false, error: '飞书桥未在运行' } });
        res.status(409).json({ error: '飞书桥未在运行' });
        return;
      }
      if (action === 'stop' && running.length > 0 && req.body?.force !== true) {
        res.status(409).json({ error: '有 ' + running.length + ' 个排查正在进行，停止飞书桥会中断它们。确认要中断请带 force=true。', inFlight: running });
        return;
      }
      const stopped = terminate(current!.pid);
      if (!stopped.ok) {
        appendAudit(import.meta.url, { at: new Date().toISOString(), actor: who, action: 'bridge.' + action, detail: { ok: false, pid: current!.pid, error: stopped.error } });
        res.status(500).json({ error: stopped.error });
        return;
      }
      const detail: Record<string, unknown> = { ok: true, pid: current!.pid, interrupted: running.length };
      if (action === 'restart') {
        const r = startBridge(import.meta.url);
        detail.restarted = r.ok;
        detail.newPid = r.pid;
        if (!r.ok) detail.error = r.error;
      }
      appendAudit(import.meta.url, { at: new Date().toISOString(), actor: who, action: 'bridge.' + action, detail });
      res.json({ ok: true, ...detail });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/admin/feishu/console/server/stop', auth, (req, res) => {
    const running = inFlight();
    const who = actor(req);
    if (running.length > 0 && req.body?.force !== true) {
      res.status(409).json({
        error: '有 ' + running.length + ' 个排查正在进行，停止服务端会中断它们。确认要中断请带 force=true。',
        inFlight: running,
      });
      return;
    }
    const plan = planServerStop(import.meta.url);
    appendAudit(import.meta.url, {
      at: new Date().toISOString(), actor: who, action: 'server.stop',
      detail: { ok: plan.ok, error: plan.error, interrupted: running.length, command: plan.command },
    });
    if (!plan.ok) { res.status(500).json({ error: plan.error }); return; }
    res.json({ ok: true, command: plan.command, exitingInMs: 1500 });
    setTimeout(() => process.exit(0), 1500).unref();
  });

  app.post('/admin/feishu/console/server/start', auth, (_req, res) => {
    const who = actor(_req);
    const r = startServerProcess(import.meta.url);
    appendAudit(import.meta.url, { at: new Date().toISOString(), actor: who, action: 'server.start', detail: { ok: r.ok, pid: r.pid, error: r.error } });
    res.json(r.ok ? { ok: true, pid: r.pid, logFile: r.logFile } : { ok: false, error: r.error });
  });

  app.post('/admin/feishu/console/server/restart', auth, (req, res) => {
    const running = inFlight();
    const who = actor(req);
    if (running.length > 0 && req.body?.force !== true) {
      res.status(409).json({
        error: '有 ' + running.length + ' 个排查正在进行，重启服务端会中断它们。确认要中断请带 force=true。',
        inFlight: running,
      });
      return;
    }
    const plan = planServerRestart(import.meta.url);
    appendAudit(import.meta.url, {
      at: new Date().toISOString(), actor: who, action: 'server.restart',
      detail: { ok: plan.ok, relauncherPid: plan.relauncherPid, error: plan.error, interrupted: running.length, command: plan.command },
    });
    if (!plan.ok) { res.status(500).json({ error: plan.error }); return; }
    // 先应答再退出：否则客户端只看到连接被重置，不知道重启有没有被安排
    res.json({ ok: true, relauncherPid: plan.relauncherPid, statusFile: plan.statusFile, command: plan.command, exitingInMs: 1500 });
    setTimeout(() => process.exit(0), 1500).unref();
  });

  app.get('/admin/feishu/console/config', auth, (_req, res) => {
    try {
      const text = fs.readFileSync(envFilePath(), 'utf8');
      res.json({
        groups: [...new Set(CONFIG_FIELDS.map(f => f.group))],
        fields: describeConfig(text),
        envFile: envFilePath(),
        restartStatus: readRestartStatus(),
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.post('/admin/feishu/console/config', auth, (req, res) => {
    const changes = Array.isArray(req.body?.changes) ? req.body.changes as EnvChange[] : [];
    if (!changes.length) { res.status(400).json({ error: '没有要保存的改动' }); return; }
    const allowed = new Set(editableKeys());
    const bad: string[] = [];
    for (const c of changes) {
      const field = configField(String(c.key));
      if (!field) { bad.push('未知配置项：' + c.key); continue; }
      if (field.readOnly || !allowed.has(field.key)) { bad.push(field.label + ' 不允许在控制台修改'); continue; }
      const err = validateConfigValue(field, String(c.value ?? ''));
      if (err) bad.push(field.label + '：' + err);
    }
    if (bad.length) { res.status(400).json({ error: bad.join('；') }); return; }

    const r = writeEnvFile(envFilePath(), changes.map(c => ({ key: String(c.key), value: String(c.value ?? '') })));
    const restartRequired = changes.map(c => String(c.key)).filter(k => configField(k)?.restartRequired);
    appendAudit(import.meta.url, {
      at: new Date().toISOString(), actor: actor(req), action: 'config.save',
      detail: { ok: r.ok, added: r.added, updated: r.updated, backupPath: r.backupPath, error: r.error, keys: changes.map(c => String(c.key)) },
    });
    if (!r.ok) { res.status(500).json({ error: r.error }); return; }
    res.json({ ok: true, added: r.added, updated: r.updated, backupPath: r.backupPath, restartRequired });
  });

  app.get('/admin/feishu/console/mcp', auth, (_req, res) => {
    try { res.json({ services: listMcpStatus(import.meta.url) }); }
    catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.post('/admin/feishu/console/mcp/:name/:action', auth, (req, res) => {
    const name = String(req.params.name);
    const action = String(req.params.action);
    if (!['start', 'stop', 'restart'].includes(action)) { res.status(400).json({ error: '动作只能是 start/stop/restart' }); return; }
    const who = actor(req);
    try {
      if (action === 'stop' || action === 'restart') {
        const r = stopMcpService(name, import.meta.url);
        // 停一个本来就没在跑的服务不算失败，但要说清楚，别让人以为生效了
        if (!r.ok && !/未在运行/.test(r.error || '')) {
          appendAudit(import.meta.url, { at: new Date().toISOString(), actor: who, action: 'mcp.' + action, detail: { ok: false, name, error: r.error } });
          res.status(500).json({ error: r.error });
          return;
        }
        appendAudit(import.meta.url, { at: new Date().toISOString(), actor: who, action: 'mcp.' + action, detail: { ok: true, name, pid: r.pid, wasRunning: r.ok } });
        if (action === 'stop') { res.json({ ok: true, name, wasRunning: r.ok }); return; }
      }
      const r = startMcpService(name, import.meta.url);
      appendAudit(import.meta.url, { at: new Date().toISOString(), actor: who, action: 'mcp.' + action, detail: { ok: r.ok, name, pid: r.pid, error: r.error } });
      res.json(r.ok ? { ok: true, name, pid: r.pid, logFile: r.logFile, already: !r.logFile } : { ok: false, error: r.error });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  app.get('/admin/feishu/console/audit', auth, (req, res) => {
    try {
      const p = path.join(diagnosticsDir(), 'console-actions.jsonl');
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
      const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
      res.json(lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } }));
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });
}
