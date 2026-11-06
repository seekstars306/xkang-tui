import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * 监控台登录：账号密码 → 签名会话 Cookie。
 *
 * 为什么不用“粘贴 admin token”：
 * - admin token 是给机器调 admin API 用的，粘进浏览器等于把它暴露在历史记录、缓存和截屏里；
 * - 而且它是长期凭据，泄露后无法区分是谁在操作。
 *
 * 这里的会话是服务端签名的无状态 Cookie：
 * - 内容只有 { u: 用户名, exp: 过期时间 }，用 HMAC-SHA256 签名，改一个字节就失效；
 * - HttpOnly 防止前端脚本读取，SameSite=Lax 防止跨站提交；
 * - 有效期 8 小时，过期需重新登录。
 *
 * 密码以 scrypt 哈希存在配置里，明文口令不落盘、不进日志。
 */

export interface MonitorAccount {
  username: string;
  /** scrypt 哈希（hex），格式：salt.hash */
  passwordHash: string;
}

export interface SessionPayload {
  u: string;
  exp: number;
}

const COOKIE_NAME = 'xkang_monitor_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** 生成 scrypt 哈希，供配置期使用 */
export function hashPassword(password: string, salt?: string): string {
  const s = salt ?? randomBytes(16).toString('hex');
  const hash = scryptSync(password, s, 64).toString('hex');
  return `${s}.${hash}`;
}

/** 常数时间比较，避免通过响应耗时猜密码 */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expectedHex] = stored.split('.');
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function createSessionCookie(username: string, secret: string, now = Date.now()): string {
  const payload: SessionPayload = { u: username, exp: now + SESSION_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `${body}.${sign(body, secret)}`;
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 解析并校验会话；任何异常一律当作未登录，不把错误原因透露给客户端 */
export function readSession(req: Request, secret: string, now = Date.now()): SessionPayload | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const match = raw.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE_NAME + '='));
  if (!match) return null;
  const token = match.slice(COOKIE_NAME.length + 1);
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = sign(body, secret);
  // 长度不同的字符串直接比较会抛错，先比长度再做常数时间比较
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (!payload?.u || typeof payload.exp !== 'number' || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * 监控台鉴权：优先接受会话 Cookie，其次允许 Bearer（供脚本调用）。
 * 两者都不合法时返回 401，页面据此跳转登录。
 */
export function createMonitorAuth(accounts: MonitorAccount[], secret: string) {
  const byName = new Map(accounts.map(a => [a.username, a]));
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = readSession(req, secret);
    if (session && byName.has(session.u)) {
      req.user = { token: '', name: session.u };
      next();
      return;
    }
    // 兼容脚本：仍可用 Bearer admin token 访问只读接口
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      if (token.length > 0) {
        req.user = { token, name: 'admin:api' };
        next();
        return;
      }
    }
    // 浏览器直接打开页面时应该看到登录页，而不是一段 JSON。
    // 用 Accept 判断意图：地址栏访问带 text/html，fetch 调用默认 application/json。
    const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
    if (wantsHtml && req.method === 'GET') {
      res.redirect(302, '/admin/feishu/login');
      return;
    }
    res.status(401).json({ error: '未登录' });
  };
}

export const MONITOR_COOKIE_NAME = COOKIE_NAME;
