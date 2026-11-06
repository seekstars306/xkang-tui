import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 'check', version: '1' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ['scripts/eval/xkang_mcp_stdio.mjs'] }));
const { tools } = await c.listTools();
console.log('tools', tools.length, tools.map(t => t.name).join(','));
const r = await c.callTool({ name: 'lookup_order', arguments: { orderNo: '1564286324519862273' } });
console.log('lookup_order ok:', !r.isError, JSON.stringify(r.content).slice(0, 160));
await c.close();