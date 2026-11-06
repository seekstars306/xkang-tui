/**
 * 归属判定：这次 @ 到底算「继续某个已有问题」还是「一个新问题」。
 *
 * 这里最容易出错，所以做成纯函数单独测。踩过的坑：
 *   - 只按"引用了机器人消息"就续，结果别人的问题被延长；
 *   - 引用链挂在机器人消息上，越漂越远，最后的"继续"算到了别的问题头上；
 *   - 跨群认领：A 群的结论被 B 群的消息引用。
 *
 * 规则（顺序即优先级）：
 *   0. 这个人自己在本群有还没出最终结果的问题     → 这次 @ 一律并入它作补充（pickUnfinishedIssue，
 *      排在最前面：命中就不再走下面这一套）
 *   1. 引用的确实是本系统的结论，且是**同一个人** → 继续，锁死到那条原问题
 *   2. 引用的确实是本系统的结论，但不是发起人 → 拒绝（不能让别人续别人的预算）
 *   3. 引用的是机器人消息但查不到对应问题     → 拒绝（否则会凭空造出挂在机器人消息上的"新问题"）
 *   4. 其余                                    → 普通消息
 */

/**
 * 归属里要用到的"问题"最小形状（dispatcher 的内存问题结构天然满足）。
 */
export interface UnfinishedIssueRef {
  chatId: string;
  /** 发起这个问题的人 */
  requesterOpenId: string;
  originMessageId: string;
  /** 还在排队或运行的任务数；0 表示已经给出最终结果 */
  pendingJobs: number;
  /** 最近一次有动静的时间（毫秒）：万一有多条，取最近的那条 */
  lastActivityMs: number;
}

/**
 * 找这个人在本群里"还没给出最终结果"（排队中或运行中）的问题。
 *
 * 2026-10-29 事故：A 的问题还在跑，A 不引用、直接 @ 说"比较着急，我刚把状态手动改为未收款了"，
 * 被当成了新问题——这句话成了问题原文，模型转去核实客服自己的操作。
 *
 * 规则：只要 A 的问题还没出最终结果，A 之后的**任何一次 @**（引用或不引用、说什么都一样，
 * 包括"继续"、包括带了新单号）都是对这个问题的补充。前提是同一个人不会同时提两个问题，
 * 所以这里不判语义、不看编号、不设时间窗。出了最终结果之后不再命中，交回下面原有的规则。
 *
 * 只认同群、同一发起人：别人的 @ 永远并不到 A 的问题上，A 在别的群里的 @ 也不会。
 */
export function pickUnfinishedIssue<T extends UnfinishedIssueRef>(
  issues: Iterable<T>,
  chatId: string,
  senderOpenId: string,
): T | null {
  let picked: T | null = null;
  for (const issue of issues) {
    if (issue.chatId !== chatId || issue.requesterOpenId !== senderOpenId) continue;
    if (issue.pendingJobs <= 0) continue;
    if (!picked || issue.lastActivityMs > picked.lastActivityMs) picked = issue;
  }
  return picked;
}

export interface ResumeRef {
  originMessageId: string;
  requesterOpenId: string;
  sessionId: string | null;
}

export type ContinuationDecision =
  | { kind: 'normal' }
  | { kind: 'continue'; originMessageId: string; sessionId: string | null }
  | { kind: 'reject_not_requester'; originalRequester: string }
  | { kind: 'reject_unknown_bot' };

export function decideContinuation(input: {
  /** 本次消息引用的那条 */
  quotedId: string;
  senderOpenId: string;
  /** 库里按"被引用的消息"反查到的结论记录（已按 chatId 过滤） */
  resumeRef: ResumeRef | null;
  /**
   * 这个人当前处于"预算用尽、可继续"的那个问题（按发送人查）。
   *
   * 客服手上通常只有一个问题，所以直接 @ 说"继续"就够了，不必引用结论。
   * 但必须配合语义判定（intentIsContinue），否则一句"再帮我查个新单子"
   * 会被误当成继续，新问题就丢了。
   */
  continuable?: { originMessageId: string; sessionId: string | null } | null;
  /** 语义上是否确实是"继续"（仅在 continuable 存在时才有意义） */
  intentIsContinue?: boolean;
  /** 被引用的那条是不是机器人发的（仅在前两条都没命中时才需要查） */
  quotedIsBot: boolean;
}): ContinuationDecision {
  const { resumeRef, senderOpenId, continuable, intentIsContinue, quotedIsBot } = input;

  // 1) 引用了某条已知结论：最精确，按引用定位
  if (resumeRef) {
    // 归属锁：只有当初提这个问题的人才能要求继续
    if (senderOpenId !== resumeRef.requesterOpenId) {
      return { kind: 'reject_not_requester', originalRequester: resumeRef.requesterOpenId };
    }
    return {
      kind: 'continue',
      originMessageId: resumeRef.originMessageId,
      sessionId: resumeRef.sessionId,
    };
  }

  // 2) 没引用，但这个人正好有一个"额度用完"的问题，且这句话确实是"继续"
  if (continuable && intentIsContinue) {
    return {
      kind: 'continue',
      originMessageId: continuable.originMessageId,
      sessionId: continuable.sessionId,
    };
  }

  // 3) 引用了机器人消息但完全对不上：不认领，也不当新问题——
  //    挂在机器人消息上的"新问题"会污染后续引用链。
  if (quotedIsBot) return { kind: 'reject_unknown_bot' };

  return { kind: 'normal' };
}
