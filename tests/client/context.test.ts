import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrapReminder,
  isReminderMessage,
  clampToolResult,
  isFailedToolResult,
  isDbChannelFailure,
  compactMessages,
  estimateTokens,
  messageText,
  DuplicateCallTracker,
} from '../../src/harness/context.ts';
import { sanitizeUserText, sanitizeUserParts, MAX_USER_TEXT_CHARS } from '../../src/utils/sanitize_input.ts';
import { todoWriteTool, getCurrentTodos } from '../../src/tools/todo.ts';
import { buildSystemPrompt } from '../../src/harness/system_prompt.ts';
import { Message, ToolDefinition } from '../../src/types/index.ts';

/** 校验消息结构：每个 tool_call 都有对应结果，每个 tool 结果都有对应调用 */
function assertValidPairing(messages: Message[]): void {
  const pending = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') {
      assert.equal(pending.size, 0, '上一个 assistant 的 tool_calls 还有未返回的结果');
      for (const tc of m.tool_calls || []) pending.add(tc.id);
    } else if (m.role === 'tool') {
      assert.ok(pending.has(m.tool_call_id!), `孤立的 tool 消息 ${m.tool_call_id}`);
      pending.delete(m.tool_call_id!);
    } else if (m.role === 'user') {
      assert.equal(pending.size, 0, 'user 消息之前有未返回的 tool_calls');
    }
  }
}

describe('提醒消息', () => {
  test('提醒用 <system-reminder> 包裹并标记，不会被当成客服输入', () => {
    const r = wrapReminder('请基于证据回答');
    assert.equal(r.role, 'user');
    assert.equal(r.isReminder, true);
    assert.match(messageText(r), /^<system-reminder>\n（以下是排障系统自动给出的提示，不是客服的输入）/);
    assert.equal(isReminderMessage(r), true);
  });

  test('识别旧版本的注入格式，普通客服消息不受影响', () => {
    assert.equal(isReminderMessage({ role: 'user', content: '【排查提示】若业务表中数据不足以解释当前问题' }), true);
    assert.equal(isReminderMessage({ role: 'user', content: '【系统提醒】在向客服提问之前' }), true);
    assert.equal(isReminderMessage({ role: 'user', content: '这个订单为什么退款失败' }), false);
    assert.equal(isReminderMessage({ role: 'assistant', content: '<system-reminder>' }), false);
  });
});

describe('工具结果截断', () => {
  test('未超限时原样返回', () => {
    assert.equal(clampToolResult('abc', 10), 'abc');
  });
  test('超限时按行截断并说明后面还有多少', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const out = clampToolResult(text, 200);
    assert.ok(out.length < text.length);
    assert.match(out, /以上内容不完整/);
    assert.match(out, /后面还有约 \d+ 个字符（\d+ 行）未显示/);
    const keptLines = out.split('\n').filter((l) => l.startsWith('line '));
    assert.ok(keptLines.every((l) => /^line \d+$/.test(l)), '不应切在一行的中间');
  });
});

describe('工具结果失败判定', () => {
  test('JSON 状态与文本前缀', () => {
    assert.equal(isFailedToolResult('{"status":"error","message":"数据库查询异常: 超时"}'), true);
    assert.equal(isFailedToolResult('{"status":"security_violation"}'), true);
    assert.equal(isFailedToolResult('{"status":"success","rowCount":0}'), false);
    assert.equal(isFailedToolResult('工具 [company_db_query] 执行超时 (20s)，已安全熔断'), true);
    assert.equal(isFailedToolResult('工具执行失败: boom'), true);
    assert.equal(isFailedToolResult('【CodeGraph 查询失败】未能完成'), true);
    assert.equal(isFailedToolResult('【单号定位失败】输入: 1541491413412347905\n❌ 无法连接数据库'), true);
    assert.equal(isFailedToolResult('【单号定位】输入: 1\n❌ 在下面所有候选主表中都没有找到这个单号。'), false, '查过所有表都没有是有效的否定结果');
    assert.equal(isFailedToolResult('【代码检索】关键词: "x" ... 结果: 未检索到匹配的代码。'), false, '查无结果本身也是证据，不算失败');
    assert.equal(isFailedToolResult(''), true);
    assert.equal(
      isFailedToolResult('【重复调用提示】这次调用与本轮之前的一次调用相同，内容如下；\n{"status":"error","message":"超时"}'),
      true,
      '带重复调用提示的失败结果仍应识别为失败'
    );
  });

  test('只把真正的数据库超时/断连算作通道故障（以前任何含"超时"二字的结果都会误触发）', () => {
    assert.equal(isDbChannelFailure('{"status":"error","message":"数据库查询异常: 数据库执行 SQL 超时 (10s)"}'), true);
    assert.equal(isDbChannelFailure('{"status":"success","rows":[["支付超时"]]}'), false);
    assert.equal(isDbChannelFailure('日志: 支付超时'), false);
  });
});

describe('上下文分级压缩', () => {
  const big = (n: number) => 'x'.repeat(n);
  function turn(i: number, toolCount: number, toolSize: number): Message[] {
    const out: Message[] = [{ role: 'user', content: `问题${i}` }];
    for (let t = 0; t < toolCount; t++) {
      const id = `c${i}_${t}`;
      out.push({ role: 'assistant', content: '', tool_calls: [{ id, name: 'company_db_query', arguments: { sql: 'SELECT 1' } }] });
      out.push({ role: 'tool', name: 'company_db_query', tool_call_id: id, content: big(toolSize) });
    }
    out.push({ role: 'assistant', content: `回答${i}` });
    return out;
  }

  test('未超阈值时不做任何改动', () => {
    const msgs: Message[] = [{ role: 'system', content: 's' }, ...turn(1, 2, 100)];
    const r = compactMessages(msgs, 100000);
    assert.equal(r.stage, 0);
    assert.equal(r.messages, msgs);
  });

  test('阶段 1：只压缩较早的工具结果，最近 8 条保持完整', () => {
    const msgs: Message[] = [{ role: 'system', content: 's' }, ...turn(1, 10, 5000)];
    const r = compactMessages(msgs, 18000);
    assert.equal(r.stage, 1);
    const tools = r.messages.filter((m) => m.role === 'tool');
    assert.equal(tools.filter((m) => messageText(m).startsWith('[已压缩')).length, 2);
    assert.equal(tools[0].raw_tool_result, big(5000), '压缩后仍保留原文供按需恢复');
    assert.match(messageText(tools[0]), /read_tool_result/);
    assert.equal(tools.slice(-8).every((m) => messageText(m).length === 5000), true);
    assertValidPairing(r.messages);
  });

  test('阶段 2/3：早期轮次只留问题与回答，原始问题永远保留', () => {
    const msgs: Message[] = [{ role: 'system', content: 's' }];
    for (let i = 1; i <= 8; i++) msgs.push(...turn(i, 3, 20000));
    const r = compactMessages(msgs, 30000);
    assert.ok(r.stage >= 2);
    assert.ok(r.afterTokens < r.beforeTokens);
    const firstUser = r.messages.find((m) => m.role === 'user' && !isReminderMessage(m));
    assert.equal(messageText(firstUser!), '问题1', '会话的原始问题不能被删掉（历史 bug：整轮删除导致原始问题丢失）');
    const users = r.messages.filter((m) => m.role === 'user' && !isReminderMessage(m)).map(messageText);
    assert.ok(users.includes('问题8') && users.includes('问题7'), '最近两轮保留');
    assertValidPairing(r.messages);
  });

  test('早期截图在压缩后被省略为文字说明', () => {
    const msgs: Message[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: '回答0' },
    ];
    for (let i = 1; i <= 4; i++) msgs.push(...turn(i, 2, 20000));
    const r = compactMessages(msgs, 40000);
    const first = r.messages[1];
    assert.equal(typeof first.content, 'string');
    assert.match(messageText(first), /早期截图已从上下文中省略/);
    assertValidPairing(r.messages);
  });

  test('token 估算包含图片与工具参数', () => {
    assert.ok(estimateTokens([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }]) >= 800);
  });
});

describe('DuplicateCallTracker', () => {
  test('参数完全相同（键顺序不同）视为重复', () => {
    const t = new DuplicateCallTracker();
    assert.equal(t.check('search_code', { keyword: 'a', scope: 'backend' }), false);
    assert.equal(t.check('search_code', { scope: 'backend', keyword: 'a' }), true);
    assert.equal(t.check('search_code', { keyword: 'b', scope: 'backend' }), false);
  });

  test('同一文件读取范围高度重叠视为重复（按服务端扩展后的实际窗口计算），路径写法差异不影响', () => {
    const t = new DuplicateCallTracker();
    assert.equal(t.check('read_file_lines', { filePath: './skt-back/A.java', startLine: 1120, endLine: 1160 }), false);
    assert.equal(t.check('read_file_lines', { filePath: 'skt-back\\A.java', startLine: 1130, endLine: 1150 }), true);
    assert.equal(t.check('read_file_lines', { filePath: 'skt-back/A.java', startLine: 1300, endLine: 1500 }), false);
    assert.equal(t.check('read_file_lines', { filePath: 'skt-back/B.java', startLine: 1120, endLine: 1160 }), false);
  });

  test('todo_write 与 ask_user_question 不参与判断', () => {
    const t = new DuplicateCallTracker();
    assert.equal(t.check('todo_write', { todos: [] }), false);
    assert.equal(t.check('todo_write', { todos: [] }), false);
  });
});

describe('客服输入清洗', () => {
  test('二进制附件（如 zip）被替换为说明，普通文本附件保留', () => {
    const garbage = 'PK\u0003\u0004' + '�'.repeat(500) + 'abc'.repeat(100);
    const input = `换了顺序也不行 [附件文件: 订单.zip]\n\`\`\`\n${garbage}\n\`\`\` [附件文件: log.txt]\n\`\`\`\nERROR at line 3\n\`\`\``;
    const r = sanitizeUserText(input);
    assert.match(r.text, /\[附件文件: 订单\.zip\]（二进制或非文本文件/);
    assert.doesNotMatch(r.text, /�/);
    assert.match(r.text, /ERROR at line 3/);
    assert.equal(r.notes.length, 1);
  });

  test('超长输入被截断并注明', () => {
    const r = sanitizeUserText('a'.repeat(MAX_USER_TEXT_CHARS + 500));
    assert.match(r.text, /后面 500 个字符已省略/);
  });

  test('多模态输入只清洗文本部分', () => {
    const r = sanitizeUserParts([
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
    ]);
    assert.equal(r.parts.length, 2);
    assert.equal(r.parts[1].type, 'image_url');
  });
});

describe('todo_write 按会话隔离', () => {
  test('两个会话的待办互不覆盖（以前是模块级全局变量）', async () => {
    const ctxA: any = { repoPath: '.', localCwd: '.' };
    const ctxB: any = { repoPath: '.', localCwd: '.' };
    await todoWriteTool.execute({ todos: [{ content: 'A 的步骤', status: 'pending' }] }, ctxA);
    await todoWriteTool.execute({ todos: [{ content: 'B 的步骤', status: 'completed' }] }, ctxB);
    assert.equal(getCurrentTodos(ctxA)[0].content, 'A 的步骤');
    assert.equal(getCurrentTodos(ctxB)[0].content, 'B 的步骤');
  });
});

describe('系统提示词', () => {
  const tool = (name: string) => ({ name, description: '', parameters: { type: 'object', properties: {} }, execute: async () => '' } as ToolDefinition);
  const l2Tools = ['lookup_order', 'company_db_query', 'search_code', 'read_file_lines', 'search_logs', 'todo_write', 'run_powershell'].map(tool);

  test('客户端提示词不携带公司业务工具、库表和源码规则', () => {
    const p = buildSystemPrompt(l2Tools, [], 'l2');
    for (const needle of ['独立本机助手', '业务排障入口', '不能凭空编造']) {
      assert.ok(p.includes(needle), `缺少: ${needle}`);
    }
    assert.doesNotMatch(p, /query_company_database/);
    assert.doesNotMatch(p, /默认已自动选库/);
  });

  test('截图规则只在本轮带图时注入，且不再"前端搜不到就熔断"', () => {
    assert.doesNotMatch(buildSystemPrompt(l2Tools, [], 'l2', { hasImages: false }), /截图排障规则/);
    const withImg = buildSystemPrompt(l2Tools, [], 'l2', { hasImages: true });
    assert.match(withImg, /截图排障规则/);
    assert.match(withImg, /不要把截图外的内容当作事实/);
    assert.doesNotMatch(withImg, /立即硬性熔断/);
  });

  test('L1 不出现公司内部工具的指引', () => {
    const p = buildSystemPrompt(l2Tools, [], 'l1');
    assert.doesNotMatch(p, /【数据库查询 - company_db_query】|【单号定位 - lookup_order】|【代码检索 - search_code】/);
    assert.match(p, /切换到业务排障入口/);
  });

  test('todo_write 指引要求失败步骤不能标记完成', () => {
    assert.match(buildSystemPrompt(l2Tools, [], 'l2'), /查询失败或超时的步骤保持未完成/);
  });
});
