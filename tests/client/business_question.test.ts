import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBusinessWebServer } from '../../src/business_web_server.ts';

test('网页澄清回复使用问题编号转发到业务服务', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xkang-question-'));
  let received: any;
  const backend = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"accepted"}');
  });
  backend.listen(0, '127.0.0.1'); await new Promise<void>(resolve => backend.once('listening', resolve));
  const web = await startBusinessWebServer({ port: 0, autoOpen: false, serverUrl: `http://127.0.0.1:${(backend.address() as any).port}`, token: 'test', cacheDirectory: directory });
  try {
    const response = await fetch(`http://127.0.0.1:${(web.address() as any).port}/api/session/s_test/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'q_test', answer: '核对全部业务记录' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(received, { url: '/agent/sessions/s_test/questions/q_test/answer', body: { answer: '核对全部业务记录' } });
  } finally {
    await new Promise<void>(resolve => web.close(() => resolve()));
    await new Promise<void>(resolve => backend.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
