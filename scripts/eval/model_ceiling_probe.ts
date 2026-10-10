import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { loadServerEnv } from '../../tests/helpers/isolated_server.ts';
import { collectChatStream, formatModelMessages } from '@xkang/agent-core/protocol';
import { sanitizeOpenAiMessages } from '../../server/src/llm.ts';

const out = path.resolve(process.argv[2] || 'tests/eval/reports/model-ceiling-20261009/probe-local');
if (fs.existsSync(out)) throw new Error('Preserve earlier probe output');
fs.mkdirSync(out, { recursive: true });
const env = loadServerEnv();
const client = new OpenAI({ apiKey: env.DEEPSEEK_API_KEY, baseURL: env.DEEPSEEK_BASE_URL, maxRetries: 0, timeout: 90000 });
const prompt = '一项规则先令费用为12。若会员则改成0，否则若加急改成25。之后若加急且重量大于10再加5；若免运券且非会员再减3，但最低为0。问：会员、加急、重量11、有免运券的最终费用是多少？只返回JSON：{"amount":数字}。';
const jobs = [
  { id: 'k3', model: 'kimi-k3', effort: 'high' },
  { id: 'glm53', model: 'glm-5.3', effort: 'high' },
  { id: 'glm53flash', model: 'glm-5.3-flash', effort: 'high' },
  { id: 'dsv41f', model: 'deepseek-v4.1-flash', effort: 'high' },
] as const;
const results: unknown[] = [];
for (const job of jobs) {
  for (const round of [1, 2]) {
    const started = Date.now(), chunks: unknown[] = [];
    let result: any;
    try {
      const stream = await client.chat.completions.create({ model: job.model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' },
        ...(job.effort ? { reasoning_effort: job.effort } : {}), stream: true, stream_options: { include_usage: true } });
      let content = '', reasoningChars = 0, usage: unknown, returnedModel: string | undefined, finish: string | undefined;
      for await (const chunk of stream) {
        chunks.push(chunk); returnedModel = chunk.model || returnedModel;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices[0];
        content += choice?.delta.content || '';
        reasoningChars += ((choice?.delta as any)?.reasoning_content || '').length;
        finish = choice?.finish_reason || finish;
      }
      result = { ...job, round, seconds: Math.round((Date.now() - started) / 1000), content, reasoningChars, usage, returnedModel, finish };
    } catch (error: any) { result = { ...job, round, seconds: Math.round((Date.now() - started) / 1000), error: error.message, status: error.status }; }
    fs.writeFileSync(path.join(out, `${job.id}-${round}.json`), JSON.stringify({ result, prompt, chunks }, null, 2));
    results.push(result); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(result));
  }
  const tool = { type: 'function' as const, function: { name: 'read_policy', description: '读取演示规则', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } };
  const history: any[] = [{ role: 'user', content: '必须先调用read_policy读取DEMO规则，再按工具返回说明金额。最后只输出JSON。' }];
  const chunks: any[] = []; const started = Date.now(); let result: any;
  try {
    for (let turn = 0; turn < 2; turn++) {
      const stream = await client.chat.completions.create({ model: job.model, reasoning_effort: job.effort,
        messages: sanitizeOpenAiMessages(formatModelMessages(history)), tools: [tool], response_format: { type: 'json_object' }, stream: true, stream_options: { include_usage: true } });
      const recorded = (async function* () { for await (const chunk of stream) { chunks.push(chunk); yield chunk; } })();
      const response = await collectChatStream(recorded, () => {}); history.push(response);
      if (turn === 0) {
        if (!response.tool_calls?.length) throw new Error('Model did not call the required tool');
        for (const call of response.tool_calls) history.push({ role: 'tool', name: call.name, tool_call_id: call.id, content: 'DEMO规则：普通件金额12元；加急件25元。当前为普通件。' });
      } else if (response.tool_calls?.length || response.finishReason !== 'stop') throw new Error('Model did not finish after tool result');
    }
    result = { id: job.id, kind: 'tool_roundtrip', supported: true, seconds: Math.round((Date.now() - started) / 1000), response: history.at(-1).content };
  } catch (error: any) { result = { id: job.id, kind: 'tool_roundtrip', supported: false, seconds: Math.round((Date.now() - started) / 1000), error: error.message, status: error.status }; }
  fs.writeFileSync(path.join(out, `${job.id}-tools.json`), JSON.stringify({ result, history, chunks }, null, 2));
  results.push(result); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(result));
}
