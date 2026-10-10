import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { ServerConfig } from '../types.js';

export type SearchScope = 'frontend' | 'backend' | 'all';
export type SearchOutputMode = 'content' | 'files_with_matches' | 'count';

const EXCLUDE_GLOBS = [
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/target/**',
  '!**/build/**',
  '!**/.git/**',
  '!**/*.min.js',
  '!**/*.min.css',
  '!**/*.map',
  '!**/*.log',
  '!**/package-lock.json',
  '!**/yarn.lock',
  '!**/pnpm-lock.yaml',
];

// 输出预算：工具自身把结果控制在 harness 截断阈值以内，需要截断时一定显式告知模型还剩什么
const CONTENT_CHAR_BUDGET = 12000;
const TOTAL_CHAR_BUDGET = 16000;
const PER_FILE_CHAR_BUDGET = 3500;
const CONTENT_FILES_PER_PAGE = 20;
const MAX_LISTED_FILES = 150;
const MAX_COUNTED_FILES = 5000;
const MAX_LINE_CHARS = 250;
const RG_TIMEOUT_MS = 15000;

const READ_DEFAULT_SPAN = 300;
const READ_MIN_SPAN = 120;
const READ_MAX_SPAN = 400;
const READ_CHAR_BUDGET = 16000;

interface RgResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

function runRg(args: string[], timeoutMs = RG_TIMEOUT_MS): Promise<RgResult> {
  return new Promise((resolve) => {
    execFile(
      rgPath,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        const timedOut = Boolean(e?.killed);
        const code = e ? (typeof e.code === 'number' ? e.code : 2) : 0;
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code, timedOut });
      }
    );
  });
}

function toRel(repoRoot: string, abs: string): string {
  return path.relative(repoRoot, abs).replace(/\\/g, '/');
}

function isFrontendDir(name: string): boolean {
  const configured = (process.env.CODE_FRONTEND_DIRS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured.includes(name);
  return /front/i.test(name);
}

/**
 * 按 scope 解析检索根目录：直接把搜索根切换为对应的一级子目录，
 * 不再依赖 ripgrep glob（带斜杠的 glob 在绝对路径搜索根下永远匹配不上，曾导致前端检索恒为 0）。
 */
export function resolveScopeRoots(repoRoot: string, scope: SearchScope): { roots: string[]; label: string } {
  if (scope !== 'frontend' && scope !== 'backend') {
    return { roots: [repoRoot], label: '全量项目' };
  }
  const dirs = fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
  const picked = dirs.filter((name) => (scope === 'frontend' ? isFrontendDir(name) : !isFrontendDir(name)));
  const label = `${scope === 'frontend' ? '前端工程' : '后端工程'} (${picked.join(', ') || '无匹配目录'})`;
  return { roots: picked.map((name) => path.join(repoRoot, name)), label };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export interface ParsedKeyword {
  /** 用于 ripgrep 的正则（OR 语义） */
  pattern: string;
  /** AND 语义下需要同时出现在同一文件中的各个词（为空表示非 AND 查询） */
  andTerms: string[];
}

/**
 * 归一化模型传入的关键词：
 * - "A OR B" / "A || B"          -> A|B
 * - "A AND B" / "A && B"         -> 文件内同时包含 A 与 B（真正的 AND，不再偷偷当成 OR）
 * - "a, b, c"（英文逗号分隔的标识符列表）-> a|b|c
 * - 其余原样作为正则；非法正则自动转为字面量
 * 中文全角逗号不再拆分：报错文案里常带"，"，拆开会把整句变成噪声匹配。
 */
export function parseKeyword(rawKeyword: string): ParsedKeyword {
  const trimmed = rawKeyword.trim();
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '').trim();
  const toRegex = (t: string) => (isValidRegex(t) ? t : escapeRegExp(t));

  if (/\s+(?:AND|&&)\s+/.test(trimmed) && !/\s+(?:OR|\|\|)\s+/i.test(trimmed)) {
    const terms = trimmed
      .split(/\s+(?:AND|&&)\s+/)
      .map(unquote)
      .filter(Boolean)
      .map(toRegex);
    if (terms.length > 1) {
      return { pattern: terms.join('|'), andTerms: terms };
    }
  }

  if (/\s+(?:OR|\|\|)\s+/i.test(trimmed)) {
    const terms = trimmed
      .split(/\s+(?:OR|\|\|)\s+/i)
      .map(unquote)
      .filter(Boolean);
    return { pattern: terms.map(toRegex).join('|'), andTerms: [] };
  }

  if (trimmed.includes(',') && !/[(){}[\]]/.test(trimmed)) {
    const items = trimmed
      .split(/\s*,\s*/)
      .map(unquote)
      .filter(Boolean);
    if (items.length > 1 && items.every((t) => !/\s/.test(t) && t.length <= 60)) {
      return { pattern: items.map(escapeRegExp).join('|'), andTerms: [] };
    }
  }

  const single = unquote(trimmed);
  return { pattern: isValidRegex(single) ? single : escapeRegExp(single), andTerms: [] };
}

/** filePattern 支持 "*.vue OR *.js"、"*.vue,*.js"、"*.vue|*.js"；不含通配符的按"文件名包含"处理 */
export function splitFilePatterns(filePattern?: string): string[] {
  if (!filePattern || !filePattern.trim()) return [];
  return filePattern
    .split(/\s+OR\s+|[,;|]/i)
    .map((p) => p.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .map((p) => {
      if (/[*?]/.test(p)) return p;
      if (/^\.[A-Za-z0-9]+$/.test(p)) return `*${p}`;
      return `*${p}*`;
    });
}

function buildGlobArgs(filePatterns: string[]): string[] {
  const args: string[] = [];
  for (const g of EXCLUDE_GLOBS) args.push('--glob', g);
  for (const g of filePatterns) args.push('--glob', g);
  return args;
}

interface FileHit {
  abs: string;
  rel: string;
  count: number;
}

async function countMatches(
  pattern: string,
  literal: boolean,
  globArgs: string[],
  roots: string[]
): Promise<{ hits: Map<string, number>; error?: string; timedOut?: boolean }> {
  const args = ['--count-matches', '--null', '-S', '--no-messages', ...globArgs];
  if (literal) args.push('-F');
  args.push('-e', pattern, ...roots);
  const res = await runRg(args);
  if (res.timedOut) return { hits: new Map(), timedOut: true };
  if (res.code === 2 && !res.stdout.trim()) {
    return { hits: new Map(), error: res.stderr.trim() || 'ripgrep 执行失败' };
  }
  const hits = new Map<string, number>();
  for (const line of res.stdout.split('\n')) {
    if (!line) continue;
    const sep = line.indexOf('\0');
    if (sep < 0) continue;
    const file = line.slice(0, sep);
    const count = Number(line.slice(sep + 1).trim()) || 0;
    hits.set(file, count);
    if (hits.size >= MAX_COUNTED_FILES) break;
  }
  return { hits };
}

async function fileContent(
  pattern: string,
  literal: boolean,
  file: string
): Promise<string> {
  const args = ['-n', '-C', '2', '-S', '-m', '30', '--max-columns', String(MAX_LINE_CHARS + 50), '--max-columns-preview', '--no-messages', '--no-heading', '--no-filename', '--color', 'never'];
  if (literal) args.push('-F');
  args.push('-e', pattern, '--', file);
  const res = await runRg(args, 8000);
  return res.stdout
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l, i, arr) => !(l === '' && i === arr.length - 1))
    .map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + '…' : l))
    .join('\n');
}

function cutAtLineBoundary(text: string, budget: number): { text: string; cut: boolean } {
  if (text.length <= budget) return { text, cut: false };
  const slice = text.slice(0, budget);
  const lastNl = slice.lastIndexOf('\n');
  return { text: lastNl > 0 ? slice.slice(0, lastNl) : slice, cut: true };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface SearchCodeArgs {
  keyword: string;
  scope?: string;
  filePattern?: string;
  output_mode?: string;
  offset?: number;
}

export async function executeSearchCode(args: SearchCodeArgs, config: ServerConfig): Promise<string> {
  const keyword = String(args.keyword || '');
  const scope = (['frontend', 'backend', 'all'].includes(String(args.scope)) ? args.scope : 'all') as SearchScope;
  const mode = (['content', 'files_with_matches', 'count'].includes(String(args.output_mode))
    ? args.output_mode
    : 'content') as SearchOutputMode;
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const repoRoot = config.codeRepoPath ? path.resolve(config.codeRepoPath) : '';

  if (!keyword.trim()) {
    return '错误: 搜索关键字不能为空。';
  }
  if (!repoRoot) {
    return '错误: 服务端未配置 CODE_REPO_PATH，无法执行代码检索。请联系管理员在 server/.env 中配置。';
  }
  if (!fs.existsSync(repoRoot)) {
    return `错误: 服务端配置的代码库路径不存在: ${repoRoot}`;
  }
  if (!rgPath || !fs.existsSync(rgPath)) {
    return '错误: 服务端未安装 ripgrep 二进制 (@vscode/ripgrep)。';
  }

  const { roots, label } = resolveScopeRoots(repoRoot, scope);
  if (roots.length === 0) {
    return `错误: 在 ${repoRoot} 下没有找到属于「${scope}」范围的一级目录，请改用 scope=all。`;
  }

  const filePatterns = splitFilePatterns(args.filePattern);
  const globArgs = buildGlobArgs(filePatterns);
  const parsed = parseKeyword(keyword);
  let literal = false;

  // 1. 统计全部命中文件（不截断），保证模型看到的是完整的命中概览
  let hits: Map<string, number>;
  if (parsed.andTerms.length > 1) {
    const perTerm = await Promise.all(parsed.andTerms.map((t) => countMatches(t, false, globArgs, roots)));
    const failed = perTerm.find((r) => r.timedOut || r.error);
    if (failed) {
      return failed.timedOut ? '代码检索超时（15s），请缩小关键词或 scope/filePattern 范围后重试。' : `搜索执行错误: ${failed.error}`;
    }
    hits = new Map();
    for (const [file] of perTerm[0].hits) {
      if (perTerm.every((r) => r.hits.has(file))) {
        hits.set(file, perTerm.reduce((sum, r) => sum + (r.hits.get(file) || 0), 0));
      }
    }
  } else {
    let res = await countMatches(parsed.pattern, false, globArgs, roots);
    if (res.error && /regex|parse|syntax/i.test(res.error)) {
      literal = true;
      res = await countMatches(keyword.trim(), true, globArgs, roots);
    }
    if (res.timedOut) return '代码检索超时（15s），请缩小关键词或 scope/filePattern 范围后重试。';
    if (res.error) return `搜索执行错误: ${res.error}`;
    hits = res.hits;
  }

  const filterNote = filePatterns.length ? ` | 文件过滤: ${filePatterns.join(', ')}` : '';
  const patternShown = literal ? `${keyword.trim()}（按字面量匹配）` : parsed.pattern;
  const header = `【代码检索】关键词: "${keyword}" (实际匹配: ${patternShown}${parsed.andTerms.length > 1 ? '，需同一文件内同时出现' : ''}) | 范围: ${label}${filterNote}`;

  if (hits.size === 0) {
    return [
      header,
      '结果: 未检索到匹配的代码。',
      '注意: 这只说明当前关键词/范围/文件过滤下没有字面匹配，不能据此断定功能或页面不存在。',
      '可以尝试: 换更短或更核心的词、代码里的英文标识符(驼峰/下划线)、去掉 filePattern，或改用 scope=all。',
    ].join('\n');
  }

  const files: FileHit[] = Array.from(hits.entries())
    .map(([abs, count]) => ({ abs, rel: toRel(repoRoot, abs), count }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
  const totalMatches = files.reduce((sum, f) => sum + f.count, 0);
  const capped = hits.size >= MAX_COUNTED_FILES;
  const totalLine = `命中 ${files.length}${capped ? '+（已达统计上限）' : ''} 个文件、共 ${totalMatches} 处匹配（按路径排序）。`;

  if (mode === 'count') {
    const byRepo = new Map<string, { files: number; matches: number }>();
    for (const f of files) {
      const repo = f.rel.split('/').slice(0, 2).join('/');
      const cur = byRepo.get(repo) || { files: 0, matches: 0 };
      cur.files++;
      cur.matches += f.count;
      byRepo.set(repo, cur);
    }
    const lines = Array.from(byRepo.entries()).map(([repo, v]) => `- ${repo}: ${v.files} 个文件 / ${v.matches} 处`);
    return [header, totalLine, '按仓库统计:', ...lines].join('\n');
  }

  if (mode === 'files_with_matches') {
    const page: FileHit[] = [];
    let listUsed = header.length + totalLine.length;
    for (const f of files.slice(offset)) {
      const lineLen = f.rel.length + 16;
      if (page.length > 0 && listUsed + lineLen > TOTAL_CHAR_BUDGET) break;
      page.push(f);
      listUsed += lineLen;
    }
    const lines = page.map((f) => `- ${f.rel} (${f.count} 处)`);
    const rest = files.length - offset - page.length;
    const tail = rest > 0 ? `（还有 ${rest} 个文件未列出，继续查看请用 offset=${offset + page.length}）` : '（已列出全部命中文件）';
    return [header, totalLine, `文件列表（第 ${offset + 1}-${offset + page.length} 个）:`, ...lines, tail].join('\n');
  }

  // content 模式：展示若干文件的匹配上下文，其余文件仅列出路径，绝不静默丢弃
  if (offset >= files.length) {
    return [header, totalLine, `offset=${offset} 超出命中文件数，没有更多内容。`].join('\n');
  }
  const pageFiles = files.slice(offset, offset + CONTENT_FILES_PER_PAGE);
  const blocks = await mapLimit(pageFiles, 4, async (f) => {
    const raw = await fileContent(parsed.andTerms.length > 1 ? parsed.pattern : literal ? keyword.trim() : parsed.pattern, literal, f.abs);
    const { text, cut } = cutAtLineBoundary(raw, PER_FILE_CHAR_BUDGET);
    const more = cut ? `\n…（该文件还有更多匹配未展示，可用 read_file_lines 或 filePattern="${path.basename(f.rel)}" 查看）` : '';
    return `### ${f.rel}（${f.count} 处匹配）\n${text}${more}`;
  });

  const shown: string[] = [];
  let used = 0;
  for (const block of blocks) {
    if (shown.length > 0 && used + block.length > CONTENT_CHAR_BUDGET) break;
    shown.push(block);
    used += block.length;
  }
  const shownEnd = offset + shown.length;
  const remaining = files.slice(shownEnd);
  // 文件清单也受总长度预算约束，超出部分明确告知数量并给出查看方式
  const listed: FileHit[] = [];
  let listUsed = used;
  for (const f of remaining.slice(0, MAX_LISTED_FILES)) {
    const lineLen = f.rel.length + 16;
    if (listUsed + lineLen > TOTAL_CHAR_BUDGET) break;
    listed.push(f);
    listUsed += lineLen;
  }

  const parts = [
    header,
    `${totalLine}下面展示第 ${offset + 1}-${shownEnd} 个文件的匹配内容${remaining.length ? `；其余 ${remaining.length} 个文件只列出路径和匹配数` : '（已展示全部命中文件）'}。`,
    '',
    shown.join('\n\n'),
  ];
  if (listed.length) {
    parts.push('', '【其余命中文件（未展示内容）】', ...listed.map((f) => `- ${f.rel} (${f.count} 处)`));
    if (remaining.length > listed.length) {
      parts.push(`…还有 ${remaining.length - listed.length} 个文件未列出，可用 output_mode="files_with_matches" 查看完整列表。`);
    }
    parts.push(`继续查看后续文件内容请用 offset=${shownEnd}；只看某个文件可设置 filePattern 为该文件名，或用 read_file_lines 直接阅读。`);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// 文件定位与读取
// ---------------------------------------------------------------------------

function isInside(root: string, target: string): boolean {
  const r = path.resolve(root).toLowerCase();
  const t = path.resolve(target).toLowerCase();
  return t === r || t.startsWith(r + path.sep) || t.startsWith(r + '/');
}

function isGitInternal(rel: string): boolean {
  const n = rel.replace(/\\/g, '/').toLowerCase();
  return n === '.git' || n.startsWith('.git/') || n.includes('/.git/') || n.endsWith('/.git');
}

function findFilesByName(repoRoot: string, rawPath: string): string[] {
  const base = path.basename(rawPath.replace(/\\/g, '/'));
  if (!base || !rgPath || !fs.existsSync(rgPath)) return [];
  try {
    const out: string = execFileSync(rgPath, ['--files', '--iglob', `**/${base}`, ...EXCLUDE_GLOBS.flatMap((g) => ['--glob', g]), repoRoot], {
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

export type ResolvedFile =
  | { ok: true; abs: string; rel: string; note?: string }
  | { ok: false; message: string };

/**
 * 解析文件路径：支持绝对路径、相对代码库根目录的路径；不存在时按文件名自动定位。
 * 同名文件有多个且无法唯一确定时，返回候选列表让模型指定，绝不静默挑一个（以前会读错仓库的同名文件）。
 */
export function resolveRepoFile(repoRoot: string, rawInput: string): ResolvedFile {
  const raw = String(rawInput || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return { ok: false, message: '错误: filePath 参数不能为空。' };

  const root = path.resolve(repoRoot);
  const direct = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);

  // 先做安全边界检查：越界与 .git 访问无论目标是否存在都直接拦截
  if (!isInside(root, direct)) {
    return { ok: false, message: `安全拦截: 目标路径 "${raw}" 超出代码库安全边界 (根目录: ${root})。禁止跨目录读写操作。` };
  }
  if (isGitInternal(toRel(root, direct))) {
    return { ok: false, message: '安全拦截: 目标路径属于 Git 版本库内部元数据区 (.git)，禁止访问。' };
  }

  let abs = direct;
  let note: string | undefined;
  if (!fs.existsSync(direct)) {
    const candidates = findFilesByName(root, raw);
    if (candidates.length === 0) {
      return { ok: false, message: `错误: 文件不存在: ${raw}（已在代码库中按文件名查找，也没有找到）。` };
    }
    const wanted = raw.replace(/\\/g, '/').toLowerCase().replace(/^\.?\//, '');
    const suffixMatches = candidates.filter((c) => c.replace(/\\/g, '/').toLowerCase().endsWith(wanted));
    if (candidates.length === 1) {
      abs = candidates[0];
    } else if (suffixMatches.length === 1) {
      abs = suffixMatches[0];
    } else {
      const list = (suffixMatches.length > 1 ? suffixMatches : candidates).slice(0, 30).map((c) => `- ${toRel(root, c)}`);
      return {
        ok: false,
        message: [`路径 "${raw}" 不唯一：代码库中有 ${candidates.length} 个同名文件，请用下面的完整相对路径重新指定:`, ...list].join('\n'),
      };
    }
    note = `【已按文件名自动定位: ${toRel(root, abs)}】`;
  }

  if (!isInside(root, abs)) {
    return { ok: false, message: `安全拦截: 目标路径 "${raw}" 超出代码库安全边界 (根目录: ${root})。禁止跨目录读写操作。` };
  }
  const rel = toRel(root, abs);
  if (isGitInternal(rel)) {
    return { ok: false, message: '安全拦截: 目标路径属于 Git 版本库内部元数据区 (.git)，禁止访问。' };
  }
  return { ok: true, abs, rel, note };
}

function decodeSourceFile(buf: Buffer): string {
  const utf8 = buf.toString('utf-8');
  const bad = (utf8.match(/�/g) || []).length;
  if (bad > 0 && bad / Math.max(utf8.length, 1) > 0.002) {
    try {
      const gbk = new TextDecoder('gbk').decode(buf);
      if ((gbk.match(/�/g) || []).length < bad) return gbk;
    } catch {}
  }
  return utf8;
}

export async function executeReadFileLines(
  args: { filePath: string; startLine?: number; endLine?: number },
  config: ServerConfig
): Promise<string> {
  const rawPath = String(args.filePath || (args as any).file_path || '');
  const repoRoot = config.codeRepoPath || '';
  if (!repoRoot) {
    return '错误: 服务端未配置 CODE_REPO_PATH，无法读取代码文件。';
  }

  const resolved = resolveRepoFile(repoRoot, rawPath);
  if (!resolved.ok) return resolved.message;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved.abs);
  } catch (err) {
    return `读取文件失败 [${resolved.rel}]: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (stat.isDirectory()) {
    const entries = fs
      .readdirSync(resolved.abs, { withFileTypes: true })
      .map((e) => `${e.isDirectory() ? '[目录] ' : ''}${e.name}`)
      .sort();
    return [`【目录】${resolved.rel}（共 ${entries.length} 项，这是目录不是文件）`, ...entries.slice(0, 200).map((e) => `- ${e}`)].join('\n');
  }

  let content: string;
  try {
    content = decodeSourceFile(await fs.promises.readFile(resolved.abs));
  } catch (err) {
    return `读取文件失败 [${resolved.rel}]: ${err instanceof Error ? err.message : String(err)}`;
  }

  const lines = content.split('\n').map((l) => l.replace(/\r$/, ''));
  const total = lines.length;
  const reqStart = args.startLine != null && Number(args.startLine) > 0 ? Math.floor(Number(args.startLine)) : undefined;
  const reqEnd = args.endLine != null && Number(args.endLine) > 0 ? Math.floor(Number(args.endLine)) : undefined;

  let start: number;
  let end: number;
  let expanded = false;
  let cappedSpan = false;
  if (reqStart === undefined && reqEnd === undefined) {
    start = 1;
    end = READ_DEFAULT_SPAN;
  } else {
    start = reqStart ?? Math.max(1, (reqEnd as number) - READ_DEFAULT_SPAN + 1);
    end = reqEnd ?? start + READ_DEFAULT_SPAN - 1;
    if (end < start) [start, end] = [end, start];
    if (end - start + 1 < READ_MIN_SPAN) {
      // 窗口太小时自动扩展（主要向后扩展）：模型只读 40 行就下结论、漏掉紧随其后的覆盖赋值，是历史上的典型误判
      const newStart = Math.max(1, start - 20);
      end = Math.max(end, newStart + READ_MIN_SPAN - 1);
      start = newStart;
      expanded = true;
    }
    if (end - start + 1 > READ_MAX_SPAN) {
      end = start + READ_MAX_SPAN - 1;
      cappedSpan = true;
    }
  }
  if (start > total) {
    return `【文件】${resolved.rel} 共 ${total} 行，请求的起始行 ${start} 超出文件长度。`;
  }
  end = Math.min(end, total);

  const out: string[] = [];
  let used = 0;
  let lastShown = start - 1;
  for (let i = start; i <= end; i++) {
    const line = `${i}: ${lines[i - 1]}`;
    if (out.length > 0 && used + line.length + 1 > READ_CHAR_BUDGET) break;
    out.push(line);
    used += line.length + 1;
    lastShown = i;
  }

  const head: string[] = [];
  if (resolved.note) head.push(resolved.note);
  head.push(`【文件】${resolved.rel}（共 ${total} 行）显示第 ${start}-${lastShown} 行`);
  if (expanded) {
    head.push(`（请求的是第 ${reqStart ?? '?'}-${reqEnd ?? '?'} 行，已自动扩大阅读窗口，避免遗漏紧随其后的赋值/分支）`);
  }
  const tail: string[] = [];
  if (lastShown < total) {
    const why = lastShown < end ? '（因单次输出长度限制提前截止）' : cappedSpan ? '（单次最多读取 400 行）' : '';
    tail.push(`…文件后面还有 ${total - lastShown} 行未显示${why}，继续阅读请用 startLine=${lastShown + 1}`);
  }
  return [...head, ...out, ...tail].join('\n');
}

// ---------------------------------------------------------------------------
// Git 历史 / Blame
// ---------------------------------------------------------------------------

/** 代码库根目录下是多个独立 git 仓库，需要从文件所在目录向上找到所属仓库 */
export function findGitRoot(repoRoot: string, absFile: string): string | null {
  const root = path.resolve(repoRoot);
  let dir = fs.existsSync(absFile) && fs.statSync(absFile).isDirectory() ? absFile : path.dirname(absFile);
  while (isInside(root, dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function runGit(cwd: string, args: string[]): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve({ stdout: String(stdout || ''), error: String(stderr || err.message).trim() });
      else resolve({ stdout: String(stdout || '') });
    });
  });
}

export async function executeGitInspect(
  args: { action: string; filePath: string; lineRange?: string; maxCount?: number },
  config: ServerConfig
): Promise<string> {
  const action = String(args.action || 'log');
  const repoRoot = config.codeRepoPath || '';
  if (!repoRoot) {
    return '错误: 服务端未配置 CODE_REPO_PATH。';
  }
  if (!['log', 'blame'].includes(action)) {
    return `错误: 不支持的 action "${action}"，可选 log / blame。`;
  }

  const resolved = resolveRepoFile(repoRoot, args.filePath);
  if (!resolved.ok) return resolved.message;

  let range = '';
  if (args.lineRange) {
    const lr = String(args.lineRange).trim().replace(/\s+/g, '');
    if (!/^\d+(,\d+)?$/.test(lr)) {
      return '错误: lineRange 格式必须为行号范围，如 "50,70"。';
    }
    range = lr.includes(',') ? lr : `${lr},${lr}`;
  }

  const gitRoot = findGitRoot(repoRoot, resolved.abs);
  if (!gitRoot) {
    return `未找到文件 ${resolved.rel} 所属的 Git 仓库（该目录可能不是 git 仓库），无法查询提交历史。`;
  }
  const relInRepo = path.relative(gitRoot, resolved.abs).replace(/\\/g, '/');
  const repoLabel = toRel(path.resolve(repoRoot), gitRoot) || path.basename(gitRoot);
  const maxCount = Math.min(Math.max(Number(args.maxCount) || 10, 1), 30);

  let gitArgs: string[];
  if (action === 'blame') {
    gitArgs = ['blame', '--date=short', ...(range ? ['-L', range] : []), '--', relInRepo];
  } else if (range) {
    gitArgs = ['log', `-n${maxCount}`, '-s', '--date=short', '--pretty=format:%h %ad %an: %s', '-L', `${range}:${relInRepo}`];
  } else {
    gitArgs = ['log', `-n${maxCount}`, '--follow', '--date=short', '--pretty=format:%h %ad %an: %s', '--', relInRepo];
  }

  const res = await runGit(gitRoot, gitArgs);
  if (res.error && !res.stdout.trim()) {
    return `Git 查询失败（仓库 ${repoLabel}）: ${res.error}`;
  }
  const body = res.stdout.trim();
  if (!body) {
    return `仓库 ${repoLabel} 中没有文件 ${relInRepo}${range ? ` 第 ${range} 行` : ''} 的 ${action} 记录。`;
  }
  const { text, cut } = cutAtLineBoundary(body, 12000);
  return [
    `【Git ${action.toUpperCase()}】仓库: ${repoLabel} | 文件: ${relInRepo}${range ? ` | 行: ${range}` : ''}`,
    text,
    cut ? '…（输出过长已截断，请缩小 lineRange）' : '',
  ]
    .filter(Boolean)
    .join('\n');
}
