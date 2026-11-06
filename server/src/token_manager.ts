/**
 * TokenManager - 基于 SQLite 统一存储的员工密钥与设备指纹绑定管理器
 */
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AppDatabase } from './db.js';

export interface UserTokenRecord {
  token: string;
  name: string;
  createdAt: string;
  boundDeviceId?: string;
  lastUsedAt?: string;
  lastIp?: string;
  enabled: boolean;
}

export class TokenManager {
  private db: DatabaseSync;

  constructor(dbOrPath?: DatabaseSync | string) {
    if (dbOrPath && typeof dbOrPath === 'object' && 'prepare' in dbOrPath) {
      this.db = dbOrPath;
    } else {
      this.db = AppDatabase.getInstance().db;
    }
  }

  public seedInitialTokens(envTokens: Map<string, string>): void {
    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO auth_tokens (token, name, created_at, enabled)
      VALUES (?, ?, ?, 1)
    `);
    const now = new Date().toISOString();
    for (const [token, name] of envTokens.entries()) {
      insertStmt.run(token, name, now);
    }
  }

  public createToken(name: string): UserTokenRecord {
    const randomBytes = crypto.randomBytes(8).toString('hex');
    const token = `tok_skt_${randomBytes}`;
    const createdAt = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO auth_tokens (token, name, created_at, enabled)
      VALUES (?, ?, ?, 1)
    `).run(token, name, createdAt);

    return {
      token,
      name,
      createdAt,
      enabled: true,
    };
  }

  public listTokens(): UserTokenRecord[] {
    const rows = this.db.prepare(`
      SELECT token, name, created_at as createdAt, bound_device_id as boundDeviceId,
             last_used_at as lastUsedAt, last_ip as lastIp, enabled
      FROM auth_tokens
      ORDER BY created_at DESC
    `).all() as any[];

    return rows.map((r) => ({
      token: r.token,
      name: r.name,
      createdAt: r.createdAt,
      boundDeviceId: r.boundDeviceId || undefined,
      lastUsedAt: r.lastUsedAt || undefined,
      lastIp: r.lastIp || undefined,
      enabled: Boolean(r.enabled),
    }));
  }

  public getToken(token: string): UserTokenRecord | undefined {
    const row = this.db.prepare(`
      SELECT token, name, created_at as createdAt, bound_device_id as boundDeviceId,
             last_used_at as lastUsedAt, last_ip as lastIp, enabled
      FROM auth_tokens
      WHERE token = ?
    `).get(token) as any;

    if (!row) return undefined;
    return {
      token: row.token,
      name: row.name,
      createdAt: row.createdAt,
      boundDeviceId: row.boundDeviceId || undefined,
      lastUsedAt: row.lastUsedAt || undefined,
      lastIp: row.lastIp || undefined,
      enabled: Boolean(row.enabled),
    };
  }

  /** Stable across device rebinding and server restarts; never use an employee display name as an owner key. */
  public getSubjectId(token: string): string {
    this.db.prepare('UPDATE auth_tokens SET subject_id=? WHERE token=? AND subject_id IS NULL').run(crypto.randomUUID(), token);
    const row = this.db.prepare('SELECT subject_id FROM auth_tokens WHERE token=?').get(token) as { subject_id: string } | undefined;
    if (!row) throw new Error('Unknown employee');
    return row.subject_id;
  }

  public unbindDevice(token: string): { success: boolean; message: string } {
    const record = this.getToken(token);
    if (!record) {
      return { success: false, message: `未找到 Token: ${token}` };
    }
    const previousDevice = record.boundDeviceId || '未绑定';

    this.db.prepare(`
      UPDATE auth_tokens
      SET bound_device_id = NULL
      WHERE token = ?
    `).run(token);

    return {
      success: true,
      message: `已成功解除 Token [${token}] (${record.name}) 的设备绑定 (原绑定设备: ${previousDevice})。用户可在新电脑上重新登录激活。`,
    };
  }

  public setTokenStatus(token: string, enabled: boolean): { success: boolean; message: string } {
    const record = this.getToken(token);
    if (!record) {
      return { success: false, message: `未找到 Token: ${token}` };
    }

    this.db.prepare(`
      UPDATE auth_tokens
      SET enabled = ?
      WHERE token = ?
    `).run(enabled ? 1 : 0, token);

    return {
      success: true,
      message: `Token [${token}] (${record.name}) 状态已更新为: ${enabled ? '启用' : '禁用'}`,
    };
  }

  public deleteToken(token: string): boolean {
    const res = this.db.prepare(`
      DELETE FROM auth_tokens WHERE token = ?
    `).run(token);
    return res.changes > 0;
  }

  /**
   * 校验 Token 与设备指纹绑定 (1 Key -> 1 Computer)
   */
  public authenticateRequest(
    token: string,
    deviceId?: string,
    ip?: string
  ): { valid: boolean; name?: string; error?: string } {
    const record = this.getToken(token);
    if (!record) {
      return { valid: false, error: '无效的员工访问令牌 (Token Not Found)' };
    }

    if (!record.enabled) {
      return { valid: false, error: `该访问令牌已被管理员停用 (${record.name})` };
    }

    const currentDevice = String(deviceId || '').trim();
    const now = new Date().toISOString();

    // 1. 首次在某台设备使用：自动锁定该设备指纹
    if (!record.boundDeviceId) {
      if (currentDevice) {
        this.db.prepare(`
          UPDATE auth_tokens
          SET bound_device_id = ?, last_used_at = ?, last_ip = ?
          WHERE token = ?
        `).run(currentDevice, now, ip || null, token);

        console.log(`[TokenManager] Token [${token}] (${record.name}) 首次使用，已自动绑定到设备: "${currentDevice}"`);
      }
      return { valid: true, name: record.name };
    }

    // 2. 后续使用：严格校验设备指纹
    if (currentDevice && record.boundDeviceId !== currentDevice) {
      const msg = `【设备绑定拦截】该 Key (${record.name}) 已锁定在设备 [${record.boundDeviceId}]，检测到当前为不同设备 [${currentDevice}]。严禁多人共用同一 Key！如需换机请联系系统管理员解绑。`;
      console.warn(`[TokenManager] 防共用拦截: ${msg}`);
      return { valid: false, error: msg };
    }

    // 更新最后活跃时间与 IP
    this.db.prepare(`
      UPDATE auth_tokens
      SET last_used_at = ?, last_ip = ?
      WHERE token = ?
    `).run(now, ip || null, token);

    return { valid: true, name: record.name };
  }
}
