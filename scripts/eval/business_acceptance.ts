import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AgentCore, type Message, type StreamEvent } from '@xkang/agent-core';
import { startIsolatedServer, loadServerEnv } from '../../tests/helpers/isolated_server.ts';
import { McpRemoteClient } from '../../src/mcp/client.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { BusinessModel } from '../../server/src/agent/model.ts';
import { AuditLogger } from '../../server/src/auth.ts';
import { reviewAnswer } from '../../server/src/agent/review.ts';
import { BUSINESS_PROMPT } from '../../server/src/agent/service.ts';
import { buildSystemPrompt } from '../../server/src/agent/investigation_prompt.ts';
import { getCompanyServerSkills } from '../../server/src/skills.ts';

for (const [key, value] of Object.entries(loadServerEnv())) process.env[key] = value;
const { loadServerConfig } = await import('../../server/src/config.ts');
const root = process.cwd(), config = loadServerConfig();
const cases = JSON.parse(fs.readFileSync('tests/eval/business_acceptance_cases.json', 'utf8')) as Array<{ id: string; category: string; question: string }>;
const baselinePath = path.resolve('tests/eval/reports/server-harness-20261009/baseline/src/harness/agent.ts');
const LegacyAgent = (await import(pathToFileURL(baselinePath).href)).AgentHarness;
const LegacyProtocolError = (await import(pathToFileURL(path.resolve(path.dirname(baselinePath), '../adapters/tool_call_error.ts')).href)).ToolCallProtocolError;
const out = path.resolve(process.argv[2] || `tests/eval/reports/server-harness-20261009/acceptance-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourceHashes: Record<string, string> = {};
function freeze(directory: string) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) freeze(file); else sourceHashes[file.replaceAll('\\', '/')] = hash(fs.readFileSync(file)); } }
for (const dir of ['src', 'server/src', 'packages/agent-core/src', 'web']) freeze(dir);
const evaluationFiles = Object.keys(sourceHashes).filter(file => /^(?:packages\/agent-core\/src\/|server\/src\/tools\/|server\/src\/agent\/(?:model|review|publication|investigation_prompt)\.ts$|server\/src\/(?:llm|model_state|system_prompt|skills|mcp)\.ts$|src\/(?:mcp\/client|tools\/registry)\.ts$)/.test(file));
const businessPromptSourceHash = hash(fs.readFileSync('server/src/agent/service.ts', 'utf8').match(/export const BUSINESS_PROMPT = `[\s\S]*?`;/)![0]);
const concurrency = 4;
const manifest = { createdAt: new Date().toISOString(), cases, rounds: 3, model: config.geminiModel, sourceHashes, evaluationFiles, businessPromptSourceHash, baselinePath, baselineHash: hash(fs.readFileSync(baselinePath)), concurrency, controls: '同模型与只读工具，空白会话，无参考答案；实时业务库不具有事务快照；每次最多18分钟。业务评测冻结执行核心、提示词和工具；接口、迁移及客户端另以最终验证哈希绑定。' };
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ registered: 20, expectedRuns: 120, output: out }));
const server = await startIsolatedServer(8693, 'gemini');
const tasks = cases.flatMap(c => [1, 2, 3].flatMap(round => ['baseline', 'candidate'].map(variant => ({ ...c, round, variant }))));
const results: any[] = [];
let cursor = 0;
async function run(job: typeof tasks[number]) {
  const directory = path.join(out, `${job.variant}-${job.id}-${job.round}`); fs.mkdirSync(directory, { recursive: true });
  const client = new McpRemoteClient({ serverUrl: server.url, token: server.adminToken });
  const started = Date.now(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 18 * 60 * 1000);
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,timestamp,user,type,tool_name,model,prompt_tokens,completion_tokens,total_tokens,duration_ms,details,success,error)');
  let core: any, answer = '', error: string | null = null, calls = 0, toolCalls = 0, reviewCalls = 0;
  try {
    if (!(await client.connect())) throw new Error('Isolated MCP unavailable');
    const registry = new ToolRegistry();
    const allowed = new Set(['lookup_order', 'company_db_query', 'search_code', 'read_file_lines', 'git_inspect', 'codegraph_explore', 'search_logs', 'list_log_apps']);
    for (const tool of await client.listTools()) if (allowed.has(tool.name)) registry.registerRemote(tool);
    registry.setRemoteSkills(getCompanyServerSkills());
    registry.registerLocal({ name: 'ask_user_question', description: '仅询问无法查到的必要业务信息', parameters: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } } } }, execute: async () => '' });
    const model = new BusinessModel(config, 'gemini', new AuditLogger(db), 'acceptance', controller.signal, job.variant === 'candidate');
    const gateway: any = { getCurrentModel: () => 'xkang-managed', switchModel() {}, streamChat: async (messages: Message[], tools: any[], emit: (e: StreamEvent) => void, options?: any) => {
      calls++; if (options?.signal) reviewCalls++;
      try { return await model.streamChat(messages, tools, emit, options); }
      catch (e) { if (job.variant === 'baseline' && e instanceof Error && e.name === 'ToolCallProtocolError') throw new LegacyProtocolError(e.message); throw e; }
    } };
    const event = (e: StreamEvent) => { if (e.type === 'tool_call_start') toolCalls++; if (e.type === 'question_requested') e.resolve('本题未提供额外信息，请核对已有资料并如实说明无法确认的部分。'); };
    const context = { repoPath: config.codeRepoPath || '', localCwd: '' };
    core = job.variant === 'baseline' ? new LegacyAgent({ gateway, registry, context }) : new AgentCore({ gateway, registry, context,
      buildPrompt: tools => buildSystemPrompt(tools, getCompanyServerSkills(), 'l2') + '\n\n' + BUSINESS_PROMPT,
      repairTools: new Set([...allowed, 'read_tool_result']),
      review: (candidate, history, attempt) => reviewAnswer(gateway, candidate, history, attempt, `eval_${job.id}_${job.round}`, event) });
    answer = await core.run(job.question, event);
  } catch (e) { error = e instanceof Error ? e.message : String(e); }
  finally {
    clearTimeout(timer);
    fs.writeFileSync(path.join(directory, 'messages.json'), JSON.stringify(core?.getMessages() || [], null, 2));
    fs.writeFileSync(path.join(directory, 'answer.txt'), answer);
    fs.writeFileSync(path.join(directory, 'audit.json'), JSON.stringify(db.prepare('SELECT * FROM audit_logs').all(), null, 2));
    db.close(); await client.close();
  }
  let reviewStatus: string | null = null; try { reviewStatus = JSON.parse(answer).reviewStatus || null; } catch { /* legacy plain text */ }
  const result = { variant: job.variant, caseId: job.id, round: job.round, inputHash: hash(job.question), seconds: Math.round((Date.now() - started) / 1000), modelCalls: calls, reviewCalls, toolCalls, error, reviewStatus, completed: Boolean(answer) && !error && !controller.signal.aborted };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  results.push(result); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ finished: results.length, ...result }));
}
try { await Promise.all(Array.from({ length: concurrency }, async () => { while (cursor < tasks.length) { const task = tasks[cursor++]; await run(task); } })); }
finally { await server.stop(); }
fs.writeFileSync(path.join(out, 'grades.json'), JSON.stringify(results.map(r => ({ ...r, grade: null, usable: null, severeMisleading: null, evidenceChecked: false, rationale: '' })), null, 2));
console.log('所有运行已保存，必须逐次核验证据后填写评分；运行完成不等于达到发布门槛。');
