import OpenAI from 'openai';
import dotenv from 'dotenv';
import { buildSystemPrompt } from '../dist/harness/system_prompt.js';
import { LOCAL_TOOLS } from '../dist/tools/index.js';

dotenv.config();

console.log('======================================================');
console.log('🧪 测试环境快照注入：L1 (Grok) 直接引用真实本机环境作答');
console.log('======================================================\n');

const client = new OpenAI({
  apiKey: process.env.GROK_API_KEY,
  baseURL: process.env.GROK_BASE_URL,
});

async function testGrokEnvQuery(question: string) {
  const l1Prompt = buildSystemPrompt(LOCAL_TOOLS, [], 'l1');

  // 确认快照已注入
  const hasSnapshot = l1Prompt.includes('当前运行环境快照') && l1Prompt.includes('10.197.15.89');
  console.log(`系统提示词包含真实环境快照: ${hasSnapshot ? '✅' : '❌'}`);

  const messages: any[] = [
    { role: 'system', content: l1Prompt },
    { role: 'user', content: question },
  ];

  const tools = LOCAL_TOOLS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as any,
    },
  }));

  console.log(`\n▶ 提问: "${question}"`);
  const res = await client.chat.completions.create({
    model: process.env.GROK_MODEL || 'grok-4.6-medium',
    messages,
    tools,
    tool_choice: 'auto',
  });

  const choice = res.choices[0]?.message;
  if (choice?.tool_calls && choice.tool_calls.length > 0) {
    console.log('模型选择调用工具:', choice.tool_calls.map((t) => `${t.function.name}(${t.function.arguments})`).join(', '));
  } else {
    const content = choice?.content || '';
    console.log('模型直接回答:\n', content.slice(0, 500));
    const mentionsRealIp = content.includes('10.197.15.89');
    const mentionsFakeIp = /\b127\.0\.0\.1\b|\b10\.0\.0\.2\b|\b192\.168\.1\.1\b/.test(content);
    console.log('\n引用真实局域网 IP (10.197.15.89):', mentionsRealIp ? '✅' : '❌');
    console.log('包含臆造占位 IP:', mentionsFakeIp ? '❌ 存在' : '✅ 无');
  }
}

await testGrokEnvQuery('我本地网络ip是多少');
await testGrokEnvQuery('现在几点了？我这台电脑主机名叫什么？');
