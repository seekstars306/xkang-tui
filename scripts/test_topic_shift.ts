import { classifyRequest } from '../server/src/model_state.js';

console.log('======================================================');
console.log('🧪 开始测试多轮对话中的【话题切换】与【上下文关联】判定');
console.log('======================================================\n');

// 模拟一个首轮包含截图/图片与 company_db_query 的复杂历史上下文
const historyWithDeepTools = [
  { role: 'system', content: '你是一个排障助手...' },
  {
    role: 'user',
    content: [
      { type: 'text', text: '请分析这张报错截图中的问题' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR...' } },
    ],
  },
  {
    role: 'assistant',
    content: '正在查询数据库与代码...',
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'company_db_query',
          arguments: '{"sql":"SELECT * FROM skt.business_trip_application"}',
        },
      },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'call_1',
    content: '[{"id":1,"applicant_name":"刘丹"}]',
  },
  {
    role: 'assistant',
    content: '排障分析完毕：该报错由于第三方费用部门字段为空导致。',
  },
];

const testCases = [
  {
    name: '1. 复杂排障历史后，用户提问独立日常【今天有什么大新闻】',
    messages: [
      ...historyWithDeepTools,
      { role: 'user', content: '今天有什么大新闻' },
    ],
    expectedModel: 'grok',
    expectedTier: 'l1',
    expectedRule: 'DEFAULT_L1',
  },
  {
    name: '2. 复杂排障历史后，用户提问独立日常【人类是什么动物】',
    messages: [
      ...historyWithDeepTools,
      { role: 'user', content: '人类是什么动物' },
    ],
    expectedModel: 'grok',
    expectedTier: 'l1',
    expectedRule: 'DEFAULT_L1',
  },
  {
    name: '3. 复杂排障历史后，用户提问独立日常【哪种水果最好吃】',
    messages: [
      ...historyWithDeepTools,
      { role: 'user', content: '哪种水果最好吃' },
    ],
    expectedModel: 'grok',
    expectedTier: 'l1',
    expectedRule: 'DEFAULT_L1',
  },
  {
    name: '4. 复杂排障历史后，用户提问【你认为橘子好吃还是橙子】',
    messages: [
      ...historyWithDeepTools,
      { role: 'user', content: '你认为橘子好吃还是橙子' },
    ],
    expectedModel: 'grok',
    expectedTier: 'l1',
    expectedRule: 'DEFAULT_L1',
  },
  {
    name: '5. 历史排障后开启通用工具调用【今天有什么大新闻】-> 调用 web_search，多步执行中仍应保持 L1',
    messages: [
      ...historyWithDeepTools,
      { role: 'user', content: '今天有什么大新闻' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_web_1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"今日头条新闻"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_web_1',
        content: '搜索到3条新闻...',
      },
    ],
    expectedModel: 'grok',
    expectedTier: 'l1',
    expectedRule: 'DEFAULT_L1',
  },
  {
    name: '6. 包含图片的历史排障后，关联代词追问【那刘丹的那笔单据呢？】',
    messages: [
      ...historyWithDeepTools,
      { role: 'user', content: '那刘丹的那笔单据呢？' },
    ],
    expectedModel: 'gemini',
    expectedTier: 'l2',
    expectedRule: 'CONTEXT_CONTINUATION',
  },
  {
    name: '7. 包含图片的历史排障后，关联因果追问【为什么第三方费用部门会为空？】',
    messages: [
      ...historyWithDeepTools,
      { role: 'user', content: '为什么第三方费用部门会为空？' },
    ],
    expectedModel: 'gemini',
    expectedTier: 'l2',
    expectedRule: 'CONTEXT_CONTINUATION',
  },
  {
    name: '8. 用户表达不满/纠错【不对，分析错了】',
    messages: [
      ...historyWithDeepTools,
      { role: 'user', content: '不对，分析错了' },
    ],
    expectedModel: 'gemini',
    expectedTier: 'l2',
    expectedRule: 'USER_CORRECTION_DISSATISFACTION',
  },
];

let passed = 0;
for (const tc of testCases) {
  const result = classifyRequest(tc.messages, undefined, 'auto');
  const isMatchModel = result.targetModel === tc.expectedModel;
  const isMatchTier = result.tier === tc.expectedTier;
  const isMatchRule = tc.expectedRule ? result.matchedRule === tc.expectedRule : true;

  if (isMatchModel && isMatchTier && isMatchRule) {
    console.log(`✅ [PASS] ${tc.name}`);
    console.log(`   调度模型: ${result.targetModel} [${result.tier.toUpperCase()} | ${result.matchedRule}]`);
    console.log(`   判断原因: ${result.reason}\n`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${tc.name}`);
    console.error(`   期望: model=${tc.expectedModel}, tier=${tc.expectedTier}, rule=${tc.expectedRule || 'any'}`);
    console.error(`   实际: model=${result.targetModel}, tier=${result.tier}, rule=${result.matchedRule}`);
    console.error(`   原因: ${result.reason}\n`);
  }
}

console.log(`======================================================`);
console.log(`测试完成: ${passed} / ${testCases.length} 通过`);
console.log(`======================================================`);

if (passed !== testCases.length) {
  process.exit(1);
}
