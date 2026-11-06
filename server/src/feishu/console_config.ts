import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 控制台配置编辑的 schema 与 server/.env 安全读写。
 *
 * 单独拆成纯函数模块（不碰 Express、不碰进程）是为了能单测：
 * 2026-11-03 那次事故的根因就是改 .env 的工具不可验证——
 * PowerShell 按 ANSI 读写把中文注释搅坏，7 个赋值被并进注释后静默失效。
 * 这里的每条写入都要求：UTF-8 校验通过、保留注释与行序、只动目标行、先备份。
 */

export type ConfigKind = 'text' | 'number' | 'enum' | 'boolean' | 'secret';

export interface ConfigField {
  key: string;
  label: string;
  group: string;
  kind: ConfigKind;
  options?: string[];
  min?: number;
  max?: number;
  restartRequired?: boolean;
  hint?: string;
  /** 只读展示，不允许在控制台修改（改了可能把自己锁在门外） */
  readOnly?: boolean;
}

/** 控制台可管理的配置项。密钥类一律 secret：只写不读，返回值里只有长度。 */
export const CONFIG_FIELDS: ConfigField[] = [
  { key: 'ACTIVE_MODEL', label: '当前调度模型', group: '模型与推理', kind: 'enum', options: ['auto', 'deepseek', 'gemini', 'grok'], hint: '按进程内调度读取，保存后立即生效，不需要重启' },
  { key: 'DEEPSEEK_BASE_URL', label: 'DeepSeek 上游地址', group: '模型与推理', kind: 'text', restartRequired: true },
  { key: 'DEEPSEEK_MODEL', label: 'DeepSeek 模型名', group: '模型与推理', kind: 'text', restartRequired: true },
  { key: 'DEEPSEEK_REASONING_EFFORT', label: '推理档位', group: '模型与推理', kind: 'enum', options: ['low', 'medium', 'high', 'max'], restartRequired: true, hint: '生产约定为 max' },
  { key: 'CONTEXT_TOKENS', label: '上下文阈值', group: '模型与推理', kind: 'number', min: 1000, max: 2000000, restartRequired: true, hint: '生产约定 1048576' },
  { key: 'MODEL_JSON_FORMAT', label: 'JSON 输出约束', group: '模型与推理', kind: 'enum', options: ['', 'json_object', 'json_schema'], restartRequired: true },
  { key: 'MODEL_CALL_TIMEOUT_MS', label: '单次模型调用超时(ms)', group: '模型与推理', kind: 'number', min: 10000, max: 600000, restartRequired: true },
  { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek 密钥', group: '模型与推理', kind: 'secret', restartRequired: true },
  { key: 'GEMINI_API_KEY', label: 'Gemini 密钥', group: '模型与推理', kind: 'secret', restartRequired: true },
  { key: 'GEMINI_BASE_URL', label: 'Gemini 上游地址', group: '模型与推理', kind: 'text', restartRequired: true },
  { key: 'GEMINI_MODEL', label: 'Gemini 模型名', group: '模型与推理', kind: 'text', restartRequired: true },
  { key: 'GROK_API_KEY', label: 'Grok 密钥', group: '模型与推理', kind: 'secret', restartRequired: true },
  { key: 'GROK_BASE_URL', label: 'Grok 上游地址', group: '模型与推理', kind: 'text', restartRequired: true },

  { key: 'REVIEW_MODE', label: '复核模式', group: '复核', kind: 'enum', options: ['gate', 'advisory', 'off'], hint: '生产约定 off；改动会改变答案发布行为' },
  { key: 'REVIEWER', label: '复核器', group: '复核', kind: 'enum', options: ['llm', 'jev'] },
  { key: 'REVIEW_REASONING_EFFORT', label: '复核推理档位', group: '复核', kind: 'enum', options: ['low', 'medium', 'high', 'max'] },
  { key: 'ANSWER_REVIEW_TIMEOUT_MS', label: '复核总超时(ms)', group: '复核', kind: 'number', min: 60000, max: 300000 },
  { key: 'REVIEW_MODEL_BASE_URL', label: '独立复核模型地址', group: '复核', kind: 'text', restartRequired: true },
  { key: 'REVIEW_MODEL_NAME', label: '独立复核模型名', group: '复核', kind: 'text', restartRequired: true },
  { key: 'REVIEW_MODEL_TIMEOUT_MS', label: '独立复核超时(ms)', group: '复核', kind: 'number', min: 10000, max: 300000 },
  { key: 'REVIEW_MODEL_API_KEY', label: '独立复核模型密钥', group: '复核', kind: 'secret', restartRequired: true },
  { key: 'REVIEW_OBSERVED_BRANCH', label: '代码分支直接证据口径', group: '复核', kind: 'enum', options: ['on', 'off'] },
  { key: 'DATA_ONLY_FOR_UNKNOWN', label: '数据核对模式', group: '复核', kind: 'boolean' },

  { key: 'CODE_REPO_PATH', label: '代码库根目录', group: '代码与图谱', kind: 'text', restartRequired: true, hint: '丢失时代码检索/读文件/git/图谱四类工具全部不可用' },
  { key: 'CODE_SYNC_ENABLED', label: '定时代码同步', group: '代码与图谱', kind: 'boolean' },
  { key: 'CODE_SYNC_INTERVAL_MINUTES', label: '同步间隔(分钟)', group: '代码与图谱', kind: 'number', min: 0, max: 1440 },
  { key: 'REPO_ALLOWLIST', label: '仓库白名单', group: '代码与图谱', kind: 'text', restartRequired: true },
  { key: 'CODEGRAPH_ENDPOINT', label: '远程图谱服务', group: '代码与图谱', kind: 'text' },

  { key: 'COMPANY_DB_HOST', label: '公司数据库地址', group: '数据库', kind: 'text' },
  { key: 'COMPANY_DB_PORT', label: '公司数据库端口', group: '数据库', kind: 'number', min: 1, max: 65535 },
  { key: 'COMPANY_DB_USER', label: '公司数据库用户', group: '数据库', kind: 'text' },
  { key: 'COMPANY_DB_PASSWORD', label: '公司数据库密码', group: '数据库', kind: 'secret' },

  { key: 'XKANG_PUBLIC_BASE_URL', label: '对外 base url', group: '飞书与分享', kind: 'text', hint: '导出文件链接的前缀，改错会导致客服拿不到文件' },
  { key: 'SHARE_TTL_HOURS', label: '结论链接有效期(小时)', group: '飞书与分享', kind: 'number', min: 1, max: 720 },
  { key: 'FEISHU_MAX_CONCURRENT', label: '飞书并发排查上限', group: '飞书与分享', kind: 'number', min: 1, max: 20, hint: '飞书桥进程读取，改后需重启飞书桥' },
  { key: 'FEISHU_BEFORE_COUNT', label: '上下文保留条数', group: '飞书与分享', kind: 'number', min: 1, max: 100, hint: '飞书桥进程读取，改后需重启飞书桥' },
  { key: 'FEISHU_APP_SECRET', label: '飞书应用密钥', group: '飞书与分享', kind: 'secret', restartRequired: true },
  { key: 'XKANG_FEISHU_TOKEN', label: '飞书通道员工令牌', group: '飞书与分享', kind: 'secret', hint: '改错会导致飞书通道无法调用服务端' },

  { key: 'OUTBOUND_PROXY', label: '出站代理', group: '网络', kind: 'text', restartRequired: true, hint: '形如 http://127.0.0.1:7897；留空直连' },

  { key: 'FEATURE_PARTIAL_PUBLISH', label: '部分发布', group: '特性开关', kind: 'boolean' },
  { key: 'FEATURE_TIME_BUDGET', label: '时间预算与冻结续查', group: '特性开关', kind: 'boolean' },
  { key: 'FEATURE_INPUT_GUARD', label: '凭据入模脱敏', group: '特性开关', kind: 'boolean', hint: '已合入的脱敏，不建议关' },
  { key: 'FEATURE_FEEDBACK_BINDING', label: '反馈绑定', group: '特性开关', kind: 'boolean' },

  { key: 'PORT', label: '服务端口', group: '服务', kind: 'number', min: 1, max: 65535, restartRequired: true, hint: '改错会导致控制台本身连不上' },
  { key: 'HOST', label: '监听地址', group: '服务', kind: 'text', restartRequired: true },
  { key: 'RATE_LIMIT_PER_MINUTE', label: '单令牌每分钟请求上限', group: '服务', kind: 'number', min: 1, max: 10000 },
  { key: 'AUDIT_LOG_PATH', label: '审计日志路径', group: '服务', kind: 'text', restartRequired: true },
  { key: 'XKANG_FILE_SECRET', label: '文件链接签名密钥', group: '服务', kind: 'secret', restartRequired: true, hint: '改动后此前生成的下载链接全部失效' },

  // 登录与令牌类：能把自己锁在门外，控制台只展示状态，不提供修改入口
  { key: 'XKANG_TOKENS', label: '员工令牌', group: '鉴权', kind: 'secret', readOnly: true },
  { key: 'XKANG_ADMIN_TOKENS', label: '管理员令牌', group: '鉴权', kind: 'secret', readOnly: true },
  { key: 'XKANG_MONITOR_ACCOUNTS', label: '监控台账号', group: '鉴权', kind: 'secret', readOnly: true },
  { key: 'XKANG_MONITOR_SECRET', label: '监控台会话密钥', group: '鉴权', kind: 'secret', readOnly: true, hint: '改动会令所有已登录会话失效' },
];

export const CONFIG_GROUPS = [...new Set(CONFIG_FIELDS.map(f => f.group))];
const BY_KEY = new Map(CONFIG_FIELDS.map(f => [f.key, f]));

export function configField(key: string): ConfigField | undefined { return BY_KEY.get(key); }

export interface EnvEntry { key: string; value: string; }

/** 解析 .env 文本为有序条目；注释与空行不进入结果，但 writeEnv 会原样保留它们 */
export function parseEnv(text: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out.push({ key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  return out;
}

export function envValue(text: string, key: string): string {
  return parseEnv(text).find(e => e.key === key)?.value ?? '';
}

/**
 * 校验单个配置值。返回 null 表示合法，否则返回给人看的错误原因。
 * 故意不在这里做业务语义校验（比如地址是否可达）——那是保存后重启时的事。
 */
export function validateConfigValue(field: ConfigField, value: string): string | null {
  const v = String(value ?? '');
  if (field.kind === 'boolean') {
    if (!['true', 'false', '1', '0', ''].includes(v.trim().toLowerCase())) return '只能填 true/false（或 1/0）';
    return null;
  }
  if (v === '') return null;
  if (/[\r\n]/.test(v)) return '值不能包含换行';
  if (v !== v.trim()) return '值首尾不能有空格';
  if (field.kind === 'number') {
    if (!/^\d+$/.test(v)) return '只能填非负整数';
    const n = Number(v);
    if (field.min !== undefined && n < field.min) return `不能小于 ${field.min}`;
    if (field.max !== undefined && n > field.max) return `不能大于 ${field.max}`;
    return null;
  }
  if (field.kind === 'enum') {
    if (!field.options!.includes(v)) return `只能是：${field.options!.filter(o => o !== '').join(' / ') || '（空）'}`;
    return null;
  }
  return null;
}

export interface EnvChange { key: string; value: string; }

export interface ApplyResult {
  ok: boolean;
  error?: string;
  added: string[];
  updated: string[];
  backupPath?: string;
  text?: string;
}

/**
 * 把改动写回 .env 文本：只替换已存在的赋值行，新键追加到末尾。
 * 注释、空行、行序、CRLF 全部原样保留；编码损坏（含 U+FFFD）时直接拒绝，
 * 避免再把赋值并进注释那种静默失效。
 */
/** 这一行是不是 key 的赋值行（行首精确匹配，注释行不算） */
function isAssignLine(line: string, key: string): boolean {
  return line.replace(/\r$/, '').startsWith(key + '=');
}

/**
 * 把改动写回 .env 文本。
 *
 * - 已存在的赋值行：同名的每一行都改成新值。配置里出现重复键时（dotenv 以后出现的为准），
 *   只改一行会留下另一个值继续干扰排查，所以一次性全部对齐。
 * - 新键：追加到末尾（先去掉尾部空行，写完补一个换行）。
 * - 注释、空行、行序、原有行尾 CRLF 全部原样保留。
 * - 编码损坏（含 U+FFFD）时直接拒绝：2026-11-03 就是这样把赋值并进注释后静默失效的。
 */
export function applyEnvChanges(text: string, changes: EnvChange[], now = new Date()): ApplyResult {
  if (text.includes('\uFFFD')) {
    return { ok: false, error: '配置文件存在编码损坏（含替换字符），已拒绝写入。请先修复编码再修改。', added: [], updated: [] };
  }
  const lines = text.split('\n');
  const crlf = text.includes('\r\n');
  const added: string[] = [];
  const updated: string[] = [];
  for (const change of changes) {
    const key = change.key;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { ok: false, error: `非法配置项名：${key}`, added: [], updated: [] };
    }
    const value = String(change.value ?? '');
    if (/[\r\n]/.test(value)) return { ok: false, error: `${key} 的值不能包含换行`, added: [], updated: [] };
    const hits: number[] = [];
    lines.forEach((line, i) => { if (isAssignLine(line, key)) hits.push(i); });
    if (hits.length > 0) {
      for (const i of hits) lines[i] = `${key}=${value}` + (lines[i].endsWith('\r') ? '\r' : '');
      updated.push(key);
    } else {
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push(`${key}=${value}` + (crlf ? '\r' : ''));
      added.push(key);
    }
  }
  if (!added.length && !updated.length) return { ok: true, added, updated, text };
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return { ok: true, added, updated, text: out, backupPath: backupName(now) };
}

function backupName(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `server.env.bak-${stamp}`;
}

/** .env 的模块相对路径：与 file_write.ts 同一约定，不随启动目录漂移 */
export function envFilePath(moduleUrl: string = import.meta.url): string {
  const dir = path.dirname(fileURLToPath(moduleUrl));
  return path.resolve(dir, '../../.env');
}

export interface WriteResult { ok: boolean; error?: string; backupPath?: string; added?: string[]; updated?: string[] }

/**
 * 读 → 校验 → 备份 → 写。备份与目标同目录，文件名带时间戳，不参与 Git。
 * 写完后重新解析校验：每个键都必须读得回来，否则回滚到备份。
 */
export function writeEnvFile(file: string, changes: EnvChange[], now = new Date()): WriteResult {
  let original: string;
  try { original = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, error: `读取配置文件失败：${(e as Error).message}` };
  }
  const applied = applyEnvChanges(original, changes, now);
  if (!applied.ok || applied.text === undefined) return { ok: false, error: applied.error };
  if (applied.text === original) return { ok: true, backupPath: undefined, added: [], updated: [] };
  const backup = path.join(path.dirname(file), applied.backupPath!);
  try {
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, applied.text, 'utf8');
  } catch (e) {
    return { ok: false, error: `写入失败：${(e as Error).message}` };
  }
  const after = fs.readFileSync(file, 'utf8');
  for (const change of changes) {
    if (envValue(after, change.key) !== change.value) {
      try { fs.copyFileSync(backup, file); } catch { /* 回滚失败也要把真实情况报出去 */ }
      return { ok: false, error: `写入校验失败，已回滚：${change.key}` };
    }
  }
  return { ok: true, backupPath: backup, added: applied.added, updated: applied.updated };
}

export interface ConfigView {
  key: string;
  label: string;
  group: string;
  kind: ConfigKind;
  options?: string[];
  hint?: string;
  readOnly?: boolean;
  restartRequired?: boolean;
  /** 非密钥项的当前值；密钥项为空串 */
  value: string;
  /** 密钥项：已配置时的长度，未配置为 0 */
  secretLength: number;
  /** 是否已在 .env 里出现（区分设成空和没写这一行） */
  present: boolean;
}

/** 给控制台用的配置视图：密钥只回长度，不回内容 */
export function describeConfig(text: string): ConfigView[] {
  const entries = new Map(parseEnv(text).map(e => [e.key, e.value]));
  return CONFIG_FIELDS.map(field => {
    const present = entries.has(field.key);
    const raw = entries.get(field.key) ?? '';
    return {
      key: field.key, label: field.label, group: field.group, kind: field.kind,
      options: field.options, hint: field.hint, readOnly: field.readOnly, restartRequired: field.restartRequired,
      value: field.kind === 'secret' ? '' : raw,
      secretLength: field.kind === 'secret' ? raw.length : 0,
      present,
    };
  });
}

/** 控制台允许修改的键：非只读项 */
export function editableKeys(): string[] {
  return CONFIG_FIELDS.filter(f => !f.readOnly).map(f => f.key);
}
