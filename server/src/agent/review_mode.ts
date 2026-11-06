/**
 * 复核模式开关 REVIEW_MODE（2026-10-29）：gate（默认）/ advisory / off。
 *
 * 为什么要这个开关：同模型同工具的盲评对照（deepseek，五单）里，挂上现在的复核后要点得分从 0.47 降到 0.37、
 * "能直接用"从 2.7 降到 2.2（肯定说错的句子从 1.3 降到 0.4）。损失主要发生在发布环节：修订稿里本来写对的成因
 * 被逐句裁剪、挪进"待确认（证据不足 / 复核反证阶段提出异议 / 引文未通过自动核对）"，结论只剩"其余事项仍需核实"。
 * 所以先测"复核照常提意见、但不裁剪草稿"的 advisory；仍然倒退就用 off 撤掉复核。
 *
 * - gate（未设置时）：现有行为。发给模型的内容、发布结果、事件都与引入开关前逐字节一致
 *   （tests/server/review_mode.test.ts 用改动前代码生成的 golden 守门）。
 * - advisory：复核照常运行、照常把问题打回给模型修订（次数、时限、L3→L2 降级都不变），只改最后的发布：
 *   复核通过时与 gate 相同；复核没通过就收尾（修订次数用完、复核服务不可用、超时/冻结）时，发布最后一稿草稿的完整内容，
 *   把最后一轮复核仍未解决的问题精简后追加到待确认事项，reviewStatus=needs_human（见 draft_publication.ts）。
 * - off：AgentCore 不挂复核，模型的草稿直接作为答案发布，reviewStatus=needs_human。
 *
 * 三种模式发布前都过同一套发布校验（parsePublicDraft：结构、源码/SQL/路径/内部标识拦截、业务字段中文名；以及 V4 数据核对模式）。
 *
 * 这个文件只管取值，不 import 任何东西：config.ts 要在启动时调用 validateReviewMode。
 */
export type ReviewMode = 'gate' | 'advisory' | 'off';
const REVIEW_MODES: readonly string[] = ['gate', 'advisory', 'off'];

const rawMode = (env: NodeJS.ProcessEnv) => String(env.REVIEW_MODE ?? '').trim().toLowerCase();

/**
 * 每次排查开始时读取（与 RULE_LAYER / REVIEW_OBSERVED_BRANCH 一样按调用读 env，做对照实验不用改代码）。
 * 未设置或空串为 gate，大小写不敏感、去空格。取值写错时这里也按 gate，绝不在请求中途抛错——写错的取值在启动时由 loadServerConfig 拦下。
 */
export function reviewMode(env: NodeJS.ProcessEnv = process.env): ReviewMode {
  const value = rawMode(env);
  return REVIEW_MODES.includes(value) ? (value as ReviewMode) : 'gate';
}

/** 启动校验：写错（如 advisroy）直接报错，避免对照实验悄悄跑成 gate */
export function validateReviewMode(env: NodeJS.ProcessEnv = process.env): ReviewMode {
  const value = rawMode(env);
  if (value && !REVIEW_MODES.includes(value)) throw new Error(`REVIEW_MODE 只能是 gate、advisory 或 off，当前值：${env.REVIEW_MODE}`);
  return reviewMode(env);
}
