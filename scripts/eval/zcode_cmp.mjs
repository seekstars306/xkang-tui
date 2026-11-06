import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { ZCodeClient } from './zcode_client_cmp.mjs';
import dotenv from 'dotenv';
import { getDeviceId } from '../../src/utils/device.ts';
import { McpRemoteClient } from '../../src/mcp/client.ts';
const reportDir = process.argv[2];
const cases = JSON.parse(fs.readFileSync(path.join(reportDir, 'cases.json')));
// 对照用：/mcp 需要管理员令牌（同 dsh_business_tools.ts），服务地址固定为本机线上服务
const serverEnv = dotenv.parse(fs.readFileSync('server/.env'));
const config = { serverUrl: 'http://127.0.0.1:8600', token: serverEnv.XKANG_ADMIN_TOKENS.split(',').map(p => p.trim().split(':')[0]).find(Boolean) };
const deviceId = getDeviceId();
const mcp = new McpRemoteClient({ serverUrl: config.serverUrl, token: config.token });
assert(await mcp.connect());
const definitions = await mcp.listTools();
await mcp.close();
const allowed = definitions.map(t => `mcp__xkang__${t.name}`);
for (const round of [1, 2]) {
  for (const c of cases.filter(c => round === 1 || c.split === 'development')) {
    const dir = path.join(reportDir, `zcode-${c.id}-${round}`);
    fs.mkdirSync(dir, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xkang-zcode-run-'));
    let sessionId;
    const client = new ZCodeClient({
      onStderr: text => fs.appendFileSync(path.join(dir, 'stderr.log'), text),
      onNotification: value => fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(value) + '\n'),
      onRequest: async request => {
        if (request.method === 'session/requestRuntimePreferences') return { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true };
        fs.appendFileSync(path.join(dir, 'client-requests.jsonl'), JSON.stringify(request) + '\n');
        const toolName = request.params?.toolName || request.params?.request?.toolName;
        if (/permission/i.test(request.method)) return { decision: allowed.includes(toolName) || toolName === 'Read' ? 'allow' : 'deny', reason: 'Read-only evaluation scope' };
        throw new Error(`Unsupported evaluation client request: ${request.method}`);
      },
    });
    const start = Date.now();
    let error = null;
    try {
      const initial = await client.request('session/create', {
        workspace: { workspacePath: workspace, workspaceKey: workspace },
        model: { providerId: process.env.ZC_PROVIDER || '7f193b14-a7de-42df-88cb-b4dd462b940f', modelId: process.env.ZC_MODEL || 'gemini-3.8-flash-high', ...(process.env.ZC_REASONING === 'none' ? {} : { options: { reasoningLevel: process.env.ZC_REASONING || 'enabled' } }) },
        mode: 'build', persistence: 'immediate', titleGenerationEnabled: false, dynamicWorkflowEnabled: false,
        toolAllowlist: [...allowed, 'Read', 'ReadSessionContext', 'TodoWrite', 'TodoRead', 'AskUserQuestion'],
        mcpServers: [{ name: 'xkang', type: 'sse', url: `${config.serverUrl}/mcp/sse?deviceId=${encodeURIComponent(deviceId)}`, headers: [{ name: 'Authorization', value: `Bearer ${config.token}` }, { name: 'x-device-id', value: deviceId }], timeoutMs: 30000 }],
      });
      sessionId = initial.session.sessionId;
      assert.equal(initial.messages.length, 0);
      fs.writeFileSync(path.join(dir, 'started.json'), JSON.stringify({ caseId: c.id, round, split: c.split, sessionId, inputHash: crypto.createHash('sha256').update(JSON.stringify(c.input)).digest('hex'), input: c.input, workspace, model: initial.session.model, thought: initial.settings.thoughtLevel, allowedTools: allowed, startedAt: new Date(start).toISOString() }, null, 2));
      console.log(JSON.stringify({ event: 'zcode_started', caseId: c.id, round, sessionId }));
      await client.request('session/send', { sessionId, content: c.input, modelSelection: { providerId: process.env.ZC_PROVIDER || '7f193b14-a7de-42df-88cb-b4dd462b940f', modelId: process.env.ZC_MODEL || 'gemini-3.8-flash-high', ...(process.env.ZC_REASONING === 'none' ? {} : { options: { reasoningLevel: process.env.ZC_REASONING || 'enabled' } }) } });
      let snapshot;
      // 会话启动要先拉起十几个内置服务：真正开始运行前读到的 idle 不算结束（2026-10-29 曾因此把 6–8 秒、
      // 一次模型都没调用的会话当成"跑完"）。开始运行或已有助手消息才算开始；180 秒还没开始就报错。
      let begun = false;
      const sentAt = Date.now();
      do {
        await new Promise(resolve => setTimeout(resolve, 2000));
        snapshot = await client.request('session/read', { sessionId });
        if (snapshot.session.status === 'running' || snapshot.session.status === 'waiting') begun = true;
        if (!begun) {
          const list = (await client.request('session/messages', { sessionId })).messages || [];
          if (list.some(m => (m.info?.role || m.role) === 'assistant')) begun = true;
          else if (Date.now() - sentAt > 180000) throw new Error('session never started within 180s');
          else continue;
        }
        if (Date.now() - start > Number(process.env.ZC_DEADLINE_MIN || 18) * 60 * 1000) { await client.request('session/stop', { sessionId }); throw new Error((process.env.ZC_DEADLINE_MIN || 18) + '-minute deadline'); }
      } while (!begun || snapshot.session.status === 'running' || snapshot.session.status === 'waiting');
      fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
      const messages = await client.request('session/messages', { sessionId });
      fs.writeFileSync(path.join(dir, 'messages.json'), JSON.stringify(messages, null, 2));
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ caseId: c.id, round, sessionId, durationMs: Date.now()-start, status: snapshot.session.status, projection: snapshot.projection, error }, null, 2));
      console.log(JSON.stringify({ event: 'zcode_finished', caseId: c.id, round, seconds: Math.round((Date.now()-start)/1000), status: snapshot.session.status }));
    } catch (e) {
      error = String(e);
      fs.writeFileSync(path.join(dir, 'error.json'), JSON.stringify({ caseId: c.id, round, sessionId, error }, null, 2));
      console.log(JSON.stringify({ event: 'zcode_error', caseId: c.id, round, error }));
      throw e;
    } finally {
      if (sessionId) await client.request('session/close', { sessionId }).catch(() => {});
      client.close();
    }
  }
}
