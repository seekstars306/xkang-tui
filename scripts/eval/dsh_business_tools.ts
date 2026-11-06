import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { McpRemoteClient } from '../../src/mcp/client.ts';
const root = path.resolve(import.meta.dirname, '../..');
const env = dotenv.parse(fs.readFileSync(path.join(root, 'server/.env')));
const token = env.XKANG_ADMIN_TOKENS?.split(',').map(pair => pair.trim().split(':')[0]).find(Boolean);
if (!token) throw new Error('Missing service credential');
const logPath = path.join(root, 'eval_run/dsh-hotel-20261027/business-tools.jsonl');
const allowed = new Set(['lookup_order', 'company_db_query', 'search_logs', 'list_log_apps', 'lookup_service', 'list_services', 'search_code', 'read_file_lines', 'codegraph_explore', 'git_inspect']);
const client = new McpRemoteClient({ serverUrl: 'http://127.0.0.1:8600', token, timeoutMs: 15000 });
const startedAt = new Date().toISOString();
try {
  if (!await client.connect()) throw new Error('Read-only business MCP unavailable');
  const action = process.argv[2];
  if (action === 'list') {
    const defs = await client.listTools();
    console.log(JSON.stringify(defs.filter(t => allowed.has(t.name)).map(t => ({ name: t.name, description: t.description, parameters: t.parameters })), null, 2));
  } else if (action === 'call') {
    const name = process.argv[3];
    if (!allowed.has(name)) throw new Error('Tool is outside read-only experiment allowlist');
    const encoded = process.argv[4];
    const args = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const result = await client.callTool(name, args);
    fs.appendFileSync(logPath, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), name, args, result }) + String.fromCharCode(10));
    console.log(typeof result === 'string' ? result : JSON.stringify(result));
  } else throw new Error('Usage: list | call tool base64Json');
} catch (error) {
  fs.appendFileSync(logPath, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), failure: true, error: error instanceof Error ? error.message : String(error) }) + String.fromCharCode(10));
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.close();
}
