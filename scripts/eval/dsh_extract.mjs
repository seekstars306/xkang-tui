// 提取 DSH 桌面版对照会话：工单、用时、最终答案、工具调用、人工追加消息、越界访问/写操作审计
import fs from 'node:fs';
import path from 'node:path';
import { readSession } from './dsh_session_read.mjs';
const dir = 'C:/Users/skt/.dsh/sessions/--D-skt_project--';
const since = Date.parse(process.argv[2] || '2026-10-30T02:20:00Z');
const OUTDIR = process.argv[3] || 'D:/xk_cmp/dsh-desktop';
const keys = { a12c3554: /1564286324519862273|部分退房/, T001: /护照|图片识别/, T003: /1562429196830113792|自动改签/, T004: /程丽娜|JFTHRJ/, T006: /红冲|蓝票|已开具/ };
const textOf = c => (Array.isArray(c) ? c : [c]).map(p => typeof p === 'string' ? p : (p?.type === 'text' ? p.text : '')).join('');
const out = [];
for (const d of fs.readdirSync(dir)) {
  const f = path.join(dir, d, 'session.v4.jsonl.zstd');
  if (!fs.existsSync(f)) continue;
  const { events } = readSession(f);
  const userMsgs = events.filter(e => e.type === 'user/message' && e.data?.source?.kind !== 'user-approval' && e.data?.role === 'user' && e.time >= since);
  const realUser = userMsgs.filter(e => !/^<system-reminder>|approval policy/i.test(textOf(e.data.content)));
  if (!realUser.length) continue;
  const firstText = textOf(realUser[0].data.content);
  const ticket = Object.entries(keys).find(([, re]) => re.test(firstText))?.[0] || '?';
  const header = events.find(e => e.type === 'request/header')?.data?.header?.config;
  const turnStarts = events.filter(e => e.type === 'turn/start' && e.time >= since);
  const turnEnds = events.filter(e => e.type === 'turn/end' && e.time >= since);
  const assistants = events.filter(e => e.type === 'assistant/message' && e.time >= since);
  const finalMsg = [...assistants].reverse().find(e => { const m = e.data?.message ?? e.data; const parts = m?.content ?? []; return textOf(parts).trim().length > 200; });
  const finalText = finalMsg ? textOf((finalMsg.data?.message ?? finalMsg.data).content) : '';
  const calls = events.filter(e => e.type === 'tool/call' && e.time >= since).map(e => e.data);
  const callStr = calls.map(c => JSON.stringify(c));
  const forbidden = callStr.filter(s => /xkang-tui(?!\\\\scripts\\\\eval\\\\xkang_mcp)|xk_cmp/i.test(s) && !/xk_cmp[\\/]+inputs/i.test(s));
  const writes = calls.filter(c => /^(edit|write)$/.test(c?.name || c?.tool || ''));
  const header2 = events.find(e => e.type === 'request/header' && e.time >= since)?.data?.header;
  const offeredXkang = (header2?.tools || []).filter(t => /lookup_order|company_db_query|search_logs/.test(t.name)).map(t => t.name);
  const lastEvent = events.at(-1);
  const toolNames = {}; for (const c of calls) { const n = c?.name || c?.tool || '?'; toolNames[n] = (toolNames[n] || 0) + 1; }
  out.push({ session: d, ticket, offeredXkang, lastEventType: lastEvent?.type, lastEventAt: lastEvent?.time ? new Date(lastEvent.time).toISOString() : null, model: header, start: new Date(realUser[0].time).toISOString(), end: turnEnds.length ? new Date(turnEnds.at(-1).time).toISOString() : null, seconds: turnEnds.length ? Math.round((turnEnds.at(-1).time - realUser[0].time) / 1000) : null, turns: turnStarts.length, userMessages: realUser.map(e => textOf(e.data.content).slice(0, 40)), toolCalls: calls.length, toolNames, forbiddenAccess: forbidden.map(s => s.slice(0, 200)), writeCalls: writes.length, finalChars: finalText.length });
  fs.mkdirSync(OUTDIR + '/' + ticket, { recursive: true });
  fs.writeFileSync(OUTDIR + '/' + ticket + '/answer.md', finalText + '\n');
}
fs.writeFileSync(OUTDIR + '/summary.json', JSON.stringify(out, null, 1));
for (const o of out) console.log(JSON.stringify({ ...o, toolNames: undefined }));
for (const o of out) console.log(o.ticket, JSON.stringify(o.toolNames));