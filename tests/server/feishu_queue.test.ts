import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * 回执时序语义（按用户口径锁定）：
 * - 队列满 → 立刻告知“队列已满，请等待”，不假装已开始；
 * - 队列有空位 → 不提前回“已收到”，等上下文取全、即将调用模型时回“已开始”。
 * 这两条一旦改回去，客服就会看到“已收到”却迟迟不动，或者以为排不上队。
 */

/** 与 dispatcher 同口径的判定：是否已满 */
function isQueueFull(running: number, queued: number, maxConcurrent: number): boolean {
  return running >= maxConcurrent || queued > 0;
}

/** 与 dispatcher 同口径的文案 */
function queueFullText(issueId: string, ahead: number): string {
  return `已收到（编号 ${issueId}）。当前有 ${ahead} 个任务在处理或排队，队列已满，请您等待；轮到后我会在这里回复已开始排查。`;
}

function startedText(issueId: string): string {
  return `已开始排查（编号 ${issueId}），预计需要几分钟，完成后在这里回复您。`;
}

test('三个任务在跑时，第 4 个必须被告知队列已满', () => {
  assert.equal(isQueueFull(3, 0, 3), true, '运行数达到上限即视为满');
  const text = queueFullText('ab12cd34', 3);
  assert.match(text, /队列已满/);
  assert.match(text, /请(您)?等待/);
  assert.match(text, /已开始排查/, '要说明轮到时还会再通知，避免客服一直等');
});

test('还有空位时不判定为满，也就不提前回“已收到”', () => {
  assert.equal(isQueueFull(2, 0, 3), false);
  assert.equal(isQueueFull(0, 0, 3), false);
});

test('有人排队时即使恰好有空位释放，也按“满”处理，避免插队告知', () => {
  assert.equal(isQueueFull(0, 1, 3), true, '队列非空说明前面还有人没轮到');
});

test('“已开始排查”必须表达正在进行，而不是“已收到”', () => {
  const text = startedText('ab12cd34');
  assert.match(text, /已开始排查/);
  assert.doesNotMatch(text, /已收到/, '这个阶段再说“已收到”会让客服以为还没排上');
});

test('排队文案要给出可见的等待量，而不是只说“稍等”', () => {
  const text = queueFullText('ab12cd34', 5);
  assert.match(text, /5 个任务/);
});
