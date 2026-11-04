import { sanitizeOpenAiMessages } from '../server/src/llm.js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

console.log('======================================================');
console.log('🧪 测试 1: 复杂消息序列清洗与防 400 校验');
console.log('======================================================\n');

// 模拟容易触发 400 错误的各种异常历史序列
const messyMessages = [
  { role: 'system', content: '系统提示词' },
  { role: 'tool', tool_call_id: 'orphan_tool_1', content: '孤立 tool 消息' },
  { role: 'user', content: 'costCenterThirdParty:第三方费用部门不能为空!' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call_1', function: { name: 'todo_write', arguments: '{"todos":[]}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'call_1', name: 'todo_write', content: '看板已更新' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call_2', function: { name: 'search_code', arguments: '{"keyword":"costCenterThirdParty"}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'call_2', name: 'search_code', content: 'BusinessTripApplicationMapper.xml: line 13' },
  { role: 'assistant', content: '' }, // 空白 assistant 消息
  { role: 'user', content: '请根据前面工具调用的检索结果，直接输出结构化三段式排障报告。' },
];

const cleaned = sanitizeOpenAiMessages(messyMessages);
console.log('清洗后的消息数量:', cleaned.length);
console.log('清洗后的角色顺序:', cleaned.map((m) => `${m.role}${m.tool_calls ? '(tools)' : ''}`));

console.log('\n======================================================');
console.log('🧪 测试 2: 真实请求 Gemini 上游验证是否报 400');
console.log('======================================================\n');

const client = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: process.env.GEMINI_BASE_URL,
});

async function testUpstream() {
  try {
    const res = await client.chat.completions.create({
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash-high',
      messages: cleaned,
      tools: [
        {
          type: 'function',
          function: {
            name: 'search_code',
            description: 'search',
            parameters: {
              type: 'object',
              properties: { keyword: { type: 'string' } },
              required: ['keyword'],
            },
          },
        },
      ],
    });

    console.log('✅ Gemini 上游调用成功！无 400 报错！');
    console.log('模型返回角色:', res.choices[0]?.message?.role);
    console.log('模型返回内容摘要:', (res.choices[0]?.message?.content || '').slice(0, 150));
    console.log('\n🎉 测试完全通过！');
  } catch (err) {
    console.error('❌ 上游依然报错:', err);
    process.exit(1);
  }
}

testUpstream();
