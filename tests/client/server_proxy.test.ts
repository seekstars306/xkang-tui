import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { ServerProxyAdapter } from '../../src/adapters/server_proxy.ts';
import { Message } from '../../src/types/index.ts';

let server: http.Server;
let baseUrl = '';
const requests: any[] = [];
let nextFrames: Record<string, unknown>[] | undefined;

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'xkang-managed', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (nextFrames) {
        const frames = nextFrames;
        nextFrames = undefined;
        for (const delta of frames) res.write(chunk(delta));
        res.write(chunk({}, 'tool_calls'));
        res.end('data: [DONE]\n\n');
        return;
      }
      res.write(
        chunk({
          role: 'assistant',
          content: null,
          tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search_code', arguments: '' }, extra_content: { google: { thought_signature: 'SIG-123' } } }],
        })
      );
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"keyword":"x"}' } }] }));
      res.write(chunk({}, 'tool_calls'));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

describe('ServerProxyAdapter', () => {
  test('拒绝缺少工具名的残缺批次，完整调用也不能提前执行', async () => {
    nextFrames = [{ tool_calls: [
      { index: 0, id: 'a', function: { name: 'catalog_fetch', arguments: '{"key":"sample"}' } },
      { index: 1, function: { arguments: '{"key":"sample"}' } },
    ] }];
    const events: string[] = [];
    await assert.rejects(new ServerProxyAdapter(baseUrl, 'test').streamChat([], [], e => events.push(e.type)), { name: 'ToolCallProtocolError' });
    assert.equal(events.includes('tool_call_start'), false);
  });

  test('交错分片按索引重组，保留末尾才出现的调用 ID', async () => {
    nextFrames = [
      { tool_calls: [{ index: 0, function: { name: 'catalog_fetch', arguments: '{"key":' } }, { index: 1, id: 'b', function: { name: 'status_read', arguments: '{"id":' } }] },
      { tool_calls: [{ index: 1, function: { arguments: '2}' } }, { index: 0, id: 'a', function: { arguments: '"x"}' } }] },
    ];
    const result = await new ServerProxyAdapter(baseUrl, 'test').streamChat([], [], () => {});
    assert.deepEqual(result.tool_calls?.map(t => [t.id, t.name, t.arguments]), [['a', 'catalog_fetch', { key: 'x' }], ['b', 'status_read', { id: 2 }]]);
  });

  test('截断 JSON、非对象参数和重复 ID 不会伪装成可执行参数', async () => {
    for (const calls of [
      [{ index: 0, id: 'a', function: { name: 'catalog_fetch', arguments: '{"key":' } }],
      [{ index: 0, id: 'a', function: { name: 'catalog_fetch', arguments: 'null' } }],
      [{ index: 0, id: 'a', function: { name: 'catalog_fetch', arguments: '[]' } }],
      [{ index: 0, function: { name: 'catalog_fetch', arguments: '{}' } }],
      [{ id: 'a', function: { name: 'catalog_fetch', arguments: '{}' } }],
      [{ index: 0, id: 'a', function: { name: 'catalog_fetch', arguments: '{}' } }, { index: 1, id: 'a', function: { name: 'status_read', arguments: '{}' } }],
    ]) {
      nextFrames = [{ tool_calls: calls }];
      await assert.rejects(new ServerProxyAdapter(baseUrl, 'test').streamChat([], [], () => {}), { name: 'ToolCallProtocolError' });
    }
  });
  test('流式工具调用上的 extra_content（thought signature）被保留并在下一轮原样回传', async () => {
    const requestStart = requests.length;
    const adapter = new ServerProxyAdapter(baseUrl, 'tok_test');
    const history: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
    ];
    const first = await adapter.streamChat(history, [], () => {});
    assert.equal(first.tool_calls?.[0].name, 'search_code');
    assert.deepEqual(first.tool_calls?.[0].arguments, { keyword: 'x' });
    assert.deepEqual(first.tool_calls?.[0].extra_content, { google: { thought_signature: 'SIG-123' } });

    history.push(first, { role: 'tool', name: 'search_code', tool_call_id: 'call_1', content: 'result' });
    await adapter.streamChat(history, [], () => {});
    const sentAssistant = requests[requestStart + 1].messages.find((m: any) => m.role === 'assistant');
    assert.deepEqual(sentAssistant.tool_calls[0].extra_content, { google: { thought_signature: 'SIG-123' } });
  });

  test('isReminder 等内部字段不会发给服务端', async () => {
    const adapter = new ServerProxyAdapter(baseUrl, 'tok_test');
    await adapter.streamChat([{ role: 'user', content: '<system-reminder>x</system-reminder>', isReminder: true }], [], () => {});
    const sent = requests[requests.length - 1].messages[0];
    assert.equal(sent.isReminder, undefined);
    assert.equal(sent.role, 'user');
  });

  test('本地保存的工具原文不会随普通模型请求发送', async () => {
    const adapter = new ServerProxyAdapter(baseUrl, 'tok_test');
    await adapter.streamChat([
      { role: 'assistant', content: '', tool_calls: [{ id: 'source', name: 'catalog_fetch', arguments: {} }] },
      { role: 'tool', tool_call_id: 'source', content: '摘要', raw_tool_result: 'ARCHIVED_ONLY_PAYLOAD' },
    ], [], () => {});
    const sent = requests.at(-1).messages.find((m: any) => m.role === 'tool');
    assert.equal(sent.content, '摘要');
    assert.equal(JSON.stringify(requests.at(-1)).includes('ARCHIVED_ONLY_PAYLOAD'), false);
  });
});
