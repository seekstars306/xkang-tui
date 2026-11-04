import fs from 'node:fs';
const dir = 'C:/Users/skt/.zcode/cli/rollout/';
for (const f of fs.readdirSync(dir)) {
  const p = dir + f; if (fs.statSync(p).mtimeMs < Date.parse('2026-10-30T01:55:00Z')) continue;
  const objs = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(o => o?.type === 'model_io');
  const firstMsgs = JSON.stringify(objs[0]?.request?.messages || '');
  const ticket = /1564286324519862273/.test(firstMsgs) ? 'a12c3554' : /护照/.test(firstMsgs) ? 'T001' : /1562429196830113792/.test(firstMsgs) ? 'T003' : /程丽娜/.test(firstMsgs) ? 'T004' : /红冲/.test(firstMsgs) ? 'T006' : '?';
  const calls = objs.flatMap(o => o.response?.toolCalls || []).map(c => ({ name: c.toolName || c.name, args: typeof (c.input ?? c.args) === 'string' ? (c.input ?? c.args) : JSON.stringify(c.input ?? c.args ?? {}) }));
  const names = {}; for (const c of calls) names[c.name] = (names[c.name] || 0) + 1;
  const forb = calls.filter(c => /xkang-tui|xk_cmp/i.test(c.args) && !/xk_cmp[\\/]+inputs/i.test(c.args));
  const writes = calls.filter(c => /^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(c.name || ''));
  const efforts = [...new Set(objs.map(o => o.request?.body?.reasoning_effort))];
  console.log(f.slice(17, 25), ticket, objs[0]?.startedAt?.slice(11, 19), '->', objs.at(-1)?.completedAt?.slice(11, 19), 'requests', objs.length, 'effort', efforts.join('/'), 'calls', calls.length, JSON.stringify(names), 'forbidden', forb.length, JSON.stringify(forb.slice(0, 3).map(c => c.name + ' ' + c.args.slice(0, 150))), 'writes', writes.length, JSON.stringify(writes.slice(0, 4).map(c => c.args.slice(0, 100))));
}