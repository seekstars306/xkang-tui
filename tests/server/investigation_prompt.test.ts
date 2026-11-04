// 排查期提示词的分层守门（第 4 项）：
// 1) l2 里既有的工作原则 8（工单派生，已冻结）必须还在；
// 2) 新增的通用四步只进 l2，且排在工具指导之前；
// 3) l1 一句都不该有——grok 通道不加载内部工具，写进去只会浪费上下文。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SystemPromptBuilder, buildSystemPrompt, getPromptTierForModel } from '../../server/src/agent/investigation_prompt.ts';

const STEPS_HEADER = '【重复、并发类问题的排查步骤】';
const STEPS_ANCHORS = ['读判定分支', '数入口次数', '看输入是否本身重复', '还原真实时间'];
const FROZEN_RULE_8 = '重复、并发类怀疑必须读到判定分支';
// 工具指导只在传了 activeTools 时才注入，用它当「order 100+ 那一段」的位置基准
const TOOL_GUIDANCE_HEADER = '【单号定位 - lookup_order】';

test('l2 提示词含工作原则 8 与新增四步，且四步排在工具指导之前', () => {
  const prompt = buildSystemPrompt(undefined, undefined, 'l2');
  assert.ok(prompt.includes(FROZEN_RULE_8), 'l2 丢了工作原则 8（冻结条目 investigation.prompt.repeat_branch_rule）');
  assert.ok(prompt.includes(STEPS_HEADER), 'l2 缺新增的重复/并发排查步骤');
  for (const anchor of STEPS_ANCHORS) assert.ok(prompt.includes(anchor), `l2 缺步骤「${anchor}」`);
  assert.ok(prompt.indexOf('【工作原则】') < prompt.indexOf(STEPS_HEADER), '四步应排在角色定义与工作原则之后');
  // 工具指导只在传了 activeTools 时注入，所以顺序要在带工具的那次构建上比
  const withTools = buildSystemPrompt([{ name: 'lookup_order' } as any], undefined, 'l2');
  const guidanceAt = TOOL_GUIDANCE_HEADER ? withTools.indexOf(TOOL_GUIDANCE_HEADER) : -1;
  assert.ok(guidanceAt > 0, `未找到工具指导标题（${TOOL_GUIDANCE_HEADER}），顺序断言失效`);
  assert.ok(withTools.indexOf(STEPS_HEADER) < guidanceAt, '四步应排在工具指导（order 100+）之前');
});

test('l1 提示词不含工作原则 8 也不含新增四步', () => {
  const prompt = buildSystemPrompt(undefined, undefined, 'l1');
  assert.ok(!prompt.includes(FROZEN_RULE_8));
  assert.ok(!prompt.includes(STEPS_HEADER));
});

test('带截图的 l2 同时注入截图规则与四步，且四步不受截图影响', () => {
  const prompt = buildSystemPrompt(undefined, undefined, 'l2', { hasImages: true });
  assert.ok(prompt.includes('【截图排障规则（本轮消息带有截图）】'));
  assert.ok(prompt.includes(STEPS_HEADER));
});

test('四步在 l2 上只出现一次（同名 section 反复注册按替换处理，不叠加）', () => {
  const builder = new SystemPromptBuilder({ tier: 'l2' });
  assert.equal(builder.build().split(STEPS_HEADER).length - 1, 1, '构造器应把四步只注册一次');
  // addSection 以 name 为键（sections.set），同名注册是替换而非追加：这里把语义钉死，避免将来改成数组后静默叠加
  builder.addSection({ name: 'persona:investigation_steps:repeat_and_concurrency', order: 86, text: '(同名重复注册)' });
  const prompt = builder.build();
  assert.equal(prompt.split(STEPS_HEADER).length - 1, 0, '同名注册应替换旧文本，不应叠加成两段');
  assert.equal(prompt.split('(同名重复注册)').length - 1, 1);
  assert.ok(!prompt.includes(STEPS_ANCHORS[0]), '替换后旧四步内容不应残留');
});

test('模型到档位的映射不变：grok 走 l1，其余走 l2', () => {
  assert.equal(getPromptTierForModel('grok-4'), 'l1');
  assert.equal(getPromptTierForModel('gemini-3.8-flash'), 'l2');
  assert.equal(getPromptTierForModel(undefined), 'l2');
});

test('G3③ 消融开关：ruleLayer:false 不注册四步，工作原则 8 与工具指导不受影响', () => {
  const tools = [{ name: 'lookup_order' } as any];
  const off = buildSystemPrompt(tools, undefined, 'l2', { ruleLayer: false });
  assert.ok(!off.includes(STEPS_HEADER), '关闭时不该注册四步');
  assert.ok(off.includes(FROZEN_RULE_8), '消融只关第 4 项新增的两段，冻结的工作原则 8 必须保留');
  assert.ok(off.includes(TOOL_GUIDANCE_HEADER), '工具指导不受影响');
  // 显式 true 与缺省（env 未设）都必须注册：否则上面的 !includes 可能是"本来就没注册"而假通过
  assert.ok(buildSystemPrompt(tools, undefined, 'l2', { ruleLayer: true }).includes(STEPS_HEADER));
  assert.ok(buildSystemPrompt(tools, undefined, 'l2').includes(STEPS_HEADER), '未设 RULE_LAYER 时应为开启');
});
