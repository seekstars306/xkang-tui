import { readSession } from './dsh_session_read.mjs';
const { events } = readSession(process.argv[2]);
const h = events.find(e => e.type === 'request/header')?.data?.header;
console.log('tools', h.tools.length, h.tools.map(t => t.name).join(','));