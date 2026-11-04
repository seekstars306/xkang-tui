import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from '../types.js';

/**
 * 服务端写文件工具。
 *
 * 为什么需要：write_file 原本只作为“本地工具”存在，由客户端（DSH 桌面端）执行。
 * 飞书这条链路没有客户端，模型即使发起 write_file 也没有执行器，
 * 于是“导出成文件给我”这类请求必然失败。
 *
 * 安全边界（重要）：模型不能往服务器任意位置写。
 * - 一律落在 XKANG_FILE_OUTPUT_DIR（默认 server/data/agent-files）之内；
 * - 拒绝绝对路径与 .. 逃逸；
 * - 单文件上限 5MB，避免写爆磁盘。
 */

const MAX_BYTES = 5 * 1024 * 1024;

export function fileOutputDir(): string {
  const configured = String(process.env.XKANG_FILE_OUTPUT_DIR ?? '').trim();
  if (configured) return path.resolve(configured);
  // 与工作目录无关：按模块自身位置解析到 server/data/agent-files。
  //
  // 原来用 path.resolve('data','agent-files')，跟着 cwd 走：
  // 服务端以 server/ 启动落 server/data，换目录启动就落到别处，
  // 而静态下载路由永远指向 server/data/agent-files——文件写成功了、链接却 404。
  // src/tools 与 dist/tools 深度相同，两种形态解析结果一致。
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/agent-files');
}

/** 把用户给的相对路径解析到沙箱目录内；越界抛错 */
export function resolveInsideSandbox(relativePath: string): string {
  const raw = String(relativePath ?? '').trim();
  if (!raw) throw new Error('路径不能为空');
  if (path.isAbsolute(raw)) throw new Error('只接受相对路径，不能写绝对路径');
  const base = fileOutputDir();
  const target = path.resolve(base, raw);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径越界，只能写在导出目录内');
  return target;
}

export async function executeWriteFile(
  args: { path: string; content: string; append?: boolean },
  _config: ServerConfig,
): Promise<string> {
  const target = resolveInsideSandbox(args.path);
  const content = String(args.content ?? '');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_BYTES) throw new Error(`内容过大（${bytes} 字节），单文件上限 5MB`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (args.append) fs.appendFileSync(target, content, 'utf8');
  else fs.writeFileSync(target, content, 'utf8');
  return JSON.stringify({ ok: true, path: target, bytes, append: Boolean(args.append) });
}

/** 生成 xlsx：rows 为二维数组，第一行作为表头。返回文件路径与下载链接。 */
export async function executeWriteXlsx(
  args: { path: string; rows: (string | number | null)[][]; sheetName?: string },
  _config: ServerConfig,
): Promise<string> {
  const ExcelJS = (await import('exceljs')).default;
  const target = resolveInsideSandbox(args.path);
  if (!target.toLowerCase().endsWith('.xlsx')) throw new Error('导出 xlsx 时 path 必须以 .xlsx 结尾');
  const rows = Array.isArray(args.rows) ? args.rows : [];
  if (!rows.length) throw new Error('rows 不能为空');
  if (rows.length > 200000) throw new Error('行数过多（上限 20 万行）');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(String(args.sheetName ?? 'Sheet1').slice(0, 31));
  for (const row of rows) ws.addRow(row);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await wb.xlsx.writeFile(target);
  const stat = fs.statSync(target);
  const base = String(process.env.XKANG_PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  const name = path.basename(target);
  return JSON.stringify({ ok: true, path: target, bytes: stat.size, rows: rows.length, url: base ? `${base}/files/${encodeURIComponent(name)}?${signFileToken(name)}` : null });
}
import crypto from 'node:crypto';

/** 文件链接签名密钥：优先 XKANG_FILE_SECRET，其次复用监控台密钥，都没有则每次启动随机（重启后旧链接失效） */
function fileSecret(): string {
  const s = String(process.env.XKANG_FILE_SECRET ?? '').trim();
  if (s) return s;
  const fallback = String(process.env.XKANG_MONITOR_SECRET ?? '').trim();
  if (fallback) return 'file:' + fallback;
  if (!(globalThis as { __xkangFileSecret?: string }).__xkangFileSecret) {
    (globalThis as { __xkangFileSecret?: string }).__xkangFileSecret = crypto.randomBytes(32).toString('hex');
  }
  return 'tmp:' + (globalThis as { __xkangFileSecret?: string }).__xkangFileSecret;
}

/** 给文件名签发带过期时间的下载令牌（默认 48 小时） */
export function signFileToken(name: string, ttlMs = 48 * 3600 * 1000): string {
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac('sha256', fileSecret()).update(name + '|' + exp).digest('hex').slice(0, 32);
  return 'e=' + exp + '&s=' + sig;
}

/** 校验令牌：签名对且未过期才放行 */
export function verifyFileToken(name: string, e: string | undefined, s: string | undefined): boolean {
  const exp = Number(e);
  if (!Number.isFinite(exp) || !s) return false;
  if (Date.now() > exp) return false;
  const want = crypto.createHmac('sha256', fileSecret()).update(name + '|' + exp).digest('hex').slice(0, 32);
  const a = Buffer.from(String(s)); const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}