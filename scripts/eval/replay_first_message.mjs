/** Replay only the first user message through a fresh Web UI session. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const [sourceId, label = 'blind-replay'] = process.argv.slice(2);
assert(sourceId, 'Usage: node scripts/eval/replay_first_message.mjs <session-id> [label]');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const web = 'http://127.0.0.1:8611';
const db = new DatabaseSync(path.join(os.homedir(), '.xkang', 'sessions.db'), { readOnly: true });
const row = db.prepare('SELECT messages_json FROM web_sessions WHERE id = ?').get(sourceId);
db.close();
assert(row, 'Source session not found');
const original = JSON.parse(row.messages_json).find((m) => m.role === 'user' && !m.isReminder);
assert(original, 'Source user message not found');
const input = structuredClone(original.content);
const inputHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

async function jsonRequest(route, body) {
  const res = await fetch(`${web}${route}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert(res.ok, `${route}: HTTP ${res.status}`);
  return res.json();
}

const bootstrap = await jsonRequest('/api/bootstrap');
assert(bootstrap.mcpConnected, 'Web client MCP must be connected before replay');
const created = await jsonRequest('/api/session', { title: `${label} · 原始问题盲测` });
const id = created.sessionId;
assert(id && id !== sourceId);
const empty = await jsonRequest(`/api/session/${id}`);
assert.equal(empty.messages.length, 0, 'Replay session must have no conversation history');
const dir = path.join(root, 'tests/eval/reports', id);
fs.mkdirSync(dir, { recursive: true });
const startedAt = new Date().toISOString();
const metadata = { sourceId, sessionId: id, label, startedAt, inputHash,
  sourceUserMessagesCopied: 1, sourceAssistantMessagesCopied: 0, sourceToolMessagesCopied: 0,
  projectMemoryInjected: false, url: `${web}/#${id}` };
fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
console.log(JSON.stringify({ event: 'started', ...metadata }));
const pending = new Map();
let toolCount = 0;
let modelCalls = 0;
let interventions = 0;
let buffer = '';
const response = await fetch(`${web}/api/session/${id}/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(Array.isArray(input) ? { parts: input } : { message: input }),
});
assert(response.ok, `Replay: HTTP ${response.status}`);

async function event(e) {
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');
  if (e.type === 'tool_call_start') {
    toolCount++;
    pending.set(e.toolCall.id, e.toolCall.name);
    console.log(JSON.stringify({ event: e.type, n: toolCount, name: e.toolCall.name, args: e.toolCall.arguments }));
  } else if (e.type === 'tool_call_result') {
    console.log(JSON.stringify({ event: e.type, name: pending.get(e.toolCallId), error: e.isError, chars: String(e.result).length }));
  } else if (e.type === 'usage_sync') {
    modelCalls++;
    console.log(JSON.stringify({ event: e.type, n: modelCalls, promptTokens: e.promptTokens }));
  } else if (e.type === 'question_requested') {
    interventions++;
    console.log(JSON.stringify({ event: e.type, request: e.request }));
    await jsonRequest(`/api/session/${id}/answer`, { requestId: e.request.id,
      answer: '（回放测试无额外信息：请依据原始问题和截图自行查询；无法确认的部分如实说明。）' });
  } else if (e.type === 'approval_requested') {
    interventions++;
    await jsonRequest(`/api/session/${id}/approve`, { requestId: e.request.id, approved: false });
  } else if (e.type === 'error' || e.type === 'done' || e.type === 'stream_end') {
    console.log(JSON.stringify(e));
  }
}

const decoder = new TextDecoder();
for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let end;
  while ((end = buffer.indexOf('\n\n')) !== -1) {
    const block = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    const data = block.split('\n').filter((s) => s.startsWith('data: ')).map((s) => s.slice(6)).join('\n');
    if (data) await event(JSON.parse(data));
  }
}
const session = await jsonRequest(`/api/session/${id}`);
const first = session.messages.find((m) => m.role === 'user');
assert.equal(crypto.createHash('sha256').update(JSON.stringify(first.content)).digest('hex'), inputHash,
  'Original text and image must be preserved');
const final = session.messages.filter((m) => m.role === 'assistant' && !m.tool_calls?.length).at(-1);
const answer = typeof final?.content === 'string' ? final.content : '';
const finished = { ...metadata, finishedAt: new Date().toISOString(), toolCount, modelCalls,
  interventions, busy: session.busy, inputIntegrityVerified: true };
fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(finished, null, 2));
fs.writeFileSync(path.join(dir, 'answer.md'), answer);
fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(session, (k, v) =>
  k === 'url' && typeof v === 'string' && v.startsWith('data:image/') ? '[original image retained in session database]' : v, 2));
console.log(JSON.stringify({ event: 'finished', ...finished, answerFile: path.join(dir, 'answer.md') }));
