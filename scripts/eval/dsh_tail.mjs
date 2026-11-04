import { readSession } from './dsh_session_read.mjs';
const { events } = readSession(process.argv[2]);
const textOf = c => (Array.isArray(c) ? c : [c]).map(p => typeof p === 'string' ? p : (p?.type === 'text' ? p.text : '')).join('');
const as = events.filter(e => e.type === 'assistant/message');
for (const e of as.slice(-4)) { const m = e.data?.message ?? e.data; console.log(new Date(e.time).toISOString(), 'calls=' + (m?.content || []).filter(p => p.type === 'toolCall' || p.type === 'tool_call').length, JSON.stringify(textOf(m?.content || '')).slice(0, 500)); }
const end = events.filter(e => e.type === 'turn/end').at(-1); console.log('turn/end', JSON.stringify(end?.data).slice(0, 400));
const st = events.filter(e => e.type === 'step/end').at(-1); console.log('last step/end', JSON.stringify(st?.data).slice(0, 400));