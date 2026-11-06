/**
 * 规则层的运行时开关，只用于 G3③ 消融对照（docs/exec-plan-v3/09-g3-budget-rule-ablation.md）。
 *
 * 为什么必须是"运行时门控"而不是改文本：两段规则文本都登记在 tests/eval/frozen-rules.json
 * （investigation.prompt.repeat_steps / review.directed_followup），tests/server/rule_freeze.test.ts
 * 按逐字 anchor 守门——把文本从源码里删掉会直接让测试变红。开关只拦"注册 / 追加"这一步。
 *
 * 语义：只认一个 env `RULE_LAYER`，`off` / `0` / `false` 为关闭，其余（含未设置）为开启。
 * 关闭时同时作用于两处：排查期 l2 的四步 section 不注册、复核修订轮的【定向补查】不追加。
 * 一个开关管两处是刻意的：分两个 env 会让对照臂只关掉一半却不报错，分布比对就没意义了。
 */
export function ruleLayerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(env.RULE_LAYER ?? '').trim().toLowerCase();
  return !(value === 'off' || value === '0' || value === 'false');
}
