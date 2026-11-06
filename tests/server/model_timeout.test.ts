import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { BusinessModel, combineRunSignal, modelCallOptions } from '../../server/src/agent/model.ts';
import { AgentService } from '../../server/src/agent/service.ts';
import { AgentStore } from '../../server/src/agent/store.ts';
import { AuditLogger } from '../../server/src/auth.ts';

const config = { answerReviewTimeoutMs: 180000, modelCallTimeoutMs: 240000, geminiModel: 'gemini-3.8-flash-high', geminiReasoningEffort: 'high', codeRepoPath: '' } as any;
const audit = { log: () => {} } as any;
const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

/** 捕获 create 调用参数的假 OpenAI client：text 模式返回一段文本，hang 模式挂起到 abort 为止 */
function fakeClient(captured: Array<{ body: any; options: any }>, mode: 'text' | 'hang' = 'text') {
  return { chat: { completions: { create: async (body: any, options: any) => {
    captured.push({ body, options });
    if (mode === 'hang') await new Promise((_, reject) => {
      if (options.signal?.aborted) return reject(abortError());
      options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    return (async function* () {
      yield { choices: [{ delta: { content: '假模型回答' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    })();
  } } } };
}
const modelWith = (captured: Array<{ body: any; options: any }>, runSignal?: AbortSignal, mode: 'text' | 'hang' = 'text') =>
  new BusinessModel(config, 'gemini', audit, 'tester', runSignal, true, () => ({ client: fakeClient(captured, mode) as any, targetModel: 'gemini-3.8-flash' }));
test('普通调用显式带 modelCallTimeoutMs 与 maxRetries=1；复核调用用复核预算且不重试', async () => {
  const captured: Array<{ body: any; options: any }> = [];
  await modelWith(captured).streamChat([{ role: 'user', content: '查一下' }], [], () => {});
  assert.equal(captured[0].options.timeout, 240000);
  assert.equal(captured[0].options.maxRetries, 1);
  const reviewCaptured: Array<{ body: any; options: any }> = [];
  await modelWith(reviewCaptured).streamChat([{ role: 'user', content: '复核' }], [], () => {}, { signal: new AbortController().signal });
  assert.equal(reviewCaptured[0].options.timeout, 180000);
  assert.equal(reviewCaptured[0].options.maxRetries, 0);
  assert.deepEqual(modelCallOptions(true, config), { maxRetries: 0, timeout: 180000 });
  assert.deepEqual(modelCallOptions(false, config), { maxRetries: 1, timeout: 240000 });
});

test('combineRunSignal：两者都在时任一 abort 即取消，只存在一个时原样使用', () => {
  const a = new AbortController(), b = new AbortController();
  const both = combineRunSignal(a.signal, b.signal)!;
  assert.equal(both.aborted, false);
  a.abort();
  assert.equal(both.aborted, true);
  assert.equal(combineRunSignal(undefined, b.signal), b.signal);
  assert.equal(combineRunSignal(b.signal, undefined), b.signal);
  assert.equal(combineRunSignal(undefined, undefined), undefined);
});

test('运行级 runSignal 透传到模型请求，abort 后在途请求被取消', async () => {
  const captured: Array<{ body: any; options: any }> = [];
  const controller = new AbortController();
  const pending = modelWith(captured, controller.signal, 'hang').streamChat([{ role: 'user', content: '查' }], [], () => {});
  assert.equal(captured.length, 1);
  assert.equal(captured[0].options.signal?.aborted, false);
  controller.abort();
  await assert.rejects(pending, /aborted/i);
  assert.equal(captured[0].options.signal?.aborted, true);
});

test('service.abort() 之后 run() 在有限步数内结束，答案降级为待人工', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,timestamp,user,type,tool_name,model,prompt_tokens,completion_tokens,total_tokens,duration_ms,details,success,error)');
  const store = new AgentStore(db);
  const captured: Array<{ body: any; options: any }> = [];
  const service = new AgentService(store, config, new AuditLogger(db), { getActive: () => 'gemini' } as any,
    (owner, runSignal) => modelWith(captured, runSignal, 'hang'),
    () => ({ getTools: () => [], getTool: () => undefined, getRemoteSkills: () => [], registerLocal: () => {}, executeTool: async () => ({}) }) as any);
  try {
    const session = store.create('alice');
    const events: any[] = [];
    const done = new Promise<void>(resolve => service.start('alice', session.id, '核对资料', event => { events.push(event); if (event.type === 'done') resolve(); }));
    assert.equal(captured.length, 1);
    assert.equal(captured[0].options.signal?.aborted, false);
    assert.equal(service.abort('alice', session.id), true);
    await done;
    assert.equal(service.get('alice', session.id)!.turns[0].answer?.reviewStatus, 'needs_human');
    assert.equal(service.abort('alice', session.id), false, '已结束的运行不再可取消');
    assert.equal(service.abort('bob', session.id), false, '他人会话不可取消');
  } finally { db.close(); }
});

test('M3：调查与复核调用可独立设置思考档位（default 时不传）', async () => {
  const captured: Array<{ body: any; options: any }> = [];
  const cfg = { ...config, geminiReasoningEffort: 'high', reviewReasoningEffort: 'low' } as any;
  const model = new BusinessModel(cfg, 'gemini', audit, 'tester', undefined, true, () => ({ client: fakeClient(captured) as any, targetModel: 'gemini-3.8-flash' }));
  await model.streamChat([{ role: 'user', content: '调查' }], [], () => {});
  await model.streamChat([{ role: 'user', content: '复核' }], [], () => {}, { signal: new AbortController().signal });
  assert.equal(captured[0].body.reasoning_effort, 'high', '调查沿用 geminiReasoningEffort');
  assert.equal(captured[1].body.reasoning_effort, 'low', '复核用 reviewReasoningEffort');
  // 复核档位为 default 时不传 reasoning_effort；缺省 reviewReasoningEffort 时沿用调查档位
  const captured2: Array<{ body: any; options: any }> = [];
  const model2 = new BusinessModel({ ...cfg, reviewReasoningEffort: 'default' } as any, 'gemini', audit, 'tester', undefined, true, () => ({ client: fakeClient(captured2) as any, targetModel: 'gemini-3.8-flash' }));
  await model2.streamChat([{ role: 'user', content: '复核' }], [], () => {}, { signal: new AbortController().signal });
  assert.equal('reasoning_effort' in captured2[0].body, false);
  const captured3: Array<{ body: any; options: any }> = [];
  const cfgNoReview = { ...config, geminiReasoningEffort: 'high' } as any;
  delete (cfgNoReview as any).reviewReasoningEffort;
  const model3 = new BusinessModel(cfgNoReview, 'gemini', audit, 'tester', undefined, true, () => ({ client: fakeClient(captured3) as any, targetModel: 'gemini-3.8-flash' }));
  await model3.streamChat([{ role: 'user', content: '复核' }], [], () => {}, { signal: new AbortController().signal });
  assert.equal(captured3[0].body.reasoning_effort, 'high', '缺省复核档位时沿用调查档位');
});
