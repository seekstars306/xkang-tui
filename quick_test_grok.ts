import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'g2a_324a41cef63d_bO1cMeFYS7XfSeIm84jBB0-Q6x2iLM04',
  baseURL: 'http://34.220.149.219:8000/v1',
  timeout: 30000,
});

const models = ['grok-4.6-low', 'grok-4.6-medium', 'grok-4.6-high', 'grok-4.6-xhigh'];

async function test() {
  console.log('开始探测 4 个模型级别...');
  for (const m of models) {
    const t0 = Date.now();
    try {
      const res = await client.chat.completions.create({
        model: m,
        messages: [{ role: 'user', content: '计算 123 * 456 + 789 并只输出数字结果' }],
        temperature: 0.1,
      });
      const t1 = Date.now();
      console.log(`✅ [${m}] 成功 (${t1 - t0}ms):`, res.choices[0]?.message?.content?.trim());
    } catch (e: any) {
      console.error(`❌ [${m}] 失败:`, e?.message || e);
    }
  }
}

test().catch(console.error);
