/**
 * 续查（人工追加）一次给的活跃窗口：15 分钟。
 *
 * 服务端 /continue 的预算、模型看到的"人工已追加 N 分钟"提醒、飞书回执里写的"追加 N 分钟"
 * 都从这里取，改一处即可，避免文案和实际预算对不上。
 * 本模块不依赖任何服务端运行时（飞书调度也会引用），只放常量。
 */
export const CONTINUE_EXTENSION_MS = 15 * 60 * 1000;

/** 给人看的分钟数（回执、提醒文案用） */
export const CONTINUE_EXTENSION_MINUTES = Math.round(CONTINUE_EXTENSION_MS / 60_000);

/**
 * 续查的运行预算。turnsPerExtension 随窗口按比例取 30（原 5 分钟 / 10 轮）；
 * 注意 agent-core 传了 budget 时只按时间限，turnsPerExtension 不再限制调用量，仅为兼容保留。
 * wrapUpMs 与首轮一致：距本次窗口截止 3 分钟时强制收尾，而不是等冻结硬切断。
 */
export function continueBudget(extensions: number) {
  return { activeMs: CONTINUE_EXTENSION_MS, extensions, turnsPerExtension: 30, reviewsPerExtension: 1, repairTurnsPerReview: 4, wrapUpMs: 180000 };
}
