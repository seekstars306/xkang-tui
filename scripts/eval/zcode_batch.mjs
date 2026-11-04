import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { ZCodeClient } from './zcode_client.mjs';
import { loadUserLocalConfig } from '../../src/config/user_config.ts';
import { getDeviceId } from '../../src/utils/device.ts';
import { McpRemoteClient } from '../../src/mcp/client.ts';
const reportDir = process.argv[2];
const cases = JSON.parse(fs.readFileSync(path.join(reportDir, 'cases.json')));
const config = loadUserLocalConfig();
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
        model: { providerId: '7f193b14-a7de-42df-88cb-b4dd462b940f', modelId: 'gemini-3.8-flash-high', options: { reasoningLevel: 'enabled' } },
        mode: 'build', persistence: 'immediate', titleGenerationEnabled: false, dynamicWorkflowEnabled: false,
        toolAllowlist: [...allowed, 'Read', 'ReadSessionContext', 'TodoWrite', 'TodoRead', 'AskUserQuestion'],
        mcpServers: [{ name: 'xkang', type: 'sse', url: `${config.serverUrl}/mcp/sse?deviceId=${encodeURIComponent(deviceId)}`, headers: [{ name: 'Authorization', value: `Bearer ${config.token}` }, { name: 'x-device-id', value: deviceId }], timeoutMs: 30000 }],
      });
      sessionId = initial.session.sessionId;
      assert.equal(initial.messages.length, 0);
      fs.writeFileSync(path.join(dir, 'started.json'), JSON.stringify({ caseId: c.id, round, split: c.split, sessionId, inputHash: crypto.createHash('sha256').update(JSON.stringify(c.input)).digest('hex'), input: c.input, workspace, model: initial.session.model, thought: initial.settings.thoughtLevel, allowedTools: allowed, startedAt: new Date(start).toISOString() }, null, 2));
      console.log(JSON.stringify({ event: 'zcode_started', caseId: c.id, round, sessionId }));
      await client.request('session/send', { sessionId, content: c.input, modelSelection: { providerId: '7f193b14-a7de-42df-88cb-b4dd462b940f', modelId: 'gemini-3.8-flash-high', options: { reasoningLevel: 'enabled' } } });
      let snapshot;
      do {
        await new Promise(resolve => setTimeout(resolve, 2000));
        snapshot = await client.request('session/read', { sessionId });
        if (Date.now() - start > 18 * 60 * 1000) { await client.request('session/stop', { sessionId }); throw new Error('18-minute deadline'); }
      } while (snapshot.session.status === 'running' || snapshot.session.status === 'waiting');
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
