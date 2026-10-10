import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequest, isHarnessReminderText } from '../../server/src/model_state.ts';
import { sanitizeOpenAiMessages, applyL1SystemPrompt } from '../../server/src/llm.ts';

const BOTH_ON = { enableL1: true, enableL2: true };

describe('classifyRequest 路由', () => {
  test('当前生产配置（ENABLE_L1=0）全部走 L2', () => {
    const r = classifyRequest([{ role: 'user', content: '你好' }], [], 'auto', { enableL1: false, enableL2: true });
    assert.equal(r.tier, 'l2');
    assert.equal(r.targetModel, 'gemini');
  });

  test('管理员锁定的模型优先于 ENABLE_L1/ENABLE_L2 开关（以前 ENABLE_L1=0 时切换到 deepseek 会被静默忽略）', () => {
    const r = classifyRequest([{ role: 'user', content: '你好' }], [], 'deepseek', { enableL1: false, enableL2: true });
    assert.equal(r.targetModel, 'deepseek');
    assert.equal(r.tier, 'l2');
    const esc = classifyRequest([{ role: 'user', content: '<system-reminder>[[ESCALATE_TO_L2]]</system-reminder>' }], [], 'deepseek', { enableL1: true, enableL2: true });
    assert.equal(esc.targetModel, 'deepseek', '锁定的 L2 模型在升级时沿用');
  });

  test('关闭 L2 时升级标记不会把请求送到被关闭的 L2', () => {
    const r = classifyRequest([{ role: 'user', content: '<system-reminder>[[ESCALATE_TO_L2]]</system-reminder>' }], [], 'auto', { enableL1: true, enableL2: false });
    assert.equal(r.tier, 'l1');
  });

  test('会话已使用公司排障工具时，"继续"之类的追问保持在 L2（粘性路由）', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '1541491413412347905 出单异常' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup_order', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'lookup_order', content: '...' },
      { role: 'assistant', content: '结论...' },
      { role: 'user', content: '继续' },
    ];
    const r = classifyRequest(messages, [], 'auto', BOTH_ON);
    assert.equal(r.tier, 'l2');
    assert.equal(r.matchedRule, 'CONVERSATION_STICKY_L2');
  });

  test('判断关键词时跳过 harness 注入的提醒（新旧格式）', () => {
    const messages = [
      { role: 'user', content: '帮我查下这个订单为什么退款失败' },
      { role: 'assistant', content: '' },
      { role: 'user', content: '<system-reminder>\n你上一轮没有输出任何内容。\n</system-reminder>' },
    ];
    assert.equal(classifyRequest(messages, [], 'auto', BOTH_ON).tier, 'l2');
    assert.equal(isHarnessReminderText('<system-reminder>x</system-reminder>'), true);
    assert.equal(isHarnessReminderText('【排查提示】若业务表中数据不足'), true);
    assert.equal(isHarnessReminderText('退款失败了'), false);
  });

  test('升级标记、截图、单号与普通问答的路由', () => {
    assert.equal(classifyRequest([{ role: 'user', content: '<system-reminder>[[ESCALATE_TO_L2]] 请处理</system-reminder>' }], [], 'auto', BOTH_ON).matchedRule, 'L1_ESCALATION');
    assert.equal(
      classifyRequest([{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }], [], 'auto', BOTH_ON).tier,
      'l2'
    );
    assert.equal(classifyRequest([{ role: 'user', content: '1541491413412347905' }], [], 'auto', BOTH_ON).matchedRule, 'BUSINESS_ID_DETECTED');
    assert.equal(classifyRequest([{ role: 'user', content: '帮我写一首诗' }], [], 'auto', BOTH_ON).tier, 'l1');
  });
});

describe('LLM 代理消息清洗', () => {
  test('保留工具调用上的 extra_content（如 Gemini thought_signature）', () => {
    const out = sanitizeOpenAiMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_code', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG' } } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r' },
    ]);
    const assistant = out.find((m) => m.role === 'assistant');
    assert.deepEqual(assistant.tool_calls[0].extra_content, { google: { thought_signature: 'SIG' } });
  });

  test('缺失的工具结果自动补齐，首条对话消息为 user', () => {
    const out = sanitizeOpenAiMessages([
      { role: 'assistant', content: 'orphan' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'user', content: 'next' },
    ]);
    assert.equal(out[0].role, 'user');
    assert.ok(out.some((m) => m.role === 'tool' && m.tool_call_id === 'c1'));
  });

  test('路由到 L1 时替换为带升级协议的 L1 提示词', () => {
    const msgs: any[] = [
      { role: 'system', content: 'L2 prompt' },
      { role: 'system', content: 'another' },
      { role: 'user', content: 'q' },
    ];
    applyL1SystemPrompt(msgs);
    assert.equal(msgs.filter((m) => m.role === 'system').length, 1);
    assert.match(msgs[0].content, /\[\[ESCALATE_TO_L2\]\]/);
    assert.doesNotMatch(msgs[0].content, /read_file_lines/);
  });
});
