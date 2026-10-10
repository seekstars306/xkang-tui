/** Paired, repeated evaluation through the project's real LLM proxy and MCP tools.
 * Run: node --import tsx scripts/eval/compare_models.mjs
 * Answers and references are never passed to the worker's model context.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadServerEnv } from '../../tests/helpers/isolated_server.ts';
import { loadUserLocalConfig } from '../../src/config/user_config.ts';
import { ModelGateway } from '../../src/adapters/gateway.ts';
import { AgentHarness } from '../../src/harness/agent.ts';
import { createDefaultToolRegistry } from '../../src/tools/index.ts';
import { McpRemoteClient } from '../../src/mcp/client.ts';
import { isReminderMessage, isFailedToolResult } from '../../src/harness/context.ts';
import { loadServerConfig } from '../../server/src/config.ts';
import { setupLlmProxy } from '../../server/src/llm.ts';
import { AppDatabase } from '../../server/src/db.ts';
import { ActiveModelManager } from '../../server/src/model_state.ts';
import { AuditLogger } from '../../server/src/auth.ts';

const FILE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(FILE), '../..');
const express = createRequire(path.join(ROOT, 'server/package.json'))('express');
const CASES = [
  { id: 'frontend_account_type', title: '前端页面及保存接口', input: '客服在【用户编辑】弹窗里把"账户类型"改成企业管理员，点保存后再打开又变回原来的值了，帮我找一下前端是哪个页面组件、保存时调用的是哪个接口' },
  { id: 'open_ticket_code', title: 'OPEN票改签收款状态', input: '这三笔单据为 OPEN 票人工改签建单，系统在生成改签订单时自动继承了原票的已支付状态，找出这块具体代码位置' },
  { id: 'sms_recipients_completeness', title: '短信接收人完整性', input: '看看三公司领导订票咱们颂康泰这边都谁能收到短信，从关联发送配置功能中查' },
  { id: 'taxi_double_payment', title: '打车重复付款核对', input: '打车订单号：1530517490084478976；这个打车客人付了两次款，银行流水有两次入账，但是系统只有一次到账' },
  { id: 'bill_screenshot', title: '账单已支付状态截图', sourceId: 's_muz2w1vn_uerpm' },
];
const MODELS = ['gemini', 'deepseek'];
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v) ?? 'undefined').digest('hex');
const write = (p, value) => fs.writeFileSync(p, JSON.stringify(value, null, 2));
const now = () => new Date().toISOString();

function inputFor(c) {
  if (c.input) return c.input;
  const db = new DatabaseSync(path.join(os.homedir(), '.xkang/sessions.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT messages_json FROM web_sessions WHERE id=?').get(c.sourceId);
    assert(row, 'Source session missing');
    return structuredClone(JSON.parse(row.messages_json).find(m => m.role === 'user' && !isReminderMessage(m)).content);
  } finally { db.close(); }
}

function repoHeads(root) {
  const results = [];
  function visit(dir, depth) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      try {
        results.push({ repo: path.relative(root, dir), head: execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), status: execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim() });
      } catch { results.push({ repo: path.relative(root, dir), error: 'git snapshot failed' }); }
    } else if (depth > 0) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') visit(path.join(dir, e.name), depth - 1);
    }
  }
  visit(root, 3);
  return results;
}

export async function worker(caseId, model, round, dir, customCase) {
  assert(MODELS.includes(model));
  const c = customCase || CASES.find(x => x.id === caseId);
  assert(c);
  const env = loadServerEnv();
  Object.assign(process.env, env);
  const config = loadServerConfig();
  assert(!config.mockLlm, 'Real models required');
  const local = loadUserLocalConfig();
  assert(local.token, 'Configured MCP token required');
  const input = inputFor(c);
  fs.mkdirSync(dir, { recursive: true });
  // No evaluation reports or project memory in the local model workspace.
  const workspace = path.join(dir, 'empty-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const db = new AppDatabase({ dataDir: path.join(dir, 'data') });
  const manager = new ActiveModelManager(db.db, model);
  assert.equal(manager.getActive(), model);
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  const internalToken = crypto.randomBytes(24).toString('hex');
  const requests = [];
  app.post('/v1/chat/completions', (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${internalToken}`) return res.sendStatus(401);
    const ms = req.body.messages || [];
    const item = { at: now(), n: requests.length + 1, systemHash: hash(ms.filter(m => m.role === 'system')), toolsHash: hash(req.body.tools), firstUserHash: hash(ms.find(m => m.role === 'user')?.content), roles: ms.map(m => m.role) };
    requests.push(item);
    fs.appendFileSync(path.join(dir, 'requests.jsonl'), JSON.stringify(item) + '\n');
    next();
  }, setupLlmProxy(config, new AuditLogger(db.db), manager));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const mcp = new McpRemoteClient({ serverUrl: local.serverUrl, token: local.token });
  let harness;
  let error;
  let answer = '';
  const tools = [];
  const pending = new Map();
  const usage = [];
  const interventions = [];
  const streamErrors = [];
  const startedAt = now();
  const start = Date.now();
  try {
    const registry = createDefaultToolRegistry();
    const sync = await registry.syncWithRemote(mcp);
    assert(sync.connected && sync.count > 0, 'MCP tools unavailable');
    // Keep normal schemas, but evaluation cannot access local answers or modify files.
    for (const name of ['run_powershell', 'write_file', 'edit_file']) {
      const t = registry.getTool(name);
      registry.registerLocal({ ...t, execute: async () => { throw new Error('评测为只读，请使用远程代码、数据库或日志工具查证；本地命令与文件写入不可用。'); } });
    }
    const gateway = new ModelGateway({ defaultModel: 'xkang-managed', serverUrl, token: internalToken, deepseekApiKey: '', deepseekBaseUrl: '', geminiApiKey: '', grokApiKey: '', grokBaseUrl: '', codeRepoPath: config.codeRepoPath });
    harness = new AgentHarness({ gateway, registry, context: { repoPath: config.codeRepoPath, localCwd: workspace, serverUrl: local.serverUrl, token: local.token } });
    assert.equal(harness.getMessages().length, 1);
    assert.equal(harness.getMessages()[0].role, 'system');
    write(path.join(dir, 'started.json'), { caseId, model, round, inputHash: hash(input), startedAt, toolNames: registry.getTools().map(t => t.name) });
    answer = await harness.run(input, e => {
      if (!['content_chunk', 'reasoning_chunk'].includes(e.type)) fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ at: now(), ...e }, (k, v) => k === 'resolve' ? undefined : v) + '\n');
      if (e.type === 'tool_call_start') {
        const t = { n: tools.length + 1, ...e.toolCall };
        tools.push(t); pending.set(t.id, t);
        console.log(JSON.stringify({ event: 'tool', caseId, model, round, n: t.n, name: t.name }));
      } else if (e.type === 'tool_call_result') {
        Object.assign(pending.get(e.toolCallId) || {}, { result: e.result, failed: !!e.isError || isFailedToolResult(e.result) });
      } else if (e.type === 'usage_sync') usage.push(e);
      else if (e.type === 'error') streamErrors.push(e.error);
      else if (e.type === 'question_requested') {
        interventions.push({ type: e.type, request: e.request });
        e.resolve('评测没有额外信息，请依据原始问题自行查询；无法确认的部分如实说明。');
      } else if (e.type === 'approval_requested') {
        interventions.push({ type: e.type, request: e.request }); e.resolve(false);
      }
    });
    assert.equal(hash(harness.getMessages().find(m => m.role === 'user' && !isReminderMessage(m)).content), hash(input));
  } catch (e) { error = e instanceof Error ? e.message : String(e); }
  finally {
    await mcp.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  const messages = harness?.getMessages() || [];
  const audits = db.db.prepare('SELECT model,prompt_tokens,completion_tokens,total_tokens,duration_ms,success,error FROM audit_logs WHERE type=? ORDER BY id').all('llm_chat');
  const result = { caseId, title: c.title, model, providerModel: model === 'gemini' ? config.geminiModel : config.deepseekModel, round: Number(round), startedAt, finishedAt: now(), durationMs: Date.now() - start, inputHash: hash(input), firstRequest: requests[0], modelCalls: requests.length, tools: tools.length, failedTools: tools.filter(t => t.failed).length, usage: { promptTokens: usage.reduce((s, u) => s + u.promptTokens, 0), completionTokens: usage.reduce((s, u) => s + u.completionTokens, 0) }, interventions, reminders: messages.filter(isReminderMessage).map(m => m.content), audits, streamErrors, error: error || (answer.startsWith('[错误]') ? streamErrors.at(-1) || answer : null), answer };
  write(path.join(dir, 'result.json'), result);
  write(path.join(dir, 'tools.json'), tools);
  write(path.join(dir, 'messages.json'), messages.map(m => ({ ...m, content: Array.isArray(m.content) ? m.content.map(p => p.type === 'image_url' ? { type: p.type, imageHash: hash(p) } : p) : m.content })));
  fs.writeFileSync(path.join(dir, 'answer.md'), answer);
  db.db.close();
  console.log(JSON.stringify({ event: 'finished', caseId, model, round, seconds: Math.round(result.durationMs / 1000), calls: result.modelCalls, tools: result.tools, error }));
}

async function main() {
  const env = loadServerEnv();
  const dir = path.join(ROOT, 'tests/eval/reports', `comparison-${now().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { startedAt: now(), rounds: 2, models: { gemini: env.GEMINI_MODEL, deepseek: env.DEEPSEEK_MODEL }, cases: CASES.map(c => ({ id: c.id, title: c.title, inputHash: hash(inputFor(c)) })), productionModelUntouched: true, limits: { runMinutes: 18, harnessTurns: 50 }, repoBefore: repoHeads(env.CODE_REPO_PATH) };
  write(path.join(dir, 'manifest.json'), manifest);
  console.log(JSON.stringify({ event: 'comparison_started', dir, models: manifest.models, runs: 20 }));
  function launch(c, model, round) {
    return new Promise(resolve => {
      const runDir = path.join(dir, `${c.id}-${model}-${round}`);
      fs.mkdirSync(runDir, { recursive: true });
      const log = fs.openSync(path.join(runDir, 'worker.log'), 'a');
      const child = spawn(process.execPath, ['--import', 'tsx', FILE, '--worker', c.id, model, String(round), runDir], { cwd: ROOT, stdio: ['ignore', log, log], windowsHide: true });
      console.log(JSON.stringify({ event: 'run_started', caseId: c.id, model, round, pid: child.pid }));
      const timer = setTimeout(() => { write(path.join(runDir, 'timeout.json'), { at: now(), minutes: 18 }); child.kill(); }, 18 * 60 * 1000);
      child.once('error', e => { clearTimeout(timer); fs.closeSync(log); resolve({ caseId: c.id, model, round, error: e.message }); });
      child.once('exit', code => {
        clearTimeout(timer); fs.closeSync(log);
        const p = path.join(runDir, 'result.json');
        const result = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { caseId: c.id, model, round, error: `Worker exited ${code} without result` };
        console.log(JSON.stringify({ event: 'run_finished', caseId: c.id, model, round, seconds: result.durationMs && Math.round(result.durationMs / 1000), calls: result.modelCalls, tools: result.tools, error: result.error }));
        resolve(result);
      });
    });
  }
  const results = [];
  for (let round = 1; round <= 2; round++) {
    for (const c of CASES) {
      const settled = await Promise.allSettled((round === 1 ? MODELS : [...MODELS].reverse()).map(m => launch(c, m, round)));
      for (const r of settled) { assert.equal(r.status, 'fulfilled'); results.push(r.value); }
      write(path.join(dir, 'results.json'), results);
    }
  }
  manifest.finishedAt = now();
  manifest.repoAfter = repoHeads(env.CODE_REPO_PATH);
  manifest.repositoriesUnchanged = hash(manifest.repoBefore) === hash(manifest.repoAfter);
  write(path.join(dir, 'manifest.json'), manifest);
  console.log(JSON.stringify({ event: 'comparison_finished', dir, completed: results.length, repositoriesUnchanged: manifest.repositoriesUnchanged }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === FILE) {
  if (process.argv[2] === '--worker') await worker(...process.argv.slice(3));
  else await main();
}
