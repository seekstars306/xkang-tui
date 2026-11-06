/** Controlled paired replay; no scoring, builds, proxy/server startup in --dry, or automatic continuation.
 * node --import tsx scripts/eval/controlled_pair.ts --dry
 * EVAL_MODEL_PROXY_BASE=http://127.0.0.1:3066 (origin only), EVAL_CODEGRAPH_DIR=<frozen graph>
 * --repeats=1|2 (default 2), --only=T001,T003; EVAL_CANDIDATE_CASE_EVIDENCE=0 for reliability-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { HARD_CAP_MS, STARTUP_MS, Failure, check, errorCode, sha256, readJson, writeJson, within, treeHash, snapshot, codeHeads,
  ignoredOutput, loadCases, proxyUrl, loadEnvironment, environment, effectiveEnvironment, scrubber, readStream,
  observedSession, auditRun, stopOwned, type Arm, type CaseInput, type ObjectData } from './controlled_pair_helpers.js';

export function parseOptions(args: string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const { values: v } = parseArgs({ args, options: { dry: { type: 'boolean' }, repeats: { type: 'string' }, only: { type: 'string' },
    workspace: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' }, catalog: { type: 'string' }, code: { type: 'string' }, 'run-dir': { type: 'string' }, arms: { type: 'string' }, sequential: { type: 'boolean' } }, strict: true });
  check(v.repeats === undefined || ['1', '2'].includes(v.repeats), 'REPEATS_MUST_BE_1_OR_2');
  const evidence = env.EVAL_CANDIDATE_CASE_EVIDENCE ?? '1'; check(evidence === '0' || evidence === '1', 'INVALID_CASE_EVIDENCE');
  const workspace = path.resolve(cwd, v.workspace ?? '.'); const flow = path.join(workspace, 'eval_run/flow-v1-20261030');
  const batchId = 'pair-' + new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
  const only = v.only?.split(','); check(!only || (only.length > 0 && only.every(s => /^[A-Za-z0-9_-]+$/.test(s)) && new Set(only).size === only.length), 'INVALID_ONLY');
  // --arms limits which versions run (a single-arm batch is always sequential); --sequential runs the two arms of a pair one after another
  // instead of concurrently, for an upstream route that effectively serves one request at a time.
  const arms = (v.arms ?? 'baseline,candidate').split(',') as Arm[];
  check(arms.length > 0 && arms.every(a => a === 'baseline' || a === 'candidate') && new Set(arms).size === arms.length, 'INVALID_ARMS');
  const slot = env.EVAL_MODEL_SLOT ?? 'deepseek'; check(slot === 'deepseek' || slot === 'gemini', 'INVALID_MODEL_SLOT');
  const jsonFormat = env.EVAL_MODEL_JSON_FORMAT ?? (slot === 'gemini' ? 'json_object' : 'json_schema');
  check(jsonFormat === 'json_object' || jsonFormat === 'json_schema', 'INVALID_JSON_FORMAT');
  const effort = env.EVAL_EXPECTED_EFFORT ?? (slot === 'gemini' ? 'high' : 'max');
  check(slot !== 'gemini' || effort === 'high', 'GEMINI_CLIENT_REQUIRES_HIGH_EFFORT');
  check(slot !== 'gemini' || Boolean(env.EVAL_EXPECTED_MODEL), 'GEMINI_UPSTREAM_MODEL_REQUIRED');
  return { workspace, baseline: path.resolve(workspace, v.baseline ?? path.join(flow, 'baseline')), candidate: path.resolve(workspace, v.candidate ?? workspace),
    catalog: path.resolve(workspace, v.catalog ?? path.join(flow, 'inputs/case-catalog.json')), code: path.resolve(workspace, v.code ?? path.join(flow, 'code')),
    graph: env.EVAL_CODEGRAPH_DIR ? path.resolve(workspace, env.EVAL_CODEGRAPH_DIR) : '', proxy: env.EVAL_MODEL_PROXY_BASE,
    output: path.resolve(workspace, v['run-dir'] ?? path.join(flow, batchId)), batchId, repeats: Number(v.repeats ?? '2'), only, dry: Boolean(v.dry), evidence: evidence as '0' | '1',
    arms, sequential: Boolean(v.sequential) || arms.length === 1, proxyGlobal: Number(env.EVAL_EXPECTED_PROXY_GLOBAL ?? '2'),
    slot: slot as 'deepseek' | 'gemini', effort, jsonFormat: jsonFormat as 'json_object' | 'json_schema' };
}
export const armOrder = (caseIndex: number, round: number): Arm[] => (caseIndex + round - 1) % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    promise.then(v => { signal.removeEventListener('abort', abort); resolve(v); }, e => { signal.removeEventListener('abort', abort); reject(e); });
  });
}
/** Readiness is symmetric; dispatch order is fixed even when the second arm starts faster. */
export function pairGate() {
  let arrivals = 0; let release!: () => void; let dispatched!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const firstSent = new Promise<void>(resolve => { dispatched = resolve; });
  return { wait: async (rank: number, signal: AbortSignal) => {
    if (++arrivals === 2) release(); await abortable(ready, signal);
    if (rank === 1) await abortable(firstSent, signal);
  }, sent: (rank: number) => { if (rank === 0) dispatched(); } };
}
const now = () => new Date().toISOString();
const progress = (step: string, details: ObjectData = {}) => console.log(JSON.stringify({ at: now(), step, ...details }));
async function jsonRequest(url: string, headers: Record<string, string>, signal: AbortSignal, method = 'GET'): Promise<any> {
  const response = await fetch(url, { method, headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
  check(response.ok, 'HTTP_' + response.status); return response.json();
}
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject);
    socket.listen(0, () => { const address = socket.address(); const port = address && typeof address !== 'string' ? address.port : 0;
      socket.close(err => err ? reject(err) : resolve(port)); });
  });
}
function graphCheck(graph: string): ObjectData {
  check(graph && fs.statSync(graph).isDirectory(), 'EVAL_CODEGRAPH_DIR_REQUIRED');
  for (const name of ['stats', 'definitions', 'implementations', 'callers', 'callees', 'references']) readJson(path.join(graph, name + '.json'));
  return treeHash(graph);
}
function lifecycle(dir: string): ObjectData[] {
  const file = path.join(dir, 'data/service-lifecycle.jsonl'); if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').flatMap(line => {
    try { const data = JSON.parse(line); return [Object.fromEntries(['timestamp', 'pid', 'event', 'port', 'code', 'exitCode', 'reason'].filter(k => k in data).map(k => [k, data[k]]))]; }
    catch { return []; }
  });
}
type Options = ReturnType<typeof parseOptions>;
interface Context { options: Options; versions: Record<Arm, ObjectData>; graphHash: ObjectData; base: NodeJS.ProcessEnv; scrub: (v: any) => any; signal: AbortSignal }
async function runOne(context: Context, input: CaseInput, record: ObjectData, gate: (signal: AbortSignal) => Promise<void>, sent: () => void, peer: AbortController): Promise<void> {
  const { options: o, base, scrub } = context; const arm = record.arm as Arm; const root = context.versions[arm].root;
  const dir = record.dir; const timing = record.timing; let child: ChildProcess | undefined; let exited = Promise.resolve();
  const died = new AbortController(); const cap = new AbortController();
  const signal = AbortSignal.any([context.signal, peer.signal, died.signal, cap.signal]);
  let capTimer: NodeJS.Timeout | undefined; let rawFd: number | undefined; let eventFd: number | undefined; let settled = false; let ownedDir = false;
  let publicSession: any = null; let privateState: any = null; let audit: any[] = []; let url = ''; let headers: Record<string, string> = {};
  const addError = (code: string, source: string) => timing.errors.push({ at: now(), code, source });
  const save = () => {
    writeJson(path.join(dir, 'public.json'), scrub(publicSession)); writeJson(path.join(dir, 'private.json'), scrub(privateState));
    writeJson(path.join(dir, 'audit.json'), scrub(audit)); writeJson(path.join(dir, 'timing.json'), timing); writeJson(path.join(dir, 'run.json'), record);
  };
  const checkpoint = () => {
    if (fs.existsSync(path.join(dir, 'data/xkang.db'))) {
      try { const result = auditRun(root, dir, timing.sessionId); privateState = result.private; audit = result.audit;
        publicSession = result.public ?? publicSession; record.activeModel = result.activeModel; record.auditCaptured = true; }
      catch (error) { addError(errorCode(error), 'db_audit'); }
    }
    save();
  };
  const getStatus = async (requestSignal: AbortSignal) => {
    const value = await jsonRequest(url + '/agent/sessions/' + timing.sessionId, headers, requestSignal);
    check(value?.id === timing.sessionId && ['idle', 'running', 'waiting_question'].includes(value.status), 'INVALID_SESSION_STATUS');
    publicSession = value; fs.appendFileSync(path.join(dir, 'status.jsonl'), JSON.stringify({ at: now(), session: scrub(value) }) + '\n');
    return observedSession(value);
  };
  try {
    fs.mkdirSync(dir); ownedDir = true; fs.mkdirSync(path.join(dir, 'data')); save();
    signal.throwIfAborted();
    fs.writeFileSync(path.join(dir, 'input.json'), input.bytes, { flag: 'wx', mode: 0o600 });
    rawFd = fs.openSync(path.join(dir, 'events.raw.sse'), 'wx', 0o600); eventFd = fs.openSync(path.join(dir, 'events.jsonl'), 'wx', 0o600);
    fs.cpSync(o.graph, path.join(dir, 'server/data/codegraph'), { recursive: true, errorOnExist: true, force: false });
    check(treeHash(path.join(dir, 'server/data/codegraph')).sha256 === context.graphHash.sha256, 'GRAPH_COPY_MISMATCH');
    const port = await freePort(); url = 'http://127.0.0.1:' + port;
    const token = randomUUID(); const admin = randomUUID(); headers = { authorization: 'Bearer ' + token };
    const env = environment(base, { dir, code: o.code, url, proxy: proxyUrl(o.proxy, record.runId), token, admin, port, evidence: arm === 'candidate' ? o.evidence : '0', slot: o.slot, model: process.env.EVAL_EXPECTED_MODEL, jsonFormat: o.jsonFormat });
    record.effectiveEnv = effectiveEnvironment(env); record.sessionDb = path.join(dir, 'data/xkang.db');
    timing.spawnAt = now(); capTimer = setTimeout(() => cap.abort(new Failure('HARD_CAP_45_MIN')), HARD_CAP_MS);
    // Never capture or persist arbitrary child output (SDK/dotenv error text can contain env/keys).
    const sink = fs.openSync(os.devNull, 'w');
    try { child = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href, path.join(root, 'server/src/index.ts')],
      { cwd: dir, env, stdio: ['ignore', sink, sink], windowsHide: true }); }
    finally { fs.closeSync(sink); }
    const ownedChild = child;
    exited = new Promise(resolve => {
      ownedChild.once('exit', (code, exitSignal) => { timing.processexit = { at: now(), code, signal: exitSignal }; died.abort(new Failure('CHILD_EXITED')); resolve(); });
      ownedChild.once('error', error => { addError(errorCode(error), 'child'); died.abort(new Failure('CHILD_ERROR')); if (!ownedChild.pid) resolve(); });
    });
    record.pid = child.pid ?? null; record.status = 'STARTING'; save(); progress('spawn', { runId: record.runId, pid: record.pid });
    const startup = AbortSignal.any([signal, AbortSignal.timeout(STARTUP_MS)]);
    for (;;) {
      startup.throwIfAborted();
      try { const health = await jsonRequest(url + '/healthz', {}, startup);
        if (health.status === 'ok' && health.service === 'xkang-company-server') break; }
      catch { startup.throwIfAborted(); }
      await delay(300, undefined, { signal: startup });
    }
    const model = await jsonRequest(url + '/admin/model', { authorization: 'Bearer ' + admin }, startup);
    check(model.activeModel === o.slot && model.mockMode === false, 'ACTIVE_MODEL_MISMATCH');
    const session = await jsonRequest(url + '/agent/sessions', headers, startup, 'POST');
    check(typeof session?.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(session.id) && session.status === 'idle' && session.turns?.length === 0, 'SESSION_NOT_FRESH');
    timing.sessionId = session.id; publicSession = session; timing.readyAt = now(); record.status = 'READY'; save(); progress('ready', { runId: record.runId });
    await gate(startup); // No arm sends a question unless both isolated servers are ready.
    timing.questionSentAt = now(); record.status = 'RUNNING'; save(); progress('question_sent', { runId: record.runId });
    let terminal: 'done' | 'error' | 'eof' = 'eof';
    try {
      const responsePromise = fetch(url + '/agent/sessions/' + timing.sessionId + '/messages', { method: 'POST', redirect: 'error',
        headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ message: input.content }), signal });
      sent(); const response = await responsePromise;
      record.messageHttpStatus = response.status; check(response.body, 'MISSING_RESPONSE_BODY');
      const isSse = response.headers.get('content-type')?.split(';')[0] === 'text/event-stream';
      terminal = await readStream(response.body, signal, bytes => fs.writeFileSync(rawFd!, bytes), event => {
        timing.firstEventAt ??= now(); fs.writeFileSync(eventFd!, JSON.stringify({ at: now(), event: scrub(event) }) + '\n');
        if (event.type === 'error') addError(typeof event.code === 'string' && /^[A-Z0-9_]+$/.test(event.code) ? event.code : 'SERVER_ERROR', 'sse');
        if (event.type === 'done') timing.completedAt = now();
        progress('event', { runId: record.runId, type: ['progress', 'question', 'answer', 'error', 'done'].includes(event.type) ? event.type : 'unknown' });
      }, code => addError(code, 'sse_parse'));
      check(response.ok, 'HTTP_' + response.status); check(isSse, 'NOT_EVENT_STREAM');
    } catch (error) { sent(); addError(signal.aborted ? errorCode(signal.reason) : errorCode(error), 'stream'); }
    record.terminalEvent = terminal; checkpoint(); // Preserve received bytes and DB before GET recovery.
    let state = observedSession(publicSession); let failures = 0;
    for (;;) {
      signal.throwIfAborted();
      try { state = await getStatus(signal); failures = 0; }
      catch (error) { addError(errorCode(error), 'status'); if (++failures >= 3) throw new Failure('STATUS_RECOVERY_FAILED'); }
      if (failures > 0) { await delay(2000, undefined, { signal }); continue; }
      if (state.finished) break;
      if (record.messageHttpStatus >= 400 || publicSession?.status === 'idle') throw new Failure('QUESTION_NOT_ACCEPTED');
      if (terminal === 'done') throw new Failure('DONE_WITHOUT_TERMINAL_SESSION');
      record.status = 'RECOVERING'; progress('recovering', { runId: record.runId, status: publicSession?.status ?? null });
      await delay(2000, undefined, { signal });
    }
    settled = true; timing.completedAt ??= now();
    record.status = terminal === 'done' ? 'COMPLETED' : terminal === 'error' ? 'SERVER_ERROR' : 'COMPLETED_AFTER_DISCONNECT';
  } catch (error) {
    addError(signal.aborted ? errorCode(signal.reason) : errorCode(error), timing.questionSentAt ? 'run' : 'startup');
    record.status = 'INFRA_INTERRUPTED'; if (!timing.questionSentAt) peer.abort(new Failure('PEER_STARTUP_FAILED'));
  } finally {
    if (capTimer) clearTimeout(capTimer);
    if (child) {
      try { record.childStopped = await stopOwned(child, exited); if (!record.childStopped) { addError('CHILD_STOP_FAILED', 'cleanup'); record.status = 'INFRA_INTERRUPTED'; } }
      catch (error) { addError(errorCode(error), 'cleanup'); record.childStopped = false; }
    }
    if (rawFd !== undefined) fs.closeSync(rawFd); if (eventFd !== undefined) fs.closeSync(eventFd);
    timing.completedAt ??= now(); timing.wallMs = timing.spawnAt ? Date.parse(timing.completedAt) - Date.parse(timing.spawnAt) : null;
    try {
      if (ownedDir) {
        checkpoint(); const state = observedSession(publicSession); timing.frozen = state.frozen; timing.delivery = state.delivery;
        record.answerPresent = state.answerPresent; record.terminalSessionObserved = settled; record.lifecycle = lifecycle(dir);
        if (timing.questionSentAt && !record.auditCaptured) { addError('AUDIT_MISSING', 'integrity'); record.status = 'INFRA_INTERRUPTED'; }
        record.finalVersion = snapshot(root); if (JSON.stringify(record.finalVersion) !== JSON.stringify(context.versions[arm])) { addError('SOURCE_DRIFT', 'integrity'); record.status = 'INFRA_INTERRUPTED'; }
        save();
      }
    } catch (error) { addError(errorCode(error), 'final_artifacts'); record.status = 'INFRA_INTERRUPTED';
      if (ownedDir) { try { save(); } catch { /* The in-memory record still reaches all-summary. */ } } }
    progress('run_finished', { runId: record.runId, status: record.status, frozen: timing.frozen, delivery: timing.delivery, wallMs: timing.wallMs, errors: timing.errors.length });
  }
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const o = parseOptions(args); progress('preflight', { dry: o.dry, repeats: o.repeats });
  check(Number(process.versions.node.split('.')[0]) >= 22, 'NODE_22_REQUIRED');
  o.workspace = fs.realpathSync(o.workspace); o.baseline = fs.realpathSync(o.baseline); o.candidate = fs.realpathSync(o.candidate); o.code = fs.realpathSync(o.code);
  check(o.baseline !== o.candidate, 'BASELINE_IS_CANDIDATE');
  check(o.graph, 'EVAL_CODEGRAPH_DIR_REQUIRED'); o.graph = fs.realpathSync(o.graph);
  if (o.proxy || !o.dry) proxyUrl(o.proxy, o.batchId);
  ignoredOutput(o.workspace, o.output);
  check(!within(o.code, o.output) && !within(o.baseline, o.output) && !within(o.graph, o.output), 'RUN_DIR_INSIDE_FROZEN_TREE');
  const cases = loadCases(o.workspace, o.catalog, o.only); const graphHash = graphCheck(o.graph);
  const versions = { baseline: snapshot(o.baseline), candidate: snapshot(o.candidate) };
  check(versions.baseline.head === '1ca4cbdb2c34a0646ec3271d2ef14172a4465044', 'BASELINE_HEAD_MISMATCH');
  check(versions.baseline.serviceMapSha256 === versions.candidate.serviceMapSha256, 'SERVICE_MAP_MISMATCH');
  check(JSON.stringify(versions.baseline.versions) === JSON.stringify(versions.candidate.versions), 'RUNTIME_VERSION_MISMATCH');
  const repos = codeHeads(o.code); const base = loadEnvironment(o.workspace); const scrub = scrubber(base);
  const summary: ObjectData = { schema: 1, batchId: o.batchId, createdAt: now(), versions, graph: { path: o.graph, ...graphHash }, code: { path: o.code, repos },
    catalogSha256: sha256(fs.readFileSync(o.catalog)), repeats: o.repeats, caseEvidence: { baseline: '0', candidate: o.evidence },
    controls: { model: process.env.EVAL_EXPECTED_MODEL || 'deepseek-v4.1-flash', modelSlot: o.slot, reasoningEffort: o.effort, responseFormat: o.jsonFormat, maxTokens: Number(process.env.EVAL_EXPECTED_MAX_TOKENS || 128000), proxyEnforcedLimits: { global: o.proxyGlobal, perRun: 1 }, arms: o.arms, dispatch: o.sequential ? 'sequential' : 'paired-concurrent',
      applicationAttempts: 1, sdkRetries: { baseline: 1, candidate: 0 }, internalActiveBudgetMs: 900000, hardCapMs: HARD_CAP_MS,
      envSource: 'shared workspace server/.env (memory only)', databaseSnapshot: false, dataPolicy: 'paired near-simultaneous live read-only tools; NOT a common DB snapshot',
      automaticContinuation: false, automaticRerun: false, childOutput: 'discarded; machine lifecycle/exit codes retained', scoring: false }, runs: [], errors: [] };
  for (let round = 1; round <= o.repeats; round++) for (const input of cases) for (const arm of armOrder(input.index, round).filter(a => o.arms.includes(a))) {
    const runId = o.batchId + '-' + input.id + '-r' + round + '-' + arm;
    summary.runs.push({ runId, arm, round, caseId: input.id, dir: path.join(o.output, runId), status: 'PLANNED', version: versions[arm],
      input: { file: input.inputFile, sha256: input.inputFileSha256, contentSha256: input.contentSha256, images: input.images },
      timing: { spawnAt: null, readyAt: null, questionSentAt: null, firstEventAt: null, completedAt: null, wallMs: null, sessionId: null, frozen: null, delivery: null, errors: [], processexit: null } });
  }
  progress('validated', { cases: cases.map(c => c.id), runs: summary.runs.length, baseline: versions.baseline.serverSource.sha256, candidate: versions.candidate.serverSource.sha256, graph: graphHash.sha256 });
  if (o.dry) { progress('dry_complete', { queries: 0, serversStarted: 0, outputCreated: false }); return; }
  fs.mkdirSync(o.output); const summaryFile = path.join(o.output, 'all-summary.json'); const saveSummary = () => writeJson(summaryFile, summary);
  const interrupted = new AbortController(); const interrupt = () => interrupted.abort(new Failure('OPERATOR_INTERRUPTED'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt); saveSummary();
  const proxyHealth = async () => {
    const value = await jsonRequest(new URL(o.proxy!).origin + '/health', {}, interrupted.signal);
    check(value.status === 'ok' && value.canonical?.model === (process.env.EVAL_EXPECTED_MODEL || 'deepseek-v4.1-flash') && value.canonical?.reasoning_effort === o.effort
      && value.canonical?.max_tokens === Number(process.env.EVAL_EXPECTED_MAX_TOKENS || 128000) && value.limits?.global === o.proxyGlobal && value.limits?.perRun === 1, 'PROXY_CONTROL_MISMATCH');
    check(value.active === 0 && value.queued === 0, 'PROXY_NOT_QUIESCENT'); summary.proxyVerifiedAt = now();
  };
  try {
    const step = o.sequential ? 1 : 2;
    for (let i = 0; i < summary.runs.length; i += step) {
      interrupted.signal.throwIfAborted(); await proxyHealth();
      check(JSON.stringify(snapshot(o.candidate)) === JSON.stringify(versions.candidate) && JSON.stringify(snapshot(o.baseline)) === JSON.stringify(versions.baseline), 'SOURCE_DRIFT');
      check(treeHash(o.graph).sha256 === graphHash.sha256 && JSON.stringify(codeHeads(o.code)) === JSON.stringify(repos), 'DATA_DRIFT');
      const records = summary.runs.slice(i, i + step); const input = cases.find(c => c.id === records[0].caseId)!;
      check(sha256(fs.readFileSync(input.inputFile)) === input.inputFileSha256, 'INPUT_DRIFT');
      const gate = pairGate();
      const peer = new AbortController(); progress('pair_started', { caseId: input.id, round: records[0].round, order: records.map((r: any) => r.arm) });
      const outcomes = await Promise.allSettled(records.map((record: ObjectData, rank: number) => runOne({ options: o, versions, graphHash, base, scrub, signal: interrupted.signal }, input, record,
        o.sequential ? async () => {} : signal => gate.wait(rank, signal), o.sequential ? () => {} : () => gate.sent(rank), peer)));
      outcomes.forEach((result, j) => { if (result.status === 'rejected') { records[j].status = 'INFRA_INTERRUPTED'; records[j].timing.errors.push({ code: errorCode(result.reason), source: 'runner' }); } });
      saveSummary(); check(records.every((r: any) => r.childStopped !== false), 'CHILD_STOP_FAILED');
      check(!records.some((r: any) => r.timing.errors.some((e: any) => e.code === 'SOURCE_DRIFT')), 'SOURCE_DRIFT');
    }
  } catch (error) { summary.errors.push({ at: now(), code: interrupted.signal.aborted ? errorCode(interrupted.signal.reason) : errorCode(error) }); }
  finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    for (const run of summary.runs) if (run.status === 'PLANNED') {
      run.status = 'NOT_STARTED_INFRA'; run.timing.errors.push({ at: now(), code: 'BATCH_STOPPED_BEFORE_RUN', source: 'runner' });
      try { fs.mkdirSync(run.dir); for (const name of ['public', 'private', 'audit']) writeJson(path.join(run.dir, name + '.json'), null);
        fs.writeFileSync(path.join(run.dir, 'events.raw.sse'), ''); writeJson(path.join(run.dir, 'timing.json'), run.timing); writeJson(path.join(run.dir, 'run.json'), run); }
      catch (error) { summary.errors.push({ code: errorCode(error), runId: run.runId, source: 'skipped_artifacts' }); }
    }
    summary.completedAt = now(); saveSummary();
    if (summary.errors.length || summary.runs.some((r: any) => r.status === 'INFRA_INTERRUPTED' || r.status === 'NOT_STARTED_INFRA')) process.exitCode = 1;
    progress('all_finished', { output: o.output, runs: summary.runs.length, infraFailures: summary.runs.filter((r: any) => ['INFRA_INTERRUPTED', 'NOT_STARTED_INFRA'].includes(r.status)).length });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { progress('fatal', { code: errorCode(error) }); process.exitCode = 1; });
