// stdio MCP 桥：把 xkang 线上服务（/mcp/sse）的工具原样转成 stdio MCP 服务。
// 跨框架对照时 DSH 桌面版、zcode 桌面版都接这同一个桥，拿到完全相同的工具名、说明和参数。
// 用法：node scripts/eval/xkang_mcp_stdio.mjs   （环境变量 XKANG_MCP_URL、XKANG_MCP_TOKEN；缺省读 server/.env 的管理员令牌）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let token = process.env.XKANG_MCP_TOKEN;
if (!token) {
  const env = fs.readFileSync(path.join(root, 'server/.env'), 'utf8');
  const line = env.split(/\r?\n/).find(l => l.startsWith('XKANG_ADMIN_TOKENS='));
  token = line?.slice('XKANG_ADMIN_TOKENS='.length).split(',').map(p => p.trim().split(':')[0]).find(Boolean);
}
const url = new URL(process.env.XKANG_MCP_URL || 'http://127.0.0.1:8600/mcp/sse');
const auth = { Authorization: 'Bearer ' + token };
const remote = new Client({ name: 'xkang-stdio-bridge', version: '1.0.0' });
await remote.connect(new SSEClientTransport(url, { requestInit: { headers: auth }, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers || {}), ...auth } }) } }));
const { tools } = await remote.listTools();
const server = new Server({ name: 'xkang', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async req => remote.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }, undefined, { timeout: 600000 }));
await server.connect(new StdioServerTransport());
process.stderr.write('[xkang-stdio-bridge] ' + tools.length + ' tools from ' + url.href + '\n');
