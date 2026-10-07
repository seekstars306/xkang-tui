import OpenAI from 'openai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { buildSystemPrompt, getPromptTierForModel, PromptTier } from './src/harness/system_prompt.js';
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

async function getActiveModelInfo(): Promise<{ model: string; tier: PromptTier }> {
  try {
    const res = await fetch('http://localhost:8600/admin/model', {
      headers: { Authorization: 'Bearer admin_secret_token_123' },
    });
    if (res.ok) {
      const data: any = await res.json();
      return {
        model: data.activeModel || 'gemini',
        tier: data.activeProfile?.promptTier || getPromptTierForModel(data.activeModel),
      };
    }
  } catch {}
  return { model: 'gemini', tier: 'l2' };
}

async function runAgentTroubleshooting() {
  const { model, tier } = await getActiveModelInfo();
  console.log('=====================================================');
  console.log(`🤖 开始端到端排障测试: 模型=[${model}], 提示词分级=[${tier.toUpperCase()}]`);
  console.log('=====================================================\n');

  const systemPrompt = buildSystemPrompt(
    tools.map((t) => ({ name: t.name, description: t.description, schema: {} as any })),
    [],
    tier
  );

  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content:
        '宋肖肖 18053271039 这个人三月的账单，支付的时候多了一个7.5的退票费。请帮我排查是哪个订单产生的、为什么会有这个费用？',
    },
  ];

  let turn = 0;
  const maxTurns = 25;

  while (turn < maxTurns) {
    turn++;
    console.log(`\n================== [Turn ${turn}] 调用模型 ==================`);

    const stream = await openai.chat.completions.create({
      model: 'xkang-managed',
      messages,
      tools: openaiTools,
      tool_choice: 'auto',
      stream: true,
      temperature: 0.1,
    });

    let fullContent = '';
    let reasoningContent = '';
    const toolCallsMap: Record<number, { id: string; name: string; args: string }> = {};

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if ((delta as any).reasoning_content) {
        reasoningContent += (delta as any).reasoning_content;
      }
      if (delta.content) {
        fullContent += delta.content;
      }
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

    if (reasoningContent) {
      console.log(`\n[思考过程 (${reasoningContent.length} 字符)]:\n${reasoningContent.slice(0, 300)}...\n`);
    }

    if (fullContent) {
      console.log(`\n[模型输出内容]:\n${fullContent}\n`);
    }

    // Push assistant message
    const assistantMsg: any = { role: 'assistant' };
    if (fullContent) assistantMsg.content = fullContent;
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls.map((tc) => ({
        id: tc.id || `call_${Math.random().toString(36).substring(2, 9)}`,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.args,
        },
      }));
    }
    messages.push(assistantMsg);

    if (toolCalls.length === 0) {
      console.log('✅ 模型完成排障，给出了最终结论。');
      break;
    }

    console.log(`[模型发起 ${toolCalls.length} 个工具调用]:`);

    for (const toolCall of assistantMsg.tool_calls) {
      const fnName = toolCall.function.name;
      let fnArgs: any = {};
      try {
        fnArgs = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        fnArgs = toolCall.function.arguments;
      }
      console.log(`  👉 工具: ${fnName}`);
      console.log(`     参数: ${JSON.stringify(fnArgs)}`);

      const targetTool = tools.find((t) => t.name === fnName);
      let toolResult = '';
      if (targetTool) {
        try {
          toolResult = await targetTool.execute(fnArgs, config, 'test-agent-user');
          console.log(`     结果: ${toolResult.slice(0, 300).replace(/\n/g, ' ')}...`);
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

  console.log('\n=====================================================');
  console.log('🏁 排障测试全流程结束');
  console.log('=====================================================');
}

runAgentTroubleshooting().catch((err) => {
  console.error('测试异常:', err);
});
