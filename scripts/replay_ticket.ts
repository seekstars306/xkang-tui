import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startIsolatedServer } from '../tests/helpers/isolated_server.ts';
import { BusinessClient } from '../src/adapters/business_client.ts';
import { parseSlot, slotOptions, effectiveSwitch, effectiveEnv } from './eval/model_env.ts';

/**
 * 原样重放工单 a12c3554：把当时那条用户消息（正文 + 原截图）当新工单再跑一次。
 * 与以前的版本不同，这次把完整私有轨迹（工具调用、读取范围、草稿、复核记录）一起存下来——
 * 隔离服务停止时会删掉临时库，不存就无法事后判断"没查到、没读懂还是发布时被拦"。
 *
 * 用法：node --import tsx scripts/replay_ticket.ts <标签> [--dry]
 */
const label = (process.argv[2] || 'run').replace(/[^\w-]/g, '_');
// 可选：模型槽与端口（并行跑多组时错开端口）。gemini 不接受 json_schema，按它在线上时的配置用 json_object。
const modelSlot = parseSlot(process.argv[3]);
const slot = slotOptions(modelSlot);
const port = Number(process.argv[4]) || 8694;
// 可选第 5 个参数：换一个工单来源。缺省是 a12c3554（本地库里的原会话）；
// 传 payables 时用 tests/eval/reports/_retest/retest-private.json（"应付一览导出出现两条记录"，
// 与 10-16 发票案同属"重复记录 → 容易编造人为重复提交"的一类，用作放宽复核口径时的反向回归）。
// 也可传 session:<会话编号>：回放本地库里任一线上会话的第一条用户消息（与线上输入完全相同）
const sessionArg = process.argv[5]?.startsWith('session:') ? process.argv[5].slice(8) : null;
const caseName = process.argv[5] === 'payables' ? 'payables' : sessionArg ? 'sess-' + sessionArg.slice(2, 10) : 'a12c3554';
let sourceMessages: any[];
if (caseName === 'payables') {
  sourceMessages = JSON.parse(fs.readFileSync('tests/eval/reports/_retest/retest-private.json', 'utf8')).messages;
} else {
  const db = new DatabaseSync('data/xkang.db', { readOnly: true });
  const sourceRow = db.prepare('SELECT private_json FROM agent_sessions WHERE id = ?').get(sessionArg || 's_c6f265a076ea482195a36e9ca07565a4') as { private_json: string } | undefined;
  db.close();
  if (!sourceRow) throw new Error('原会话不存在');
  sourceMessages = JSON.parse(sourceRow.private_json);
}
const first = sourceMessages.find(m => m.role === 'user' && !m.internal && !m.isReminder);
if (!first) throw new Error('原会话没有用户消息');
const content = first.content;
console.log('input parts:', Array.isArray(content) ? content.map((p: any) => p.type).join(',') : typeof content);
if (process.argv.includes('--dry')) process.exit(0);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join('eval_run', 'replay-' + caseName + '-' + label + '-' + stamp);
fs.mkdirSync(outDir, { recursive: true });

const server = await startIsolatedServer(port, slot.model, { env: slot.env });
const started = Date.now();
const events: unknown[] = [];
let streamError: string | null = null;
try {
  const client = new BusinessClient(server.url, server.token);
  const session = await client.create();
  try { await client.chat(session.id, content, (e: unknown) => events.push(e)); }
  catch (e: any) { streamError = String(e?.message ?? e).slice(0, 500); }
  const publicSession: any = await client.get(session.id);
  const privateTrace: any = await (await fetch(server.url + '/admin/agent/sessions/' + session.id, { headers: { Authorization: 'Bearer ' + server.adminToken } })).json();
  const audit = server.readAudit();
  fs.writeFileSync(path.join(outDir, 'public.json'), JSON.stringify({ events, final: publicSession }, null, 2));
  fs.writeFileSync(path.join(outDir, 'private.json'), JSON.stringify(privateTrace, null, 2));
  fs.writeFileSync(path.join(outDir, 'audit.json'), JSON.stringify(audit, null, 2));

  const messages: any[] = Array.isArray(privateTrace) ? privateTrace : (privateTrace?.messages ?? privateTrace?.private?.messages ?? []);
  const answer = publicSession?.turns?.at(-1)?.answer ?? {};
  const answerText = [answer.conclusion, ...(answer.businessData || []).map((d: any) => d.label + '：' + d.value), ...(answer.evidenceSummary || []), answer.customerReply, ...(answer.pendingItems || []), ...(answer.claims || []).map((c: any) => c.text)].filter(Boolean).join('\n');
  const calls: any[] = [];
  for (const m of messages) for (const c of m.tool_calls || []) {
    let a: any = c.arguments; try { if (typeof a === 'string') a = JSON.parse(a); } catch { a = {}; }
    calls.push({ name: c.name, filePath: a?.filePath, startLine: a?.startLine, endLine: a?.endLine, keyword: a?.keyword, action: a?.action, tableName: a?.tableName, sql: typeof a?.sql === 'string' ? a.sql.slice(0, 200) : undefined });
  }
  const toolTexts = messages.filter(m => m.role === 'tool').map(m => String(m.raw_tool_result ?? (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))));
  const reviews = messages.filter(m => m.review).map(m => ({ attempt: m.review.attempt, status: m.review.status, validUnitCount: m.review.validUnitCount, diagnostic: m.review.diagnostic, issues: (m.review.issues || []).slice(0, 8) }));
  const summary = {
    label, caseName, modelSlot, observedBranch: effectiveSwitch(slot.env),
    reviewMode: effectiveEnv('REVIEW_MODE', 'gate', slot.env),
    // 编造成因的粗筛：只用来提醒人工复看，不作判分
    causeWordsInConclusion: (String(answer.conclusion || '').match(/连续提交|重复提交|连击|并发|人为|操作失误|误操作|两次提交/g) || []),
    seconds: Math.round((Date.now() - started) / 1000), streamError, sessionId: session.id,
    reviewStatus: answer.reviewStatus, conclusion: answer.conclusion, pendingItems: answer.pendingItems,
    names1330: /13[:：]30|一点半|1点半/.test(answerText),
    namesHuazhu: /华住/.test(answerText),
    says18AsCause: /18\s*点|18[:：]00|下午6点|晚上6点/.test(String(answer.conclusion || '')),
    toolCallCount: calls.length,
    reads: calls.filter(c => c.name === 'read_file_lines').map(c => c.filePath + ':' + (c.startLine ?? '') + '-' + (c.endLine ?? '')),
    describeTables: calls.filter(c => c.name === 'company_db_query' && c.action === 'describe_table').map(c => c.tableName),
    attachmentEvidence: messages.filter(m => m.role === 'tool' && m.name === 'read_attachment').length,
    columnNotesSeen: toolTexts.some(t => t.includes('columnNotes')),
    reviews,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('=== RESULT ===');
  console.log(JSON.stringify({ outDir, ...summary, reviews: summary.reviews.map(r => ({ attempt: r.attempt, status: r.status, valid: r.validUnitCount })) }, null, 1));
} finally { await server.stop(); }
