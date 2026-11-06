import { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AuthUser, AuditRecord, ServerConfig } from './types.js';
import { TokenManager } from './token_manager.js';

// Extend Express Request to carry user
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

import { DatabaseSync } from 'node:sqlite';
import { AppDatabase } from './db.js';

export class AuditLogger {
  private db: DatabaseSync;

  constructor(dbOrPath?: DatabaseSync | string) {
    if (dbOrPath && typeof dbOrPath === 'object' && 'prepare' in dbOrPath) {
      this.db = dbOrPath;
    } else {
      this.db = AppDatabase.getInstance().db;
    }
  }

  log(record: AuditRecord): void {
    try {
      this.db.prepare(`
        INSERT INTO audit_logs (
          timestamp, user, type, tool_name, model,
          prompt_tokens, completion_tokens, total_tokens,
          duration_ms, details, success, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.timestamp || new Date().toISOString(),
        record.user || 'anonymous',
        record.type,
        record.toolName || null,
        record.model || null,
        record.tokensUsed?.promptTokens || 0,
        record.tokensUsed?.completionTokens || 0,
        record.tokensUsed?.totalTokens || 0,
        record.durationMs || null,
        record.details ? JSON.stringify(record.details) : null,
        record.success ? 1 : 0,
        record.error || null
      );
    } catch (err) {
      console.error('[AuditLogger] 写入 SQLite 审计日志失败:', err instanceof Error ? err.message : err);
    }
  }

  queryRecent(limit = 100): unknown[] {
    return this.db.prepare(`
      SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?
    `).all(limit);
  }
}

export class RateLimiter {
  private windowMs = 60 * 1000;
  private maxRequests: number;
  private hits = new Map<string, number[]>();

  constructor(maxRequestsPerMinute: number) {
    this.maxRequests = maxRequestsPerMinute;
  }

  isAllowed(token: string): boolean {
    const now = Date.now();
    const timestamps = this.hits.get(token) || [];
    const validTimestamps = timestamps.filter((t) => now - t < this.windowMs);

    if (validTimestamps.length >= this.maxRequests) {
      return false;
    }

    validTimestamps.push(now);
    this.hits.set(token, validTimestamps);
    return true;
  }
}

export function createAuthMiddleware(
  config: ServerConfig,
  audit: AuditLogger,
  limiter: RateLimiter,
  tokenManager?: TokenManager
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      audit.log({
        timestamp: new Date().toISOString(),
        user: 'unknown',
        type: 'auth_failure',
        success: false,
        error: 'Missing or malformed Authorization header',
      });
      res.status(401).json({ error: 'Unauthorized: Bearer token required' });
      return;
    }

    const token = authHeader.slice(7).trim();
    const deviceId = (req.headers['x-device-id'] as string) || (req.query.deviceId as string) || '';
    const ip = req.ip || req.socket.remoteAddress;

    let userName: string | undefined;

    // 1. Check with TokenManager (with Device ID Lock) if available
    if (tokenManager) {
      const authResult = tokenManager.authenticateRequest(token, deviceId, ip);
      if (!authResult.valid) {
        audit.log({
          timestamp: new Date().toISOString(),
          user: authResult.name || 'unknown',
          type: 'auth_failure',
          details: { tokenPrefix: token.slice(0, 4) + '***', deviceId, ip },
          success: false,
          error: authResult.error || 'Authentication failed',
        });
        res.status(403).json({ error: `Forbidden: ${authResult.error}` });
        return;
      }
      userName = authResult.name;
    } else {
      // Fallback to static in-memory map
      userName = config.tokens.get(token);
      if (!userName) {
        audit.log({
          timestamp: new Date().toISOString(),
          user: 'unknown',
          type: 'auth_failure',
          details: { tokenPrefix: token.slice(0, 4) + '***' },
          success: false,
          error: 'Invalid token',
        });
        res.status(403).json({ error: 'Forbidden: Invalid employee token' });
        return;
      }
    }

    if (!limiter.isAllowed(token)) {
      res.status(429).json({ error: 'Too Many Requests: Rate limit exceeded' });
      return;
    }

    req.user = { token, name: userName!, subjectId: tokenManager ? tokenManager.getSubjectId(token) : createHash('sha256').update(token).digest('hex') };
    next();
  };
}

export function createAdminMiddleware(config: ServerConfig, audit: AuditLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      audit.log({
        timestamp: new Date().toISOString(),
        user: 'unknown',
        type: 'auth_failure',
        success: false,
        error: 'Admin authorization header missing',
      });
      res.status(401).json({ error: 'Unauthorized: Admin Bearer token required' });
      return;
    }

    const token = authHeader.slice(7).trim();
    const adminName = config.adminTokens.get(token);

    if (!adminName) {
      audit.log({
        timestamp: new Date().toISOString(),
        user: 'unknown',
        type: 'auth_failure',
        details: { tokenPrefix: token.slice(0, 4) + '***', target: 'admin_api' },
        success: false,
        error: 'Invalid admin token',
      });
      res.status(403).json({ error: 'Forbidden: Valid admin token required' });
      return;
    }

    req.user = { token, name: `admin:${adminName}` };
    next();
  };
}
