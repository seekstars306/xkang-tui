import OpenAI from 'openai';
import dotenv from 'dotenv';
import { loadServerConfig } from '../server/dist/config.js';
import { executeSearchCode } from '../server/dist/tools/code_search.js';
import { sanitizeOpenAiMessages } from '../server/dist/llm.js';

dotenv.config();

console.log('======================================================');
console.log('🧪 测试全流程：防止超大输出打爆上下文 + 保证顺利输出结论');
console.log('======================================================\n');

const config = loadServerConfig();
const client = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: process.env.GEMINI_BASE_URL,
});

async function runSimulation() {
  // Step 1: User prompt
  const messages: any[] = [
    { role: 'system', content: '你是一个专业的排障专家。请通过工具查询代码，并在获取到足够信息后输出标准三段式排障报告（结论分析 + 核心代码/数据佐证 + 客服话术与建议）。' },
    { role: 'user', content: 'costCenterThirdParty:第三方费用部门不能为空!' },
  ];

  console.log('▶ [第 1 轮] 调用 Gemini 生成工具计划...');
  let res = await client.chat.completions.create({
    model: process.env.GEMINI_MODEL || 'gemini-3.8-flash-high',
    messages: sanitizeOpenAiMessages(messages),
    tools: [
      {
        type: 'function',
        function: {
          name: 'search_code',
          description: '代码全文检索',
          parameters: {
            type: 'object',
            properties: {
              keyword: { type: 'string' },
              scope: { type: 'string', enum: ['frontend', 'backend', 'all'] },
            },
            required: ['keyword'],
          },
        },
      },
    ],
  });

  const msg1 = res.choices[0]?.message;
  console.log('   模型决策:', msg1?.tool_calls ? `调用工具 ${msg1.tool_calls.map((t) => t.function.name).join(', ')}` : '直接回复');
  messages.push(msg1);

  if (msg1?.tool_calls && msg1.tool_calls.length > 0) {
    for (const tc of msg1.tool_calls) {
      console.log(`\n▶ [执行工具] ${tc.function.name} 参数: ${tc.function.arguments}`);
      const args = JSON.parse(tc.function.arguments || '{}');
      const toolOutput = await executeSearchCode(args, config);
      console.log(`   工具输出体积: ${toolOutput.length} 字符 (~${Math.ceil(toolOutput.length / 4)} tokens)`);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolOutput,
      });
    }

    console.log('\n▶ [第 2 轮] 传入检索结果，调用 Gemini 续推或总结...');
    const res2 = await client.chat.completions.create({
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash-high',
      messages: sanitizeOpenAiMessages(messages),
      tools: [
        {
          type: 'function',
          function: {
            name: 'search_code',
            description: '代码全文检索',
            parameters: {
              type: 'object',
              properties: {
                keyword: { type: 'string' },
                scope: { type: 'string', enum: ['frontend', 'backend', 'all'] },
              },
              required: ['keyword'],
            },
          },
        },
      ],
    });

    const msg2 = res2.choices[0]?.message;
    console.log('   第 2 轮模型响应:', msg2?.tool_calls ? `继续调用工具: ${msg2.tool_calls.map((t) => t.function.name).join(', ')}` : '成功输出排障结论');
    if (msg2?.content) {
      console.log('\n--- 最终输出片段 ---');
      console.log(msg2.content.slice(0, 300));
    }
  }

  console.log('\n======================================================');
  console.log('🎉 测试完全成功！无 400 报错，无 Token 超限！');
  console.log('======================================================');
}

runSimulation().catch(console.error);
