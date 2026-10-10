import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { detectVerdict as tsDetectVerdict, splitSections as tsSplitSections } from '../../src/utils/answer_verdict.ts';
import { SessionDatabase } from '../../src/config/session_db.ts';
import type { Message } from '../../src/types/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 在 vm 里加载网页端的 web/answer.js（与浏览器中运行的是同一份文件） */
function loadWebAnswer(): any {
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'answer.js'), 'utf8'), sandbox);
  return sandbox.XkAnswer;
}

const X = loadWebAnswer();
// vm 里创建的对象原型不同，比较前转成普通 JSON
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

const VERDICT_CASES: Array<[string, string, string | null]> = [
  ['标准格式·已确认', '### 【结论】\n**已确认**：这是酒店订单。\n\n### 【依据】\n- skt_hotel_order', 'confirmed'],
  ['括号标注·推断', '【结论】（推断）退票已经成功，页面没刷新', 'inferred'],
  ['加粗标题·无法确定', '**【结论】** 无法确定：数据库连不上', 'unknown'],
  ['混合标注取最弱', '### 【结论】\n- **已确认**：订单已取消\n- **推断**：取消原因是满房', 'inferred'],
  ['正文里的"已确认"不算标注', '### 【结论】\n订单已确认出票，客服已确认无误。', null],
  ['标注写在标题里', '### 【结论：已确认】\n这是一张酒店订单', 'confirmed'],
  ['没有结论段', '已确认：订单正常。', null],
  ['编号标题', '### 一、 结论 / 原因分析\n**推断**：供应商接口超时', 'inferred'],
  ['加粗小标题带冒号', '**结论**：已确认，订单正常出票', 'confirmed'],
  ['emoji 标题', '### 💡 结论与建议\n无法确定：缺少下单时间', 'unknown'],
  ['代码块里的标题不切分', '```\n【结论】\n已确认：x\n```', null],
  ['无法推断', '### 【结论】\n无法推断具体原因，需要补充日志', 'unknown'],
  ['已确认在行首无标点', '【结论】\n已确认这是一张火车票订单', 'confirmed'],
];

test('结论把握程度：网页端与服务端识别结果一致且符合预期', () => {
  for (const [name, text, expected] of VERDICT_CASES) {
    assert.equal(X.detectVerdict(text), expected, `网页端：${name}`);
    assert.equal(tsDetectVerdict(text), expected, `服务端：${name}`);
  }
});

test('回答分段：识别标准格式与历史格式，网页端与服务端一致', () => {
  const samples = [
    '### 【结论 / 原因分析】\n订单被取消\n\n### 【触发条件与规则】\n满房即取消\n\n### 【客服处理建议 / 话术】\n> 您好，房间已满',
    '## 排障报告\n\n【结论】\n已确认：正常\n---\n【依据】\n- a\n- b\n\n---',
    '【结论】\n**推断**：x\n【酒店】skt.skt_hotel_order（按 id 匹配，1 行）\n【还需确认】\n- 下单时间',
    '**建议客服向用户这样解释：**\n> 您好，系统显示退票成功',
    '### 一、 结论 / 原因分析\n原因A\n### 四、 客服处理建议 / 话术\n> 您好',
    '**结论**可能会变，请稍后再查',
  ];
  for (const s of samples) assert.deepEqual(plain(X.splitSections(s)).sections.map((x: any) => ({ kind: x.kind, title: x.title, body: x.body })), plain(tsSplitSections(s).sections), s);

  const a = plain(X.splitSections(samples[0]));
  assert.deepEqual(a.sections.map((s: any) => s.kind), ['conclusion', 'other', 'script']);
  assert.deepEqual(a.sections.map((s: any) => s.label), ['结论', '触发条件与规则', '客服话术']);

  const b = plain(X.splitSections(samples[1]));
  assert.equal(b.preamble, '## 排障报告');
  assert.equal(b.sections[0].body, '已确认：正常', '段落首尾的 --- 分隔线会去掉');
  assert.equal(b.sections[1].body, '- a\n- b');

  const c = plain(X.splitSections(samples[2]));
  assert.deepEqual(c.sections.map((s: any) => s.kind), ['conclusion', 'open'], '正文行首的【酒店】不是段落标题');
  assert.match(c.sections[0].body, /【酒店】skt\.skt_hotel_order/);

  assert.equal(plain(X.splitSections(samples[3])).sections[0].kind, 'script');
  assert.deepEqual(plain(X.splitSections(samples[4])).sections.map((s: any) => s.kind), ['conclusion', 'script']);
  assert.equal(plain(X.splitSections(samples[5])).sections.length, 0, '正文里的加粗"结论"不当成标题');
});

test('去掉结论开头重复的把握程度标注', () => {
  assert.equal(X.stripVerdictPrefix('结论', '**已确认**：这是一张酒店订单'), '这是一张酒店订单');
  assert.equal(X.stripVerdictPrefix('结论', '（推断）退票已成功'), '退票已成功');
  const mixed = '**已确认**：订单取消\n**推断**：原因是满房';
  assert.equal(X.stripVerdictPrefix('结论', mixed), mixed, '多种标注混在一起时保留原文');
  assert.equal(X.stripVerdictPrefix('结论', '已确认'), '已确认', '去掉后为空时保留原文');
});

test('排查步骤说明：工具调用翻译成客服能看懂的话', () => {
  const d = (name: string, args: Record<string, unknown>) => plain(X.describeToolStep(name, args));
  assert.deepEqual(d('lookup_order', { id: '1549900000000000001' }), { kind: 'order', title: '定位单号 1549900000000000001' });
  assert.deepEqual(d('company_db_query', { action: 'query', sql: 'SELECT a.x FROM skt.order_air a JOIN skt.`order` o ON o.id = a.order_id' }), {
    kind: 'db',
    title: '查数据库 order_air、order',
  });
  assert.equal(d('company_db_query', { action: 'describe_table', tableName: 'order_air' }).title, '查看表结构 order_air');
  assert.equal(d('company_db_query', { action: 'list_databases' }).title, '查看有哪些数据库');
  assert.equal(d('search_logs', { app: 'cxy-web', keyword: 'ROOM_UNAVAILABLE', target_time: '2026-08-25 13:19:20' }).title, '查日志 cxy-web「ROOM_UNAVAILABLE」，2026-08-25 13:19:20 前后');
  assert.equal(d('search_logs', { minutes_ago: 30 }).title, '查日志 （全部服务），最近 30 分钟');
  assert.equal(d('search_code', { keyword: '正在加载中', scope: 'frontend' }).title, '搜代码「正在加载中」（前端）');
  assert.equal(d('read_file_lines', { filePath: 'skt-back/a/b/OrderServiceImpl.java', startLine: 10, endLine: 20 }).title, '读代码 OrderServiceImpl.java 第 10–20 行');
  assert.equal(d('git_inspect', { action: 'blame', filePath: 'a/Foo.java', lineRange: '50,70' }).title, '查逐行修改人 Foo.java 第 50–70 行');
  assert.equal(d('codegraph_explore', { symbol: 'checkRule', queryType: 'callers' }).title, '查调用关系 checkRule 被谁调用');
  assert.deepEqual(d('some_new_tool', {}), { kind: 'other', title: '调用 some_new_tool' });
});

test('排查步骤结果：从工具返回中提炼一句话并区分有结果 / 没查到 / 没查成', () => {
  const s = (name: string, text: string, isError = false) => plain(X.summarizeToolResult(name, {}, text, isError));
  const lookupHit = '【单号定位】输入: 1549（识别为: 19 位系统单号/ID）\n✅ 命中 1 处：\n1. 【酒店】skt.skt_hotel_order（按 id 匹配，1 行）\n   - id=1';
  assert.deepEqual(s('lookup_order', lookupHit), { state: 'ok', text: '找到：酒店 skt_hotel_order' });
  assert.deepEqual(s('lookup_order', '【单号定位失败】输入: 1（识别为: x）\n❌ 无法连接数据库: 超时'), { state: 'fail', text: '数据库连不上，没有查到' });
  assert.equal(s('lookup_order', '【单号定位】输入: 1\n未命中（已查询，0 行）: 订单 skt.order.order_id').state, 'empty');

  const rows = (extra: Record<string, unknown>) => JSON.stringify({ status: 'success', action: 'query', columns: ['a'], rows: [['1'], ['2']], ...extra });
  assert.deepEqual(s('company_db_query', rows({ rowCount: 2, complete: true })), { state: 'ok', text: '2 行' });
  assert.deepEqual(s('company_db_query', rows({ rowCount: 50, complete: false })), { state: 'ok', text: '50 行，只取了一部分' });
  assert.deepEqual(s('company_db_query', JSON.stringify({ status: 'success', action: 'query', columns: ['a'], rows: [], rowCount: 0 })), { state: 'empty', text: '没有查到数据' });
  assert.equal(s('company_db_query', JSON.stringify({ status: 'error', message: '无法连接数据库' })).state, 'fail');
  assert.deepEqual(s('company_db_query', JSON.stringify({ status: 'security_violation', message: 'x' })), { state: 'fail', text: '不是只读查询，已拦截' });
  assert.equal(s('company_db_query', '工具执行失败: socket hang up', true).text, 'socket hang up');

  assert.deepEqual(s('search_logs', '=== 日志查询结果: 共 3 条（窗口内全部匹配） ===\n...'), { state: 'ok', text: '3 条日志' });
  assert.deepEqual(s('search_logs', '=== 日志查询结果: 返回 50 条（已达到 limit=50 上限…） ===') , { state: 'ok', text: '50 条，只取了最近的' });
  assert.equal(s('search_logs', '窗口 [2026-08-25 13:09:20 ~ 13:29:20] 内没有匹配的日志。查询: x').state, 'empty');
  assert.equal(s('search_logs', '日志查询失败: 连接超时').state, 'fail');
  assert.deepEqual(s('search_logs', '【重复调用提示】这次调用与本轮之前的一次调用相同\n=== 日志查询结果: 共 2 条（窗口内全部匹配） ==='), { state: 'ok', text: '2 条日志' });

  assert.deepEqual(s('search_code', '【代码检索】关键词: "x"\n命中 12 个文件、共 30 处匹配（按路径排序）。'), { state: 'ok', text: '12 个文件' });
  assert.equal(s('search_code', '【代码检索】关键词: "x"\n结果: 未检索到匹配的代码。').state, 'empty');
  assert.deepEqual(s('read_file_lines', '【文件】a/Foo.java（共 300 行）显示第 10-129 行\n10: x'), { state: 'ok', text: '第 10–129 行，共 300 行' });
  assert.deepEqual(s('search_logs', '工具 [search_logs] 执行超时 (20s)，已安全熔断'), { state: 'fail', text: '超时，没有结果' });
  assert.equal(s('edit_file', '[操作未执行：员工在操作审批门中拒绝了本次修改请求 (目标文件: a.vue)]').state, 'empty');
  assert.deepEqual(s('ask_user_question', '[客服已通过交互选项确认结果]: 机票'), { state: 'ok', text: '你的回答：机票' });
  assert.equal(s('codegraph_explore', '【CodeGraph 查询失败】未能完成对 "x" 的 callers 查询').state, 'fail');
});

test('Markdown：转义、链接白名单、引用、列表、表格和代码块', () => {
  const md = (t: string) => X.renderMarkdown(t) as string;
  const xss = md('<script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.ok(!/<script|<img/i.test(xss));
  assert.match(xss, /&lt;script&gt;/);
  assert.ok(!md('[点我](javascript:alert(1))').includes('<a '), '只允许 http/https 链接');
  assert.match(md('[文档](https://x.com/?a=1&b=2)'), /<a href="https:\/\/x\.com\/\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">文档<\/a>/);
  assert.ok(!md('[a](https://x.com/"onmouseover="alert(1))').includes('onmouseover="'), '链接里的引号不能跳出属性');

  assert.equal(md('> 您好\n> 第二行'), '<blockquote><p>您好<br>第二行</p></blockquote>', '引用块（以前因为先转义了 > 而从不生效）');
  assert.equal(md('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(md('- a\n  - b\n- c'), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
  assert.equal(md('a\nb\n\nc'), '<p>a<br>b</p><p>c</p>');
  assert.match(md('`SELECT *` 和 *重点*'), /<code>SELECT \*<\/code> 和 <em>重点<\/em>/);

  const table = md('| 来源 | 信息 |\n|---|---|\n| a | x<br>y |\n| b | z |');
  assert.equal((table.match(/<tr>/g) || []).length, 3);
  assert.match(table, /<td>x<br>y<\/td>/);

  const code = md('```sql\nSELECT 1\n```\n之后');
  assert.match(code, /<span class="code-lang">sql<\/span>/);
  assert.match(code, /<pre><code>SELECT 1<\/code><\/pre>/);
  assert.match(code, /<p>之后<\/p>/);
  assert.match(md('```sql\nSELECT * FROM a'), /<pre><code>SELECT \* FROM a<\/code><\/pre>/, '流式输出中未闭合的代码块');

  // 真实回答里出现过：代码块写在列表项里整体缩进，收尾的 ``` 也缩进；以前会把后面的内容全部吞进代码块
  const nested = md('2. 场景 B\n   ```java\n   // 第 3051 行\n   foo();\n   ```\n\n### 总结\n1. a');
  assert.match(nested, /<ol start="2"><li>场景 B<\/li><\/ol>/);
  assert.match(nested, /<pre><code>\/\/ 第 3051 行\nfoo\(\);<\/code><\/pre>/);
  assert.match(nested, /<h4 class="md-h">总结<\/h4><ol><li>a<\/li><\/ol>$/);
  assert.equal(md('行内的 ``` 不是代码块'), '<p>行内的 ``` 不是代码块</p>');
});

test('提问文本中的附件拆分、占位回复识别、复制用纯文本', () => {
  const ask = plain(X.parseAskText('退票报错\n\n[附件文件: a.log]\n```\nline1\nline2\n```'));
  assert.deepEqual(ask, { main: '退票报错', files: [{ name: 'a.log', content: 'line1\nline2' }] });
  assert.equal(X.isPlaceholderReply('[本轮没有输出内容]'), true);
  assert.equal(X.isPlaceholderReply('[文档](https://x.com)'), false);
  assert.equal(X.toPlainText('### 【结论】\n**已确认**：A\n\n> 您好'), '【结论】\n已确认：A\n\n您好');
});

test('会话列表带出最近一次回答的把握程度', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-sessdb-'));
  const db = new SessionDatabase(path.join(dir, 'sessions.db'));
  const now = new Date().toISOString();
  const msgs = (final: string): Message[] => [
    { role: 'system', content: 's' },
    { role: 'user', content: '查单' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'lookup_order', arguments: { id: '1' } }] },
    { role: 'tool', tool_call_id: 't1', name: 'lookup_order', content: 'x' },
    { role: 'assistant', content: final },
  ];
  db.saveSession({ id: 's1', title: 'a', createdAt: now, lastActiveAt: now, messages: msgs('### 【结论】\n**推断**：可能是满房') });
  db.saveSession({ id: 's2', title: 'b', createdAt: now, lastActiveAt: now, messages: [...msgs('【结论】无法确定：缺少时间'), { role: 'assistant', content: '[本轮没有输出内容]' }] });
  db.saveSession({ id: 's3', title: 'c', createdAt: now, lastActiveAt: now, messages: msgs('你好，有什么可以帮你？') });
  try {
    const byId = Object.fromEntries(db.listSessions().map((s) => [s.id, s.verdict]));
    assert.deepEqual(byId, { s1: 'inferred', s2: 'unknown', s3: null });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
