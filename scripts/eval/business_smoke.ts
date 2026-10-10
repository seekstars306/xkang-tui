import fs from 'node:fs';
import path from 'node:path';
import { startIsolatedServer } from '../../tests/helpers/isolated_server.ts';
import { BusinessClient } from '../../src/adapters/business_client.ts';

const output = path.resolve(process.argv[3] || 'tests/eval/reports/server-harness-20261009');
fs.mkdirSync(output, { recursive: true });
const server = await startIsolatedServer(8691, 'gemini');
const client = new BusinessClient(server.url, server.token);
const started = Date.now();
try {
  const session = await client.create();
  const events: unknown[] = [];
  await client.chat(session.id, process.argv[2] || '订单1541491413412347905出单异常，说明已有业务记录支持的情况和仍需要核实的事项。', event => {
    events.push(event);
    if (event.type === 'progress') process.stdout.write(`${event.phase}\n`);
    if (event.type === 'question') process.stdout.write('waiting_question\n');
  });
  const final = await client.get(session.id);
  const privateTrace = await (await fetch(`${server.url}/admin/agent/sessions/${session.id}`, { headers: { Authorization: `Bearer ${server.adminToken}` } })).json();
  fs.writeFileSync(path.join(output, 'smoke-private.json'), JSON.stringify(privateTrace, null, 2));
  fs.writeFileSync(path.join(output, 'smoke-audit.json'), JSON.stringify(server.readAudit(), null, 2));
  fs.writeFileSync(path.join(output, 'smoke-public.json'), JSON.stringify({ events, final }, null, 2));
  console.log(JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), status: final.turns.at(-1)?.answer?.reviewStatus, sessionId: session.id }));
} finally { await server.stop(); }
