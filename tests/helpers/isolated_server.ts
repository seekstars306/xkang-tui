import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { DatabaseSync } from 'node:sqlite';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 探测 TCP 端口是否可达（内网数据库 / Grafana 在非内网环境下不可达时用于跳过相关测试） */
export function isTcpReachable(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

/** 读取 server/.env 中的配置（只在内存中使用，不落盘到任何临时目录） */
export function loadServerEnv(): Record<string, string> {
  const envPath = path.join(PROJECT_ROOT, 'server', '.env');
  if (!fs.existsSync(envPath)) return {};
  return dotenv.parse(fs.readFileSync(envPath));
}

/** 把 server/.env 的配置注入当前进程（用于在进程内直接调用工具函数的集成测试） */
export function applyServerEnvToProcess(): void {
  for (const [k, v] of Object.entries(loadServerEnv())) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export interface IsolatedServer {
  url: string;
  token: string;
  adminToken: string;
  readAudit: () => unknown[];
  logs: string[];
  stop: () => Promise<void>;
}

/**
 * 启动一个隔离的服务端实例用于测试：
 * - 独立端口与临时工作目录（审计库、令牌库都是全新的，不碰 server/data/xkang.db）
 * - 关闭定时代码同步（否则会对 D:\skt_project 执行 git pull / reset）
 * - 使用专用测试令牌；数据库/日志/模型凭据从 server/.env 读取后经环境变量传入
 */
export async function startIsolatedServer(port = 8691, model?: 'gemini' | 'deepseek' | 'grok'): Promise<IsolatedServer> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-server-it-'));
  const token = 'tok_it_runner';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...loadServerEnv(),
    ...(model ? { ACTIVE_MODEL: model } : {}),
    PORT: String(port),
    CODE_SYNC_ENABLED: 'false',
    XKANG_TOKENS: `${token}:集成测试`,
    XKANG_ADMIN_TOKENS: 'adm_it_runner:集成测试管理员',
    NODE_OPTIONS: '--max-old-space-size=8192',
  };
  const tsxLoader = pathToFileURL(path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  const child: ChildProcess = spawn(process.execPath, ['--import', tsxLoader, path.join(PROJECT_ROOT, 'server', 'src', 'index.ts')], {
    cwd: workDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logs: string[] = [];
  child.stdout?.on('data', (d) => logs.push(String(d)));
  child.stderr?.on('data', (d) => logs.push(String(d)));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`${url}/healthz`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  };
  if (!ready) {
    await stop();
    throw new Error(`隔离服务端启动失败:\n${logs.join('').slice(-3000)}`);
  }
  // 等待 CodeGraph 索引加载完成（日志中出现加载完成信息）
  const graphDeadline = Date.now() + 60000;
  while (Date.now() < graphDeadline && !logs.join('').includes('已加载分块图谱索引')) {
    await new Promise((r) => setTimeout(r, 500));
  }
  return { url, token, adminToken: 'adm_it_runner', logs, stop, readAudit: () => {
    const auditDb = new DatabaseSync(path.join(workDir, 'data', 'xkang.db'), { readOnly: true });
    try { return auditDb.prepare('SELECT * FROM audit_logs ORDER BY id').all(); } finally { auditDb.close(); }
  } };
}
