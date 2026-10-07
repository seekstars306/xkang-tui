import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createCompanyTools } from './server/src/tools/index.js';
import { loadServerConfig } from './server/src/config.js';

const config = loadServerConfig();
const tools = createCompanyTools(config);

const openai = new OpenAI({
  apiKey: 'tok_dev_001',
  baseURL: 'http://localhost:8600/v1',
});

// Format tools using standard zodToJsonSchema
const openaiTools = tools.map((t) => {
  const jsonSchema = zodToJsonSchema(t.schema, { target: 'openAi' }) as any;
  return {
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: jsonSchema,
    },
  };
});

async function runTask(taskName: string, prompt: string, enableTools = false): Promise<string> {
  console.log(`\n======================================================`);
  console.log(`▶ 开始测试任务: 【${taskName}】`);
  console.log(`======================================================`);

  const messages: any[] = [
    {
      role: 'system',
      content: '你是一个高效、精准的业务支持与数据处理专家。请严格按照用户指令与格式要求完成任务。',
    },
    { role: 'user', content: prompt },
  ];

  let turn = 0;
  const maxTurns = 8;
  let finalAnswer = '';

  while (turn < maxTurns) {
    turn++;
    console.log(`[Turn ${turn}] 调用 Grok...`);

    const stream = await openai.chat.completions.create({
      model: 'xkang-managed',
      messages,
      tools: enableTools ? openaiTools : undefined,
      tool_choice: enableTools ? 'auto' : undefined,
      stream: true,
      temperature: 0.1,
    });

    let fullContent = '';
    const toolCallsMap: Record<number, { id: string; name: string; args: string }> = {};

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) fullContent += delta.content;
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallsMap[idx]) {
            toolCallsMap[idx] = { id: tc.id || '', name: tc.function?.name || '', args: '' };
          }
          if (tc.id) toolCallsMap[idx].id = tc.id;
          if (tc.function?.name) toolCallsMap[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCallsMap[idx].args += tc.function.arguments;
        }
      }
    }

    const toolCalls = Object.values(toolCallsMap);

    const assistantMsg: any = { role: 'assistant' };
    if (fullContent) assistantMsg.content = fullContent;
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls.map((tc) => ({
        id: tc.id || `call_${Math.random().toString(36).substring(2, 9)}`,
        type: 'function',
        function: { name: tc.name, arguments: tc.args },
      }));
    }
    messages.push(assistantMsg);

    if (toolCalls.length === 0) {
      finalAnswer = fullContent;
      console.log(`✅ 任务完成，轮次: ${turn}`);
      break;
    }

    console.log(`  👉 Grok 发起 ${toolCalls.length} 个工具调用:`);
    for (const toolCall of assistantMsg.tool_calls) {
      const fnName = toolCall.function.name;
      let fnArgs: any = {};
      try {
        fnArgs = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        fnArgs = toolCall.function.arguments;
      }
      console.log(`     工具: ${fnName}, 参数: ${JSON.stringify(fnArgs)}`);

      const targetTool = tools.find((t) => t.name === fnName);
      let toolResult = '';
      if (targetTool) {
        try {
          toolResult = await targetTool.execute(fnArgs, config, 'test-grok-eval');
          console.log(`     结果: ${toolResult.slice(0, 150).replace(/\n/g, ' ')}...`);
        } catch (e: any) {
          toolResult = `[执行报错] ${e.message}`;
          console.log(`     报错: ${toolResult}`);
        }
      } else {
        toolResult = `[错误] 未知工具: ${fnName}`;
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
  }

  return finalAnswer;
}

async function main() {
  console.log('=====================================================');
  console.log('🧪 Grok 通用能力专项评测（对比文件 / 批量改表 / 检索新闻）');
  console.log('=====================================================\n');

  // 1. 测试任务 1：对比两个配置文件/文本文件
  const task1Prompt = `
请对比以下两个版本的 application-prod.properties 配置文件，找出所有差异点：

【文件 A: v1.0.properties】
server.port=8080
spring.datasource.url=jdbc:mysql://10.10.1.10:3306/db_user
spring.datasource.username=root
spring.datasource.password=123456
app.timeout.seconds=30
app.features.enable-refund=false
app.max-retry=3

【文件 B: v2.0.properties】
server.port=8090
spring.datasource.url=jdbc:mysql://10.10.1.10:3306/db_user_v2
spring.datasource.username=app_user
spring.datasource.password=123456
app.timeout.seconds=60
app.features.enable-refund=true
app.features.enable-sms=true
app.jwt.secret=skt_secret_key_888

请按如下格式输出对比报告：
1. 【修改的配置项】：列出配置名、旧值(v1.0) -> 新值(v2.0)
2. 【新增的配置项】：列出新配置名及取值
3. 【删除的配置项】：列出被移除的配置项（如有）
4. 【总结与风险提示】：用 1-2 句话提示升级可能带来的影响（如端口变更、库名变更）。
`;

  const task1Result = await runTask('1. 对比两个配置文件', task1Prompt, false);
  console.log('\n--- 任务 1 Grok 最终输出 ---');
  console.log(task1Result);

  // 2. 测试任务 2：批量更改 Excel / 表格中某种条件下的数据
  const task2Prompt = `
我有一个员工报销明细表（CSV格式），请帮我进行批量数据处理：

【原始表格数据】
id,employee_name,department,expense_type,amount,status,tax_amount
101,张三,研发部,差旅费,620.00,待审批,0.00
102,李四,市场部,餐饮费,350.00,待审批,0.00
103,王五,研发部,办公用品,480.00,待审批,0.00
104,赵六,研发部,软件订阅,1200.00,待审批,0.00
105,孙七,运营部,差旅费,800.00,待审批,0.00
106,周八,研发部,云服务器,3000.00,待审批,0.00

【批量修改规则】
1. 筛选条件：凡是【department 为 "研发部"】且【amount > 500】的记录：
   - 将 status 批量更改为 "已自动核准"
   - 计算税额 tax_amount = amount * 0.06（保留2位小数）
2. 其余不满足条件的记录保持原样不变。
3. 请直接输出处理完成后的完整 CSV 表格内容（包含表头），并在下方统计：
   - 本次共修改了多少条记录？
   - 修改记录的累计金额与累计税额各是多少？
`;

  const task2Result = await runTask('2. 批量修改表格数据', task2Prompt, false);
  console.log('\n--- 任务 2 Grok 最终输出 ---');
  console.log(task2Result);

  // 3. 测试任务 3：新闻与实时信息检索
  const task3Prompt = `
请使用 web_search 工具搜索今日最新的科技与 AI 行业新闻，或者直接总结当前最新的 3 条重大科技资讯，要求：
1. 给出新闻标题
2. 给出 50 字以内的核心内容摘要
3. 给出该事件对行业的影响简析
`;

  const task3Result = await runTask('3. 每日科技新闻检索与总结', task3Prompt, true);
  console.log('\n--- 任务 3 Grok 最终输出 ---');
  console.log(task3Result);

  console.log('\n=====================================================');
  console.log('🏁 全部 3 项通用任务测试执行完毕');
  console.log('=====================================================');
}

main().catch(console.error);
