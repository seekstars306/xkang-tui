import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseOptions, armOrder, abortable, pairGate } from '../../scripts/eval/controlled_pair.js';
import { Failure, HARD_CAP_MS, canonicalJson, sha256, treeHash, loadCases, proxyUrl, environment, effectiveEnvironment,
  scrubber, readStream, observedSession, auditRun, stopOwned, errorCode, type ObjectData } from '../../scripts/eval/controlled_pair_helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function fixture(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'controlled-pair-test-'));
  t.after(() => { assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir())); assert.match(path.basename(dir), /^controlled-pair-test-/); fs.rmSync(dir, { recursive: true }); });
  return dir;
}
function catalog(dir: string, content: any = [{ text: '原题 done / error', type: 'text' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAECAwQ=' } }]) {
  const file = path.join(dir, 'input.json'); const bytes = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content }] }, null, 2)); fs.writeFileSync(file, bytes);
  const items = Array.from({ length: 8 }, (_, i) => ({ id: 'T00' + i, aliases: i === 1 ? ['alias'] : [], inputFile: 'input.json', inputFileSha256: sha256(bytes), canonicalUserContentSha256: sha256(canonicalJson(content)) }));
  const catalogFile = path.join(dir, 'catalog.json'); fs.writeFileSync(catalogFile, JSON.stringify({ cases: items })); return { catalogFile, items, bytes, content };
}
function byteStream(bytes: Buffer, close = true): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({ pull(controller) { if (index < bytes.length) controller.enqueue(bytes.subarray(index, ++index)); else if (close) controller.close(); } });
}
test('CLI defaults to exactly 32 scheduled runs and fixed alternating order; invalid budgets rejected', () => {
  const o = parseOptions([], {}, root); assert.equal(o.repeats, 2); assert.equal(o.evidence, '1'); assert.equal(o.repeats * 8 * 2, 32);
  assert.deepEqual(armOrder(0, 1), ['baseline', 'candidate']); assert.deepEqual(armOrder(1, 1), ['candidate', 'baseline']);
  assert.deepEqual(armOrder(0, 2), ['candidate', 'baseline']);
  assert.equal(parseOptions(['--repeats=1', '--only=T001,T003'], { EVAL_CANDIDATE_CASE_EVIDENCE: '0' }, root).evidence, '0');
  for (const args of [['--repeats=3'], ['--only=T001,'], ['--only=T001,T001'], ['--cap=1'], ['--continue'], ['--arms=main'], ['--arms=baseline,baseline']]) assert.throws(() => parseOptions(args, {}, root));
  assert.deepEqual([o.arms, o.sequential, o.proxyGlobal], [['baseline', 'candidate'], false, 2]);
  const single = parseOptions(['--arms=baseline'], { EVAL_EXPECTED_PROXY_GLOBAL: '1' }, root);
  assert.deepEqual([single.arms, single.sequential, single.proxyGlobal], [['baseline'], true, 1]);
  assert.equal(parseOptions(['--sequential'], {}, root).sequential, true);
  assert.deepEqual([o.slot, o.effort], ['deepseek', 'max']);
  const gem = parseOptions([], { EVAL_MODEL_SLOT: 'gemini', EVAL_EXPECTED_MODEL: 'gemini-3.8-flash-high', EVAL_EXPECTED_EFFORT: 'high' }, root);
  assert.deepEqual([gem.slot, gem.effort, gem.jsonFormat], ['gemini', 'high', 'json_object']);
  assert.equal(HARD_CAP_MS, 45 * 60_000);
  assert.equal(o.candidate, root);
  const separate = parseOptions(['--candidate=eval_run/candidate-v2'], {}, root);
  assert.equal(separate.workspace, root);
  assert.equal(separate.candidate, path.resolve(root, 'eval_run/candidate-v2'));
  assert.ok(separate.catalog.startsWith(path.join(root, 'eval_run')), '输入仍来自原实验配置，不跟候选目录漂移');
});
test('Sonnet client configuration pins an explicit model and permits a tested schema override', () => {
  const vars = { EVAL_MODEL_SLOT: 'gemini', EVAL_EXPECTED_MODEL: 'linke2/claude-sonnet-5-5', EVAL_MODEL_JSON_FORMAT: 'json_schema' };
  const o = parseOptions(['--arms=baseline'], vars, root);
  assert.deepEqual([o.slot, o.effort, o.jsonFormat], ['gemini', 'high', 'json_schema']);
  assert.throws(() => parseOptions([], { EVAL_MODEL_SLOT: 'claude' }, root), /INVALID_MODEL_SLOT/);
  assert.throws(() => parseOptions([], { EVAL_MODEL_SLOT: 'gemini' }, root), /GEMINI_UPSTREAM_MODEL_REQUIRED/);
  assert.throws(() => parseOptions([], { ...vars, EVAL_EXPECTED_EFFORT: 'max' }, root), /GEMINI_CLIENT_REQUIRES_HIGH_EFFORT/);
  assert.throws(() => parseOptions([], { ...vars, EVAL_MODEL_JSON_FORMAT: 'text' }, root), /INVALID_JSON_FORMAT/);
  const env = environment({}, { dir: 'run', code: 'frozen-code', url: 'http://127.0.0.1:1234', proxy: 'http://127.0.0.1:3069/run/smoke/v1', token: 'fixture-token', admin: 'fixture-admin', evidence: '0', port: 1234, slot: o.slot, model: vars.EVAL_EXPECTED_MODEL, jsonFormat: o.jsonFormat }, {});
  assert.equal(env.MODEL_JSON_FORMAT, 'json_schema');
  assert.equal(env.GEMINI_MODEL, vars.EVAL_EXPECTED_MODEL);
  assert.equal(env.GEMINI_REASONING_EFFORT, 'high');
  assert.equal(env.ACTIVE_MODEL, 'gemini');
  assert.equal(effectiveEnvironment(env).MODEL_JSON_FORMAT, 'json_schema');
});

test('input hashes use canonical keys while exact input and screenshot bytes are preserved', t => {
  const dir = fixture(t); const f = catalog(dir); const cases = loadCases(dir, f.catalogFile, ['alias']);
  assert.equal(cases.length, 1); assert.equal(cases[0].id, 'T001'); assert.deepEqual(cases[0].bytes, f.bytes); assert.deepEqual(cases[0].content, f.content);
  assert.deepEqual(cases[0].images[0], { contentPartIndex: 1, bytes: 5, sha256: sha256(Buffer.from([0, 1, 2, 3, 4])), dataUrlSha256: sha256('data:image/png;base64,AAECAwQ=') });
  assert.throws(() => loadCases(dir, f.catalogFile, ['T099']), /UNKNOWN_CASE/);
  fs.appendFileSync(path.join(dir, 'input.json'), ' '); assert.throws(() => loadCases(dir, f.catalogFile), /INPUT_HASH_MISMATCH/);
});
test('catalog rejects history, image conversion, and escapes before any query', t => {
  const dir = fixture(t); const f = catalog(dir); const inputFile = path.join(dir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reference' }] }));
  f.items.forEach(c => c.inputFileSha256 = sha256(fs.readFileSync(inputFile))); fs.writeFileSync(f.catalogFile, JSON.stringify({ cases: f.items }));
  assert.throws(() => loadCases(dir, f.catalogFile), /INPUT_NOT_PURE_USER/);
  catalog(dir, [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }]); assert.throws(() => loadCases(dir, f.catalogFile), /INVALID_IMAGE_DATA/);
  const g = catalog(dir); fs.mkdirSync(path.join(dir, 'nested')); fs.writeFileSync(path.join(dir, 'nested/catalog.json'), JSON.stringify({ cases: g.items }));
  assert.throws(() => loadCases(dir, path.join(dir, 'nested/catalog.json')), /INPUT_OUTSIDE_CATALOG_DIR/);
});
test('recursive hash includes names and binary bytes, ignores prohibited subtrees', t => {
  const dir = fixture(t); fs.writeFileSync(path.join(dir, 'a'), Buffer.from([0, 255])); const first = treeHash(dir);
  for (const sub of ['node_modules', 'eval_run', '.git']) { fs.mkdirSync(path.join(dir, sub)); fs.writeFileSync(path.join(dir, sub, 'secret'), 'not hashed'); }
  assert.deepEqual(treeHash(dir), first); fs.renameSync(path.join(dir, 'a'), path.join(dir, 'b')); assert.notEqual(treeHash(dir).sha256, first.sha256);
  const renamed = treeHash(dir).sha256; fs.writeFileSync(path.join(dir, 'b'), Buffer.from([0, 254])); assert.notEqual(treeHash(dir).sha256, renamed);
});
test('proxy and environment fail closed, isolate tokens and paths, never export secrets', () => {
  assert.throws(() => proxyUrl(undefined, 'run'), /REQUIRED/); assert.throws(() => proxyUrl('http://u:secret@localhost:1', 'run'));
  assert.throws(() => proxyUrl('http://localhost:1/v1', 'run')); assert.throws(() => proxyUrl('http://localhost:1', '../run'));
  const proxy = proxyUrl('http://127.0.0.1:3066', 'run-T001'); assert.equal(proxy, 'http://127.0.0.1:3066/run/run-T001/v1');
  const base = { FEISHU_APP_SECRET: 'do-not-forward', DEEPSEEK_API_KEY: 'long-real-key', COMPANY_DB_PASSWORD: 'private-password', COMPANY_DB_USER: 'business', COMPANY_DB_HOST: '10.1.2.3', NODE_OPTIONS: '--inspect', REVIEW_MODE: 'gate', MODEL_CALL_TIMEOUT_MS: '1' };
  const env = environment(base, { dir: path.join(root, 'eval_run/test'), code: 'frozen-code', url: 'http://127.0.0.1:1234', proxy, token: 'run-token', admin: 'run-admin', evidence: '0', port: 1234 }, {});
  assert.equal(env.DEEPSEEK_API_KEY, 'controlled-pair-proxy-fixture'); assert.equal(env.FEISHU_APP_SECRET, ''); assert.equal(env.REVIEW_MODE, 'off');
  assert.equal(env.MODEL_CALL_TIMEOUT_MS, '240000'); assert.equal(env.MODEL_CALL_RETRIES, '1'); assert.equal(env.CONTEXT_TOKENS, '1048576'); assert.equal(env.CASE_EVIDENCE, '0');
  assert.equal(env.CODE_SYNC_ENABLED, 'false'); assert.equal(env.NODE_OPTIONS, '--max-old-space-size=8192');
  assert.equal(effectiveEnvironment(env).DEEPSEEK_API_KEY, undefined); assert.equal(effectiveEnvironment(env).COMPANY_DB_PASSWORD, undefined);
  assert.equal(JSON.stringify(effectiveEnvironment(env)).includes('run-token'), false);
  assert.equal(env.ACTIVE_MODEL, 'deepseek'); assert.equal(env.GEMINI_BASE_URL, undefined);
  const gem = environment({ ...base, GEMINI_API_KEY: 'real-gemini-key' }, { dir: path.join(root, 'eval_run/test'), code: 'frozen-code', url: 'http://127.0.0.1:1234', proxy, token: 'run-token', admin: 'run-admin', evidence: '0', port: 1234, slot: 'gemini', model: 'gemini-3.8-flash-high' }, {});
  assert.deepEqual([gem.ACTIVE_MODEL, gem.GEMINI_BASE_URL, gem.GEMINI_API_KEY, gem.GEMINI_MODEL, gem.GEMINI_REASONING_EFFORT, gem.MODEL_JSON_FORMAT],
    ['gemini', proxy, 'controlled-pair-proxy-fixture', 'gemini-3.8-flash-high', 'high', 'json_object']);
  assert.equal(JSON.stringify(effectiveEnvironment(gem)).includes('real-gemini-key'), false);
  const scrub = scrubber(base); assert.equal(scrub('business 10.1.2.3 private-password long-real-key'), 'business 10.1.2.3 [REDACTED_ENV] [REDACTED_ENV]');
  assert.equal(scrubber({ COMPANY_DB_PASSWORD: 'AA' })('data:image/png;base64,AA=='), 'data:image/png;base64,AA==');
  assert.equal(errorCode(new Error('private-password')), 'RUNNER_ERROR');
});
test('SSE handles UTF8 byte splits, CRLF, multiline data, and literal done/error text', async () => {
  const source = Buffer.from(': heartbeat\r\n\r\ndata: {"type":"answer",\r\ndata: "answer":{"conclusion":"未完成 done error 中文"}}\r\n\r\ndata: {"type":"done"}\r\n\r\n');
  const raw: Buffer[] = []; const events: any[] = []; const errors: string[] = [];
  const status = await readStream(byteStream(source), new AbortController().signal, b => raw.push(Buffer.from(b)), e => events.push(e), e => errors.push(e));
  assert.equal(status, 'done'); assert.deepEqual(Buffer.concat(raw), source); assert.equal(events[0].answer.conclusion, '未完成 done error 中文'); assert.deepEqual(errors, []);
});
test('SSE retains machine errors and malformed/truncated frames without inventing done', async () => {
  for (const [source, terminal, codes] of [
    ['data: {"type":"error","code":"MODEL_TIMEOUT"}\n\n', 'error', []],
    ['data: {"type":"answer","answer":"done"}\n\n', 'eof', []],
    ['data: invalid\n\ndata: {"type":"done"}', 'eof', ['SSE_INVALID_JSON', 'SSE_INCOMPLETE_FRAME']],
  ] as const) {
    const raw: Buffer[] = []; const errors: string[] = []; const events: any[] = [];
    const status = await readStream(byteStream(Buffer.from(source)), new AbortController().signal, b => raw.push(Buffer.from(b)), e => events.push(e), code => errors.push(code));
    assert.equal(status, terminal); assert.equal(Buffer.concat(raw).toString(), source); assert.deepEqual(errors, codes);
  }
});
test('stream disconnection and external hard cap preserve received bytes and unblock', async () => {
  const controller = new AbortController(); const bytes = Buffer.from('data: {"type":"progress"}\n\n'); const raw: Buffer[] = [];
  const promise = readStream(byteStream(bytes, false), controller.signal, b => raw.push(Buffer.from(b)), () => controller.abort(new Failure('HARD_CAP_45_MIN')), () => {});
  await assert.rejects(promise, /HARD_CAP_45_MIN/); assert.deepEqual(Buffer.concat(raw), bytes);
  const broken = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); }, pull(c) { c.error(new Failure('DISCONNECTED')); } });
  const received: Buffer[] = []; await assert.rejects(readStream(broken, new AbortController().signal, b => received.push(Buffer.from(b)), () => {}, () => {}), /DISCONNECTED/);
  assert.deepEqual(Buffer.concat(received), bytes);
});
test('terminal session observation never scores placeholders or process exit 0', () => {
  assert.equal(observedSession({ exitCode: 0 }).finished, false); assert.equal(observedSession({ status: 'idle', turns: [] }).finished, false);
  const state = observedSession({ status: 'idle', frozen: true, turns: [{ answer: { conclusion: 'not an answer', delivery: { status: 'unavailable', reason: 'budget_exhausted' } } }] });
  assert.equal(state.finished, true); assert.equal(state.frozen, true); assert.deepEqual(state.delivery, { status: 'unavailable', reason: 'budget_exhausted' });
  assert.equal(observedSession({ status: 'idle', turns: [{ answer: { conclusion: 'legacy' } }] }).delivery, null);
});
test('abortable pair barrier cannot leave a healthy arm waiting forever', async () => {
  const controller = new AbortController(); const waiting = abortable(new Promise<void>(() => {}), controller.signal);
  controller.abort(new Failure('PEER_STARTUP_FAILED')); await assert.rejects(waiting, /PEER_STARTUP_FAILED/);
});
test('pair gate preserves fixed dispatch order when readiness is reversed', async () => {
  const gate = pairGate(); const order: number[] = []; const signal = new AbortController().signal;
  const second = gate.wait(1, signal).then(() => { order.push(1); gate.sent(1); });
  const first = gate.wait(0, signal).then(() => { order.push(0); gate.sent(0); });
  await Promise.all([second, first]); assert.deepEqual(order, [0, 1]);
});
test('owned-child stop escalates only its own process and remains bounded', async () => {
  const child = new EventEmitter() as EventEmitter & ObjectData; Object.assign(child, { pid: 123, exitCode: null, signalCode: null }); const calls: string[] = [];
  let done!: () => void; const exited = new Promise<void>(resolve => { done = resolve; });
  child.kill = (signal: string) => { calls.push(signal); if (signal === 'SIGKILL') { child.signalCode = signal; done(); } return true; };
  const keepAlive = setInterval(() => {}, 1000);
  try { assert.equal(await stopOwned(child as unknown as ChildProcess, exited, 5), true); } finally { clearInterval(keepAlive); }
  assert.deepEqual(calls, ['SIGTERM', 'SIGKILL']); assert.equal(await stopOwned(child as unknown as ChildProcess, exited, 5), true); assert.equal(calls.length, 2);
});
test('audit reads only this run database without opening token rows or mutating contents', t => {
  const dir = fixture(t); fs.mkdirSync(path.join(dir, 'data')); const file = path.join(dir, 'data/xkang.db');
  const { DatabaseSync } = createRequire(path.join(root, 'package.json'))('node:sqlite'); const db = new DatabaseSync(file);
  db.exec('CREATE TABLE agent_sessions(id TEXT,private_json TEXT,public_json TEXT,run_state TEXT,frozen_answer TEXT); CREATE TABLE audit_logs(id INTEGER,error TEXT); CREATE TABLE sys_configs(key TEXT,value TEXT); CREATE TABLE auth_tokens(token TEXT);');
  db.prepare('INSERT INTO agent_sessions VALUES(?,?,?,?,?)').run('s_test', '[{"role":"user","content":"original"}]', '{"id":"s_test","status":"idle","turns":[]}', '{"frozen":true}', 'partial');
  db.exec("INSERT INTO audit_logs VALUES(1,'MODEL_TIMEOUT'); INSERT INTO sys_configs VALUES('active_model','deepseek'); INSERT INTO auth_tokens VALUES('never-export-token');"); db.close();
  const before = sha256(fs.readFileSync(file)); const result = auditRun(root, dir, 's_test');
  assert.equal(result.private.messages[0].content, 'original'); assert.equal(result.private.runState.frozen, true); assert.equal(result.activeModel, 'deepseek');
  assert.equal(result.audit.length, 1); assert.equal(JSON.stringify(result).includes('never-export-token'), false); assert.equal(sha256(fs.readFileSync(file)), before);
  assert.throws(() => auditRun(root, path.join(dir, 'missing-run'), 's_test'));
});
