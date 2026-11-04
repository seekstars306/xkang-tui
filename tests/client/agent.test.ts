import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentHarness } from '../../src/harness/agent.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { isReminderMessage, messageText } from '../../src/harness/context.ts';
import { Message, StreamEvent, ToolDefinition } from '../../src/types/index.ts';
import { ToolCallProtocolError } from '../../src/adapters/tool_call_error.ts';

type Scripted = Message | ((messages: Message[]) => Message);

class FakeGateway {
  public calls: Message[][] = [];
  public toolCounts: number[] = [];
  private i = 0;
  constructor(private script: Scripted[]) {}
  getCurrentModel() {
    return 'xkang-managed';
  }
  switchModel() {}
  async streamChat(messages: Message[], tools: ToolDefinition[], onEvent: (e: StreamEvent) => void): Promise<Message> {
    this.calls.push(messages.map((m) => ({ ...m })));
    this.toolCounts.push(tools.length);
    const step = this.script[Math.min(this.i++, this.script.length - 1)];
    const msg = typeof step === 'function' ? step(messages) : step;
    if (typeof msg.content === 'string' && msg.content) onEvent({ type: 'content_chunk', chunk: msg.content });
    return { ...msg, tool_calls: msg.tool_calls ? msg.tool_calls.map((tc) => ({ ...tc })) : undefined };
  }
}

function fakeTool(name: string, impl: (args: any) => Promise<unknown> | unknown): ToolDefinition {
  return { name, description: name, parameters: { type: 'object', properties: {} }, execute: async (args) => impl(args) };
}

function makeHarness(script: Scripted[], tools: ToolDefinition[]) {
  const gateway = new FakeGateway(script);
  const registry = new ToolRegistry([]);
  for (const t of tools) registry.registerRemote(t);
  const harness = new AgentHarness({ gateway: gateway as any, registry, context: { repoPath: '.', localCwd: '.' } });
  return { harness, gateway };
}

const call = (id: string, name: string, args: Record<string, unknown> = {}): Message => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, name, arguments: args }],
});
const answer = (text: string): Message => ({ role: 'assistant', content: text });
const DB_TIMEOUT = JSON.stringify({ status: 'error', message: '数据库查询异常: 数据库执行 SQL 超时 (10s)' });

describe('工具协议与未知工具', () => {
  test('损坏的工具响应只重试一次，随后有效工具仅执行一次', async () => {
    let executions = 0;
    const { harness, gateway } = makeHarness([
      () => { throw new ToolCallProtocolError('missing name'); },
      call('valid', 'catalog_fetch'), answer('done'),
    ], [fakeTool('catalog_fetch', () => { executions++; return 'value'; })]);
    assert.equal(await harness.run('读取目录', () => {}), 'done');
    assert.equal(executions, 1);
    assert.equal(gateway.calls.length, 3);
    assert.equal(harness.getMessages().some(m => messageText(m).includes('ESCALATE_TO_L2')), false);
  });

  test('持续损坏会明确失败，不耗尽 50 轮', async () => {
    const { harness, gateway } = makeHarness([() => { throw new ToolCallProtocolError('missing name'); }], []);
    assert.match(await harness.run('读取目录', () => {}), /未得出可靠结论/);
    assert.equal(gateway.calls.length, 2);
  });

  test('任意未知名称不会被当作 L2 专属工具', async () => {
    const { harness } = makeHarness([call('unknown', 'missing_catalog'), answer('无法查询')], []);
    await harness.run('目录信息', () => {});
    assert.equal(harness.getMessages().some(m => messageText(m).includes('ESCALATE_TO_L2')), false);
    assert.match(messageText(harness.getMessages().find(m => m.role === 'tool')!), /未加载工具/);
  });
});

describe('证据闸门', () => {
  test('查询全部失败却给出业务结论时，要求重写（历史案例：7 次超时后输出通用模板）', async () => {
    const { harness, gateway } = makeHarness(
      [
        call('c1', 'company_db_query'),
        call('c2', 'company_db_query'),
        answer('出单异常通常由以下几类原因导致：1. 乘客身份核验未通过 2. 余票不足'),
        answer('本次查询全部超时，目前无法确认原因。请补充业务类型与发生时间。'),
      ],
      [fakeTool('company_db_query', () => DB_TIMEOUT)]
    );
    const events: StreamEvent[] = [];
    const reply = await harness.run('1541491413412347905出单异常', (e) => events.push(e));
    assert.match(reply, /无法确认/);
    assert.equal(gateway.calls.length, 4);
    const lastCall = gateway.calls[3];
    const reminder = lastCall[lastCall.length - 1];
    assert.ok(isReminderMessage(reminder));
    assert.match(messageText(reminder), /查询工具全部失败或超时/);
    assert.equal(events.filter(e => e.type === 'content_chunk').length, 1, '只发布最终结果');
    assert.ok(harness.getMessages().some(m => m.role === 'assistant' && m.internal), '被拒绝的草稿只保存在内部记录');
    assert.equal(events.some(e => e.type === 'content_chunk' && /余票不足/.test(e.chunk)), false, '草稿不得先流到客户端');
  });

  test('至少有一个查询成功时不触发', async () => {
    const { gateway, harness } = makeHarness(
      [call('c1', 'company_db_query'), call('c2', 'lookup_order'), answer('该单号是酒店订单，状态为预定取消。')],
      [fakeTool('company_db_query', () => DB_TIMEOUT), fakeTool('lookup_order', () => '【单号定位】✅ 命中 1 处：【酒店】')]
    );
    const reply = await harness.run('查单', () => {});
    assert.match(reply, /酒店订单/);
    assert.equal(gateway.calls.length, 3);
  });

  test('回答中如实说明查询失败时不触发', async () => {
    const { gateway, harness } = makeHarness(
      [call('c1', 'company_db_query'), answer('数据库查询超时，暂时无法确认订单状态。')],
      [fakeTool('company_db_query', () => DB_TIMEOUT)]
    );
    await harness.run('查单', () => {});
    assert.equal(gateway.calls.length, 2);
  });

  test('闸门每轮最多触发一次，不会死循环', async () => {
    const { gateway, harness } = makeHarness(
      [call('c1', 'company_db_query'), answer('原因是余票不足。'), answer('原因是余票不足。')],
      [fakeTool('company_db_query', () => DB_TIMEOUT)]
    );
    const reply = await harness.run('查单', () => {});
    assert.equal(gateway.calls.length, 3);
    assert.match(reply, /无法确定/);
    assert.doesNotMatch(reply, /余票不足/);
  });
});

describe('空回复处理', () => {
  test('空回复时提醒基于证据回答，而不是强制输出"三段式报告"', async () => {
    const { gateway, harness } = makeHarness([answer(''), answer('已查到：...')], []);
    const reply = await harness.run('问题', () => {});
    assert.equal(reply, '已查到：...');
    const reminder = gateway.calls[1][gateway.calls[1].length - 1];
    assert.ok(isReminderMessage(reminder));
    assert.match(messageText(reminder), /没查到或查询失败的部分如实说明/);
    assert.doesNotMatch(messageText(reminder), /三段式/);
  });

  test('连续空回复后给出诚实的兜底说明并结束', async () => {
    const { gateway, harness } = makeHarness([answer(''), answer(''), answer('')], []);
    const reply = await harness.run('问题', () => {});
    assert.match(reply, /未得出可靠结论/);
    assert.equal(gateway.calls.length, 3);
  });
});

describe('工具结果与提醒', () => {
  test('长结果原文能按调用 ID 分页读取，恢复会话后仍可读取', async () => {
    const raw = 'x'.repeat(22000) + '\nclosing_condition: false';
    const { harness } = makeHarness([call('source', 'catalog_fetch'), answer('ok')], [fakeTool('catalog_fetch', () => raw)]);
    await harness.run('查目录', () => {});
    const source = harness.getMessages().find(m => m.tool_call_id === 'source')!;
    assert.equal(source.raw_tool_result, raw);
    assert.match(messageText(source), /read_tool_result/);
    const restored = makeHarness([answer('ok')], []).harness;
    restored.restoreMessages(JSON.parse(JSON.stringify(harness.getMessages())));
    const tool = restored.getRegistry().getTool('read_tool_result')!;
    const page = await tool.execute({ toolCallId: 'source', offset: 21995, limit: 100 }, { repoPath: '.', localCwd: '.' }) as any;
    assert.match(page.content, /closing_condition: false/);
    assert.equal(page.complete, true);
    const other = makeHarness([answer('ok')], []).harness;
    const missing = await other.getRegistry().getTool('read_tool_result')!.execute({ toolCallId: 'source' }, { repoPath: '.', localCwd: '.' }) as any;
    assert.equal(missing.status, 'error', '不能读取其他会话的原文');
  });

  test('不完整的结构化结果在首次收尾时核对任务范围，并允许补查后完成', async () => {
    const { harness, gateway } = makeHarness([
      call('p1', 'catalog_fetch', { offset: 0 }), answer('全部条目为 A、B。'),
      call('p2', 'catalog_fetch', { offset: 2 }), answer('全部条目为 A、B、C。'),
    ], [fakeTool('catalog_fetch', args => ({ status: 'success', complete: args.offset === 2, rows: args.offset === 2 ? ['C'] : ['A', 'B'] }))]);
    const result = await harness.run('列出全部目录条目', () => {});
    assert.equal(result, '全部条目为 A、B、C。');
    assert.equal(gateway.calls.length, 4);
    assert.match(messageText(gateway.calls[2].at(-1)!), /原始问题/);
  });

  test('完整空结果不触发补查；不完整结果的核对最多一次', async () => {
    const full = makeHarness([call('x', 'catalog_fetch'), answer('没有条目')], [fakeTool('catalog_fetch', () => ({ status: 'success', complete: true, rows: [] }))]);
    assert.equal(await full.harness.run('查目录', () => {}), '没有条目');
    assert.equal(full.gateway.calls.length, 2);
    const partial = makeHarness([call('x', 'catalog_fetch'), answer('只能确认当前片段')], [fakeTool('catalog_fetch', () => ({ status: 'success', complete: false, rows: ['A'] }))]);
    assert.equal(await partial.harness.run('查目录', () => {}), '只能确认当前片段');
    assert.equal(partial.gateway.calls.length, 3);
  });

  test('超长工具结果被截断并注明（以前在 JSON 中间硬切）', async () => {
    const long = Array.from({ length: 5000 }, (_, i) => `row ${i}`).join('\n');
    const { harness } = makeHarness([call('c1', 'search_code'), answer('ok')], [fakeTool('search_code', () => long)]);
    await harness.run('搜', () => {});
    const toolMsg = harness.getMessages().find((m) => m.role === 'tool')!;
    assert.ok(messageText(toolMsg).length <= 20500);
    assert.match(messageText(toolMsg), /以上内容不完整/);
  });

  test('本机提问不会注入公司查询工具或共用业务上下文', async () => {
    const { harness } = makeHarness(
      [call('q1', 'ask_user_question', { questions: [{ header: '业务', question: '是哪个业务？' }] }), answer('好的')],
      [fakeTool('ask_user_question', () => '')]
    );
    await harness.run('帮我看看', (e) => {
      if (e.type === 'question_requested') e.resolve('酒店');
    });
    const reminders = harness.getMessages().filter(isReminderMessage);
    assert.equal(reminders.length, 0);
    assert.doesNotMatch(messageText(harness.getMessages()[0]), /lookup_order/);
  });

  test('数据库连续超时 3 次才提示切换通道；结果里出现"超时"字样的正常数据不会误触发', async () => {
    const normal = JSON.stringify({ status: 'success', rows: [['支付超时']] });
    const a = makeHarness(
      [call('c1', 'company_db_query'), call('c2', 'company_db_query'), call('c3', 'company_db_query'), answer('数据库超时，暂时无法确认。')],
      [fakeTool('company_db_query', () => DB_TIMEOUT)]
    );
    await a.harness.run('查', () => {});
    assert.equal(a.harness.getMessages().filter((m) => isReminderMessage(m) && /数据库通道近期连续超时/.test(messageText(m))).length, 1);

    const b = makeHarness(
      [call('c1', 'company_db_query'), call('c2', 'company_db_query'), call('c3', 'company_db_query'), answer('查到了')],
      [fakeTool('company_db_query', () => normal)]
    );
    await b.harness.run('查', () => {});
    assert.equal(b.harness.getMessages().filter(isReminderMessage).length, 0);
  });

  test('二进制附件在进入上下文前被清洗', async () => {
    const { harness } = makeHarness([answer('收到')], []);
    const garbage = '�'.repeat(400) + 'zz'.repeat(100);
    await harness.run(`看下附件 [附件文件: a.zip]\n\`\`\`\n${garbage}\n\`\`\``, () => {});
    const user = harness.getMessages().find((m) => m.role === 'user')!;
    assert.doesNotMatch(messageText(user), /�/);
    assert.match(messageText(user), /二进制或非文本文件/);
  });
});

describe('截图规则作用范围', () => {
  test('只对本轮带截图的消息生效，下一轮纯文字问题不再带截图规则', async () => {
    const { harness, gateway } = makeHarness([answer('图片分析'), answer('文字回答')], []);
    await harness.run([{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }], () => {});
    assert.match(messageText(gateway.calls[0][0]), /截图排障规则/);
    await harness.run('这个退款规则是什么', () => {});
    assert.doesNotMatch(messageText(gateway.calls[1][0]), /截图排障规则/);
  });
});

describe('轮次上限', () => {
  test('总结也拿不到时输出兜底说明（即使之前有被拒绝的回答）', async () => {
    const script: Scripted[] = [call('c0', 'company_db_query'), answer('原因是余票不足。')];
    for (let i = 1; i < 60; i++) script.push(call(`c${i}`, 'company_db_query'));
    const { harness } = makeHarness(script, [fakeTool('company_db_query', () => DB_TIMEOUT)]);
    const reply = await harness.run('查', () => {});
    assert.match(reply, /未得出可靠结论/);
  });

  test('第 30 / 45 轮提醒收敛；轮次用完后禁用工具，要求模型基于已有证据总结（回放评测中出现过 50 轮无结论）', async () => {
    const script: Scripted[] = [];
    for (let i = 0; i < 50; i++) script.push(call(`c${i}`, 'search_code', { keyword: `k${i}` }));
    script.push(answer('【结论】无法确定。【依据】已确认 A 类第 10 行……【还需确认】……'));
    const { harness, gateway } = makeHarness(script, [fakeTool('search_code', () => '【代码检索】命中 1 个文件')]);
    const reply = await harness.run('找代码位置', () => {});
    assert.match(reply, /【结论】无法确定/);
    assert.equal(gateway.toolCounts.length, 51);
    assert.equal(gateway.toolCounts[50], 0, '最后一次总结调用不提供任何工具');
    const reminders = harness.getMessages().filter(isReminderMessage).map(messageText);
    assert.ok(reminders.some((r) => /连续进行了 30 轮工具调用/.test(r)));
    assert.ok(reminders.some((r) => /只剩 5 轮/.test(r)));
    assert.ok(reminders.some((r) => /工具调用次数已经用完/.test(r)));
  });
});

describe('重复调用提示', () => {
  test('重复读取同一段代码时在结果前加提示，不重叠的读取不提示', async () => {
    const { harness } = makeHarness(
      [
        call('r1', 'read_file_lines', { filePath: 'skt-back/A.java', startLine: 100, endLine: 130 }),
        call('r2', 'read_file_lines', { filePath: 'skt-back\\A.java', startLine: 110, endLine: 140 }),
        call('r3', 'read_file_lines', { filePath: 'skt-back/A.java', startLine: 500, endLine: 600 }),
        answer('done'),
      ],
      [fakeTool('read_file_lines', () => '【文件】A.java')]
    );
    await harness.run('读代码', () => {});
    const results = harness.getMessages().filter((m) => m.role === 'tool').map(messageText);
    assert.doesNotMatch(results[0], /重复调用提示/);
    assert.match(results[1], /^【重复调用提示】/);
    assert.doesNotMatch(results[2], /重复调用提示/);
  });
});
