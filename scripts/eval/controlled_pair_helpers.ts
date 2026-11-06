import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

export const HARD_CAP_MS = 45 * 60_000;
export const STARTUP_MS = 90_000;
export type Arm = 'baseline' | 'candidate';
export type ObjectData = Record<string, any>;
export class Failure extends Error { constructor(readonly code: string) { super(code); } }
export function check(value: unknown, code: string): asserts value { if (!value) throw new Failure(code); }
export function errorCode(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown } | null;
  return typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(e.code) ? e.code
    : e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'ABORTED' : 'RUNNER_ERROR';
}
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const canonicalJson = (value: any): string => JSON.stringify(canonical(value));
function canonical(value: any): any {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
}
export const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file); // Only runner-owned output paths reach this function.
}
export function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
/** Length-delimited relative filenames + exact bytes, in lexical order; never follow links. */
export function treeHash(root: string): { sha256: string; files: number; bytes: number } {
  const hash = createHash('sha256'); let files = 0; let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (['node_modules', 'eval_run', '.git'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      check(!entry.isSymbolicLink(), 'HASH_SYMLINK');
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const name = path.relative(root, file).split(path.sep).join('/'); const data = fs.readFileSync(file);
        hash.update(String(Buffer.byteLength(name)) + ':').update(name).update(String(data.length) + ':').update(data);
        files++; bytes += data.length;
      } else throw new Failure('HASH_SPECIAL_FILE');
    }
  };
  walk(root); return { sha256: hash.digest('hex'), files, bytes };
}
/** Git output goes to an owned file descriptor, never child_process pipes. */
export function gitText(root: string, args: string[]): string {
  const file = path.join(os.tmpdir(), 'controlled-pair-git-' + randomUUID());
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    const result = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], { stdio: ['ignore', fd, 'ignore'], windowsHide: true, timeout: 15_000 });
    check(!result.error && result.status === 0, 'GIT_INSPECTION_FAILED');
    return fs.readFileSync(file, 'utf8').trim();
  } finally { fs.closeSync(fd); fs.unlinkSync(file); }
}
export function ignoredOutput(workspace: string, output: string): void {
  const evalRoot = fs.realpathSync(path.join(workspace, 'eval_run'));
  check(!fs.existsSync(output) && within(evalRoot, path.join(fs.realpathSync(path.dirname(output)), path.basename(output))), 'RUN_DIR_NOT_NEW_OR_ISOLATED');
  const result = spawnSync('git', ['-C', workspace, 'check-ignore', '--quiet', '--', path.relative(workspace, path.join(output, 'public.json'))], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
  check(result.status === 0, 'RUN_DIR_NOT_IGNORED');
}
export function snapshot(root: string): ObjectData {
  const require = createRequire(path.join(root, 'server', 'package.json'));
  const core = fs.realpathSync(require.resolve('@xkang/agent-core'));
  check(core === fs.realpathSync(path.join(root, 'packages/agent-core/dist/index.js')), 'CORE_NOT_WORKTREE_LOCAL');
  check(fs.statSync(path.join(root, 'server/src/index.ts')).isFile(), 'SERVER_ENTRY_MISSING');
  check(fs.statSync(path.join(root, 'node_modules/tsx/dist/loader.mjs')).isFile(), 'TSX_MISSING');
  return { root, head: gitText(root, ['rev-parse', 'HEAD']), serverSource: treeHash(path.join(root, 'server/src')),
    coreSource: treeHash(path.join(root, 'packages/agent-core/src')), coreDist: treeHash(path.join(root, 'packages/agent-core/dist')),
    serviceMapSha256: sha256(fs.readFileSync(path.join(root, 'server/data/service_map.json'))),
    versions: { node: process.version, tsx: readJson(path.join(root, 'node_modules/tsx/package.json')).version,
      openai: readJson(path.join(root, 'node_modules/openai/package.json')).version, server: readJson(path.join(root, 'server/package.json')).version } };
}
export function codeHeads(root: string): ObjectData[] {
  const repos: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (fs.existsSync(path.join(dir, '.git'))) { repos.push(dir); return; }
    check(depth < 5, 'CODE_REPO_DEPTH');
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || ['node_modules', 'eval_run'].includes(e.name)) continue;
      check(!e.isSymbolicLink(), 'CODE_REPO_SYMLINK'); if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0); check(repos.length === 18, 'EXPECTED_18_CODE_REPOS');
  return repos.sort().map(repo => {
    check(gitText(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'HEAD', 'CODE_REPO_NOT_DETACHED');
    return { repo: path.relative(root, repo), head: gitText(repo, ['rev-parse', 'HEAD']), statusSha256: sha256(gitText(repo, ['status', '--porcelain', '--untracked-files=all'])) };
  });
}
export interface CaseInput { id: string; index: number; inputFile: string; inputFileSha256: string; contentSha256: string; content: any; bytes: Buffer; images: ObjectData[] }
export function loadCases(workspace: string, catalog: string, only?: string[]): CaseInput[] {
  const items = readJson(catalog).cases;
  check(Array.isArray(items) && items.length === 8, 'EXPECTED_8_CASES');
  const seen = new Set<string>(); const requested = new Set(only);
  const all = items.map((item: any, index: number): CaseInput => {
    check(typeof item.id === 'string' && /^[A-Za-z0-9_-]+$/.test(item.id) && !seen.has(item.id), 'INVALID_CASE_ID'); seen.add(item.id);
    const inputFile = fs.realpathSync(path.resolve(workspace, item.inputFile));
    check(within(fs.realpathSync(path.dirname(catalog)), inputFile), 'INPUT_OUTSIDE_CATALOG_DIR');
    const bytes = fs.readFileSync(inputFile); const fileHash = sha256(bytes);
    check(fileHash === (item.inputFileSha256 ?? item.hash), 'INPUT_HASH_MISMATCH');
    const doc = JSON.parse(bytes.toString('utf8')); const message = doc.messages?.[0];
    check(Object.keys(doc).length === 1 && Array.isArray(doc.messages) && doc.messages.length === 1 && message?.role === 'user'
      && Object.keys(message).every(k => ['role', 'content'].includes(k)), 'INPUT_NOT_PURE_USER');
    const content = message.content; const images: ObjectData[] = [];
    if (typeof content === 'string') check(content.length > 0 && content.length <= 30_000, 'INVALID_TEXT');
    else {
      check(Array.isArray(content) && content.length > 0 && content.length <= 12, 'INVALID_CONTENT');
      content.forEach((part: any, contentPartIndex: number) => {
        if (part?.type === 'text') check(typeof part.text === 'string' && part.text.length <= 30_000 && Object.keys(part).length === 2, 'INVALID_TEXT_PART');
        else {
          check(part?.type === 'image_url' && Object.keys(part).length === 2 && part.image_url && Object.keys(part.image_url).length === 1, 'INVALID_IMAGE_PART');
          const url = part.image_url.url; const match = typeof url === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
          check(match && url.length <= 20_000_000, 'INVALID_IMAGE_DATA');
          const image = Buffer.from(match[2], 'base64'); check(image.toString('base64') === match[2], 'INVALID_BASE64');
          images.push({ contentPartIndex, bytes: image.length, sha256: sha256(image), dataUrlSha256: sha256(url) });
        }
      });
    }
    const contentSha256 = sha256(canonicalJson(content));
    check(!item.canonicalUserContentSha256 || contentSha256 === item.canonicalUserContentSha256, 'CONTENT_HASH_MISMATCH');
    if (item.images) check(item.images.length === images.length && images.every((im, i) => Object.keys(im).every(k => im[k] === item.images[i][k])), 'IMAGE_HASH_MISMATCH');
    if ([item.id, ...(item.aliases ?? [])].some(id => requested.has(id))) { requested.delete(item.id); for (const alias of item.aliases ?? []) requested.delete(alias); }
    return { id: item.id, index, inputFile, inputFileSha256: fileHash, contentSha256, content, bytes, images };
  });
  check(requested.size === 0, 'UNKNOWN_CASE');
  return only ? all.filter(c => [items[c.index].id, ...(items[c.index].aliases ?? [])].some(id => only.includes(id))) : all;
}
export function proxyUrl(base: string | undefined, runId: string): string {
  check(base, 'EVAL_MODEL_PROXY_BASE_REQUIRED');
  let url: URL; try { url = new URL(base); } catch { throw new Failure('INVALID_PROXY_BASE'); }
  check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    && url.pathname === '/', 'PROXY_BASE_MUST_BE_ORIGIN');
  check(/^[A-Za-z0-9_-]+$/.test(runId), 'INVALID_RUN_ID');
  return url.origin + '/run/' + runId + '/v1';
}
const DEFAULTS: Record<string, string> = { FEATURE_PARTIAL_PUBLISH: '0', FEATURE_INPUT_GUARD: '1', FEATURE_FEEDBACK_BINDING: '0',
  DATA_ONLY_FOR_UNKNOWN: '0', REVIEW_OBSERVED_BRANCH: 'off', RULE_LAYER: 'on', REPO_ALLOWLIST: '*', CODE_FRONTEND_DIRS: '',
  ANSWER_REVIEW_TIMEOUT_MS: '180000', REVIEW_MAX_PROMPT_TOKENS: '80000', GEMINI_REASONING_EFFORT: 'high', REVIEW_REASONING_EFFORT: 'high', RATE_LIMIT_PER_MINUTE: '120' };
const FIXED = { ACTIVE_MODEL: 'deepseek', DEFAULT_MODEL: 'deepseek', DEEPSEEK_MODEL: 'deepseek-v4.1-flash', DEEPSEEK_REASONING_EFFORT: 'max',
  CONTEXT_TOKENS: '1048576', REVIEW_MODE: 'off', ANSWER_GUIDE: 'off', ANSWER_ID_CHECK: 'off', FEATURE_TIME_BUDGET: '1',
  MODEL_CALL_RETRIES: '1', MODEL_CALL_TIMEOUT_MS: '240000', MODEL_JSON_FORMAT: 'json_schema', CODE_SYNC_ENABLED: 'false',
  CODE_SYNC_INTERVAL_MINUTES: '0', OBSERVE_INTENT_ROUTER: '0', REVIEWER: 'llm', XKANG_LLM_MOCK: '0', FEISHU_ENABLED: '0',
  FEISHU_APP_ID: '', FEISHU_APP_SECRET: '', XKANG_FEISHU_TOKEN: '', XKANG_MONITOR_ACCOUNTS: '', NODE_OPTIONS: '--max-old-space-size=8192' };
const PRIVATE_KEYS = ['COMPANY_DB_HOST', 'COMPANY_DB_PORT', 'COMPANY_DB_USER', 'COMPANY_DB_PASSWORD', 'GRAFANA_URL', 'GRAFANA_USERNAME', 'GRAFANA_PASSWORD', 'GRAFANA_LOKI_UID'];
const PATH_KEYS = ['CODE_REPO_PATH', 'ACTIVE_MODEL_PATH', 'TOKENS_JSON_PATH', 'AUDIT_LOG_PATH', 'FEISHU_MONITOR_DB_PATH', 'USAGE_LEDGER_PATH', 'VERSION_TRUST_PATH', 'DEPLOYMENT_MANIFEST_PATH', 'CODEGRAPH_ENDPOINT'];
export function loadEnvironment(workspace: string): Record<string, string> {
  return createRequire(path.join(workspace, 'package.json'))('dotenv').parse(fs.readFileSync(path.join(workspace, 'server/.env')));
}
export function environment(base: NodeJS.ProcessEnv, options: { dir: string; code: string; url: string; proxy: string; token: string; admin: string; evidence: '0' | '1'; port: number; slot?: 'deepseek' | 'gemini'; model?: string; jsonFormat?: 'json_object' | 'json_schema' }, osEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'TZ']) if (osEnv[key]) env[key] = osEnv[key];
  for (const key of PRIVATE_KEYS) if (base[key]) env[key] = base[key];
  for (const [key, fallback] of Object.entries(DEFAULTS)) env[key] = base[key] || fallback;
  Object.assign(env, FIXED, { PORT: String(options.port), CASE_EVIDENCE: options.evidence, CODE_REPO_PATH: options.code,
    DEEPSEEK_BASE_URL: options.proxy, DEEPSEEK_API_KEY: 'controlled-pair-proxy-fixture', XKANG_TOKENS: options.token + ':controlled-pair', XKANG_ADMIN_TOKENS: options.admin + ':controlled-pair',
    ACTIVE_MODEL_PATH: path.join(options.dir, 'data/active_model.json'), TOKENS_JSON_PATH: path.join(options.dir, 'data/tokens.json'), AUDIT_LOG_PATH: path.join(options.dir, 'data/audit.jsonl'),
    FEISHU_MONITOR_DB_PATH: path.join(options.dir, 'server/data/feishu_monitor.db'), USAGE_LEDGER_PATH: path.join(options.dir, 'data/usage-ledger.jsonl'),
    VERSION_TRUST_PATH: path.join(options.dir, 'server/data/codegraph/version-trust.json'), DEPLOYMENT_MANIFEST_PATH: path.join(options.dir, 'server/data/codegraph/deployment-manifest.json'),
    CODEGRAPH_ENDPOINT: options.url + '/__eval_no_remote_codegraph', XKANG_MONITOR_SECRET: randomUUID() });
  // Gemini slot as it ran in production: its own client path, json_object answers (json_schema is rejected), reasoning effort high.
  if (options.slot === 'gemini') Object.assign(env, { ACTIVE_MODEL: 'gemini', DEFAULT_MODEL: 'gemini', GEMINI_BASE_URL: options.proxy, GEMINI_API_KEY: 'controlled-pair-proxy-fixture',
    GEMINI_MODEL: options.model || 'gemini-3.8-flash-high', GEMINI_REASONING_EFFORT: 'high', MODEL_JSON_FORMAT: 'json_object' });
  // OpenAI-compatible non-Google models can reuse the Gemini client while selecting their tested answer format.
  if (options.jsonFormat) env.MODEL_JSON_FORMAT = options.jsonFormat;
  return env;
}
export function effectiveEnvironment(env: NodeJS.ProcessEnv): ObjectData {
  const keys = [...Object.keys(DEFAULTS), ...Object.keys(FIXED).filter(k => !['FEISHU_APP_SECRET', 'XKANG_FEISHU_TOKEN'].includes(k)), ...PATH_KEYS, 'PORT', 'CASE_EVIDENCE', 'DEEPSEEK_BASE_URL', 'GEMINI_BASE_URL', 'GEMINI_MODEL'];
  return Object.fromEntries(keys.map(k => [k, env[k] ?? null]));
}
/** Never serialize the source env; redact its private values in extracted diagnostics. */
export function scrubber(base: NodeJS.ProcessEnv): (value: any) => any {
  const values = Object.entries(base).filter(([key]) => /PASSWORD|SECRET|TOKEN|API_KEY/.test(key)).map(([, value]) => value)
    .filter((s): s is string => Boolean(s)).sort((a, b) => b.length - a.length);
  const scrub = (v: any): any => typeof v === 'string' ? (/^data:image\//.test(v) ? v : values.reduce((s, key) => s.split(key).join('[REDACTED_ENV]'), v))
    : Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, val]) => [k, scrub(val)])) : v;
  return scrub;
}
/** SSE framing is independent of UTF-8 chunk boundaries and never searches answer text for status. */
export class SseDecoder {
  private pending = ''; private data: string[] = [];
  constructor(private event: (event: ObjectData) => void, private invalid: (code: string) => void) {}
  push(text: string, eof = false): void {
    this.pending += text; let start = 0;
    for (let i = 0; i < this.pending.length; i++) {
      const char = this.pending[i]; if (char !== '\r' && char !== '\n') continue;
      if (char === '\r' && i === this.pending.length - 1 && !eof) break;
      const line = this.pending.slice(start, i); if (char === '\r' && this.pending[i + 1] === '\n') i++;
      start = i + 1;
      if (line === '') {
        if (this.data.length) {
          const data = this.data.join('\n'); this.data = []; let event: any;
          try { event = JSON.parse(data); } catch { this.invalid('SSE_INVALID_JSON'); continue; }
          if (!event || typeof event.type !== 'string') this.invalid('SSE_INVALID_EVENT'); else this.event(event);
        }
      } else if (line === 'data' || line.startsWith('data:')) this.data.push(line === 'data' ? '' : line.slice(5).replace(/^ /, ''));
    }
    this.pending = this.pending.slice(start);
    if (eof && (this.pending || this.data.length)) this.invalid('SSE_INCOMPLETE_FRAME');
  }
}
export async function readStream(body: ReadableStream<Uint8Array>, signal: AbortSignal, raw: (bytes: Uint8Array) => void,
  event: (event: ObjectData) => void, invalid: (code: string) => void): Promise<'done' | 'error' | 'eof'> {
  const reader = body.getReader(); const text = new TextDecoder(); let terminal: 'done' | 'error' | undefined;
  const parser = new SseDecoder(e => { event(e); if (e.type === 'done' || (e.type === 'error' && terminal !== 'done')) terminal = e.type; }, invalid);
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const item = await reader.read();
      if (item.done) { signal.throwIfAborted(); parser.push(text.decode(), true); return terminal ?? 'eof'; }
      raw(item.value); parser.push(text.decode(item.value, { stream: true })); signal.throwIfAborted(); if (terminal) return terminal;
    }
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); }
}
export function observedSession(session: any): { finished: boolean; frozen: boolean | null; delivery: any; answerPresent: boolean } {
  const answer = session?.turns?.at(-1)?.answer;
  return { finished: session?.status === 'idle' && Array.isArray(session?.turns) && session.turns.length > 0,
    frozen: session ? session.frozen === true : null, delivery: answer?.delivery ?? null, answerPresent: Boolean(answer) };
}
export function auditRun(root: string, dir: string, sessionId: string | null): ObjectData {
  const dbFile = path.join(dir, 'data/xkang.db');
  check(within(fs.realpathSync(dir), fs.realpathSync(dbFile)), 'AUDIT_OUTSIDE_RUN');
  const { DatabaseSync } = createRequire(path.join(root, 'package.json'))('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const row = sessionId ? db.prepare('SELECT private_json, public_json, run_state, frozen_answer FROM agent_sessions WHERE id=?').get(sessionId) : null;
    return { public: row ? JSON.parse(row.public_json) : null,
      private: { sessionId, messages: row ? JSON.parse(row.private_json) : [], runState: row?.run_state ? JSON.parse(row.run_state) : null, frozenAnswer: row?.frozen_answer ?? null },
      audit: db.prepare('SELECT * FROM audit_logs ORDER BY id').all(), activeModel: db.prepare("SELECT value FROM sys_configs WHERE key='active_model'").get()?.value ?? null };
  } finally { db.close(); }
}
export async function stopOwned(child: ChildProcess, exited: Promise<unknown>, waitMs = 5000): Promise<boolean> {
  const alive = () => child.exitCode === null && child.signalCode === null;
  if (!child.pid || !alive()) return true;
  child.kill('SIGTERM');
  await Promise.race([exited, delay(waitMs, undefined, { ref: false })]);
  if (alive()) { child.kill('SIGKILL'); await Promise.race([exited, delay(waitMs, undefined, { ref: false })]); }
  return !alive();
}
