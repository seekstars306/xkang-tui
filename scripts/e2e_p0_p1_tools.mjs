import fs from 'node:fs';
import { createDefaultToolRegistry } from '../dist/tools/index.js';
import { executeSearchCode } from '../server/dist/tools/code_search.js';
import { todoWriteTool, getCurrentTodos, resetTodos } from '../dist/tools/todo.js';
import { askUserQuestionTool } from '../dist/tools/ask_user.js';
import { webFetchTool, cleanHtmlToMarkdown } from '../dist/tools/web_fetch.js';
import { buildSystemPrompt } from '../dist/harness/system_prompt.js';
import { startServer } from '../server/dist/index.js';
import { McpRemoteClient } from '../dist/mcp/client.js';

const TEST_PORT = 8399;
const TEST_TOKEN = 'test_token_p0p1';
const TEST_AUDIT = './test_p0p1_audit.jsonl';

process.env.PORT = String(TEST_PORT);
process.env.XKANG_TOKENS = `${TEST_TOKEN}:P0P1Tester`;
process.env.AUDIT_LOG_PATH = TEST_AUDIT;
process.env.XKANG_LLM_MOCK = '1';


// 测试实例不能执行定时代码同步（会对 D:\\skt_project 执行 git pull / reset）
process.env.CODE_SYNC_ENABLED = 'false';
const { server } = startServer();

async function runTests() {
  try {
    console.log('\n======================================================');
    console.log('🧪 开始进行「P0/P1 工具移植与系统提示词动态分段」验证');
    console.log('======================================================\n');

    // 1. 测试 search_code 内置 ripgrep
    console.log('▶ [1/6] 测试内置 ripgrep (search_code) 本地全文检索...');
    const searchRes = await executeSearchCode(
      { keyword: 'AgentHarness' },
      { codeRepoPath: process.cwd() }
    );
    console.log('   检索输出片段:\n', String(searchRes).slice(0, 150));
    if (!String(searchRes).includes('AgentHarness')) {
      throw new Error('search_code 未能成功检索到本地关键字');
    }
    console.log('   ✅ search_code 内置 ripgrep 检索成功！');

    // 2. 测试 todo_write
    console.log('\n▶ [2/6] 测试 todo_write 任务看板更新与状态统计...');
    const todoCtx = { repoPath: process.cwd(), localCwd: process.cwd() };
    resetTodos(todoCtx);
    const todoRes = await todoWriteTool.execute(
      {
        todos: [
          { content: '定位退款规则源文件', status: 'completed', priority: 'high' },
          { content: '查阅 RefundService 条件分支', status: 'in_progress', priority: 'high' },
          { content: '生成客服话术', status: 'pending', priority: 'medium' },
        ],
      },
      todoCtx
    );
    console.log('   Todo 渲染输出:\n', todoRes);
    const todosInMem = getCurrentTodos(todoCtx);
    if (todosInMem.length !== 3 || todosInMem[0].status !== 'completed') {
      throw new Error('todo_write 内存存储与统计有误');
    }
    console.log('   ✅ todo_write 状态看板更新与格式化正确！');

    // 3. 测试 ask_user_question
    console.log('\n▶ [3/6] 测试 ask_user_question 结构化澄清提问...');
    const askRes = await askUserQuestionTool.execute(
      {
        questions: [
          {
            header: '订单渠道',
            question: '请问该订单的支付渠道是什么？',
            options: [
              { label: '微信支付', description: 'T+1 结算规则' },
              { label: '支付宝', description: '实时退款规则' },
            ],
          },
        ],
      },
      { repoPath: process.cwd() }
    );
    console.log('   提问渲染输出:\n', askRes);
    if (!String(askRes).includes('微信支付') || !String(askRes).includes('订单渠道')) {
      throw new Error('ask_user_question 格式化输出缺失内容');
    }
    console.log('   ✅ ask_user_question 结构化提问成功！');

    // 4. 测试 web_fetch 清洗与防 SSRF
    console.log('\n▶ [4/6] 测试 web_fetch (HTML 清洗转 Markdown 与防 SSRF)...');
    const sampleHtml = `
      <html>
        <head><title>Test Doc</title><style>body { color: red; }</style></head>
        <body>
          <nav><a href="/home">Home</a></nav>
          <h1>Spring Boot 超时排查指南</h1>
          <p>当遇到 <code>TimeoutException</code> 时，请检查如下配置：</p>
          <ul>
            <li>超时重试次数 <code>ribbon.MaxAutoRetries=1</code></li>
            <li>连接超时时间 <a href="https://example.com/config">参考文档</a></li>
          </ul>
          <footer>Copyright 2026</footer>
        </body>
      </html>
    `;
    const cleanMd = cleanHtmlToMarkdown(sampleHtml);
    console.log('   HTML 清洗后 Markdown 片段:\n', cleanMd);
    if (cleanMd.includes('<nav>') || cleanMd.includes('<footer>') || cleanMd.includes('<style>')) {
      throw new Error('HTML 清洗未能彻底去除噪音标签');
    }
    if (!cleanMd.includes('# Spring Boot 超时排查指南') || !cleanMd.includes('ribbon.MaxAutoRetries=1')) {
      throw new Error('Markdown 关键正文转换缺失');
    }

    // SSRF 拦截测试
    const ssrfRes = await webFetchTool.execute({ url: 'http://127.0.0.1:8080/internal' }, { repoPath: '.' });
    console.log('   SSRF 拦截结果:', ssrfRes);
    if (!String(ssrfRes).includes('安全拦截')) {
      throw new Error('web_fetch 未能成功拦截私有内网 IP');
    }
    console.log('   ✅ web_fetch HTML清洗与 SSRF 防护测试通过！');

    // 5. 测试服务端 MCP web_search 工具同步与调用
    console.log('\n▶ [5/6] 测试服务端 MCP web_search 远程注册与调用...');
    const registry = createDefaultToolRegistry();
    const mcpClient = new McpRemoteClient({
      serverUrl: `http://localhost:${TEST_PORT}`,
      token: TEST_TOKEN,
    });

    const syncRes = await registry.syncWithRemote(mcpClient);
    console.log('   MCP 同步结果:', syncRes);
    console.log('   聚合后的工具列表:', registry.summary.toolNames);

    const toolNames = registry.summary.toolNames;
    for (const required of ['lookup_order', 'search_code', 'company_db_query', 'search_logs']) {
      if (!toolNames.includes(required)) throw new Error(`未能从服务端 MCP 挂载 ${required} 工具`);
    }
    for (const removed of ['knowledge_search', 'kg_query']) {
      if (toolNames.includes(removed)) throw new Error(`不应再注册返回固定文案的脚手架工具 ${removed}`);
    }
    const remoteWebSearch = registry.getTool('web_search');
    if (process.env.SEARCH_API_KEY || process.env.EXA_API_KEY) {
      if (!remoteWebSearch || !remoteWebSearch.isRemote) throw new Error('已配置搜索 Key，但未挂载 web_search 工具');
      console.log('   ✅ 已配置搜索 Key，web_search 已挂载');
    } else {
      if (remoteWebSearch) throw new Error('未配置 SEARCH_API_KEY 时不应注册 web_search（以前会返回编造的搜索结果）');
      console.log('   ✅ 未配置搜索 Key，web_search 未注册（不再返回编造的搜索结果）；lookup_order 已挂载');
    }

    // 6. 测试 SystemPromptBuilder 分段与 Tool Guidance 动态装配
    console.log('\n▶ [6/7] 测试 SystemPromptBuilder 分段与 Tool Guidance 注入...');
    const activeTools = registry.getTools();
    const builtPrompt = buildSystemPrompt(activeTools);
    console.log('   Prompt 总字数:', builtPrompt.length);
    console.log('   注入的 Guidance 片段验证:');

    const expectedGuidanceKeywords = [
      '【单号定位 - lookup_order】',
      '【数据库查询 - company_db_query】',
      '【代码检索 - search_code】',
      '【代码阅读 - read_file_lines】',
      '【任务看板 - todo_write】',
      '【向客服提问 - ask_user_question】',
      '【网页抓取 - web_fetch】',
      '【代码图谱 - codegraph_explore】',
      '【回复格式（面向客服）】',
    ];

    for (const kw of expectedGuidanceKeywords) {
      const present = builtPrompt.includes(kw);
      console.log(`   - ${kw}: ${present ? '✅ 已注入' : '❌ 缺失'}`);
      if (!present) {
        throw new Error(`System Prompt 缺少预期的 Tool Guidance: ${kw}`);
      }
    }

    console.log('\n======================================================');
    console.log('🎉 所有 P0/P1 工具与 System Prompt 验证全部顺利通过！');
    console.log('======================================================\n');
  } finally {
    server.close();
    if (fs.existsSync(TEST_AUDIT)) {
      fs.unlinkSync(TEST_AUDIT);
    }
  }
  // MCP SSE 长连接会让 server.close() 一直等待，测试通过后显式退出
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n❌ 测试失败:', err);
  process.exit(1);
});
