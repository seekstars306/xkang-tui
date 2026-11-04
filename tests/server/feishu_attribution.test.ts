import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideContinuation, pickUnfinishedIssue, type UnfinishedIssueRef } from '../../server/src/feishu/attribution.ts';
import { FeishuMonitorDb } from '../../server/src/feishu/monitor_db.ts';

/**
 * 归属判定：绝不能让"问题 A 的继续"算到"问题 B"身上。
 *
 * 两种续查入口：
 *   A. 引用机器人的那条「额度用完」消息 → 最精确
 *   B. 直接 @ 说「继续」 → 靠"这个人手上当前唯一可继续的问题"定位
 */

const A = { origin: 'om_q_A', requester: 'ou_A', session: 's_A' };
const replyOfA = { originMessageId: A.origin, requesterOpenId: A.requester, sessionId: A.session };

// ---------- 入口 A：引用结论 ----------

test('发起人引用自己的结论 → 继续，锁死在 A 的原问题', () => {
  const d = decideContinuation({
    quotedId: 'om_bot_reply_A', senderOpenId: A.requester, resumeRef: replyOfA, quotedIsBot: false,
  });
  assert.equal(d.kind, 'continue');
  assert.equal(d.kind === 'continue' && d.originMessageId, A.origin);
  assert.equal(d.kind === 'continue' && d.sessionId, A.session);
});

test('B 引用 A 的结论 → 拒绝，A 的问题不会被延长', () => {
  const d = decideContinuation({
    quotedId: 'om_bot_reply_A', senderOpenId: 'ou_B', resumeRef: replyOfA, quotedIsBot: false,
  });
  assert.equal(d.kind, 'reject_not_requester');
});

// ---------- 入口 B：直接 @ ----------

test('直接 @ 说继续，且手上有一个额度用完的问题 → 继续那一个', () => {
  const d = decideContinuation({
    quotedId: 'om_self', senderOpenId: A.requester, resumeRef: null,
    continuable: { originMessageId: A.origin, sessionId: A.session }, intentIsContinue: true,
    quotedIsBot: false,
  });
  assert.equal(d.kind, 'continue');
  assert.equal(d.kind === 'continue' && d.originMessageId, A.origin, '必须回到他自己那个问题');
});

test('直接 @ 但说的不是"继续" → 普通消息，新问题不能被吞掉', () => {
  const d = decideContinuation({
    quotedId: 'om_self', senderOpenId: A.requester, resumeRef: null,
    continuable: { originMessageId: A.origin, sessionId: A.session }, intentIsContinue: false,
    quotedIsBot: false,
  });
  assert.equal(d.kind, 'normal');
});

test('没有任何可继续的问题时，说"继续"也只是普通消息', () => {
  const d = decideContinuation({
    quotedId: 'om_self', senderOpenId: A.requester, resumeRef: null,
    continuable: null, intentIsContinue: true, quotedIsBot: false,
  });
  assert.equal(d.kind, 'normal');
});

test('引用入口优先于按人定位：谁被引用就归谁', () => {
  // A 同时手上有一个可继续的问题，但他引用的是自己的结论 → 仍走引用
  const d = decideContinuation({
    quotedId: 'om_reply_A', senderOpenId: A.requester, resumeRef: replyOfA,
    continuable: { originMessageId: 'om_other', sessionId: 's_other' }, intentIsContinue: true,
    quotedIsBot: false,
  });
  assert.equal(d.kind === 'continue' && d.originMessageId, A.origin);
});

test('引用机器人消息但查不到对应问题 → 拒绝建任务，避免引用链漂移', () => {
  const d = decideContinuation({
    quotedId: 'om_unknown_bot', senderOpenId: A.requester, resumeRef: null,
    continuable: null, intentIsContinue: false, quotedIsBot: true,
  });
  assert.equal(d.kind, 'reject_unknown_bot');
});

test('正常引用别人发的业务消息 → 普通消息', () => {
  const d = decideContinuation({
    quotedId: 'om_user_question', senderOpenId: A.requester, resumeRef: null, quotedIsBot: false,
  });
  assert.equal(d.kind, 'normal');
});

// ---------- 规则 0：发起人自己还没出最终结果的问题 ----------

const openOfA = (over: Partial<UnfinishedIssueRef> = {}): UnfinishedIssueRef => ({
  chatId: 'oc_1', requesterOpenId: 'ou_A', originMessageId: 'om_q_A', pendingJobs: 1, lastActivityMs: 1_000, ...over,
});

test('A 的问题还没出最终结果 → A 之后的 @ 都归它', () => {
  assert.equal(pickUnfinishedIssue([openOfA()], 'oc_1', 'ou_A')?.originMessageId, 'om_q_A');
});

test('出了最终结果（没有排队或运行中的任务）→ 不再命中，交回原有规则', () => {
  assert.equal(pickUnfinishedIssue([openOfA({ pendingJobs: 0 })], 'oc_1', 'ou_A'), null);
});

test('别人的 @ 永远不会归到 A 还没出结果的问题上', () => {
  assert.equal(pickUnfinishedIssue([openOfA()], 'oc_1', 'ou_B'), null);
});

test('跨群隔离：A 在别的群里的 @ 不归这个问题', () => {
  assert.equal(pickUnfinishedIssue([openOfA()], 'oc_2', 'ou_A'), null);
});

test('万一同时有多条没出结果的，取最近有动静的那条', () => {
  const picked = pickUnfinishedIssue([
    openOfA({ originMessageId: 'om_old', lastActivityMs: 1 }),
    openOfA({ originMessageId: 'om_new', lastActivityMs: 2 }),
    openOfA({ originMessageId: 'om_done', pendingJobs: 0, lastActivityMs: 3 }),
  ], 'oc_1', 'ou_A');
  assert.equal(picked?.originMessageId, 'om_new');
});

// ---------- 库层 ----------

function tempPath(): string {
  return path.join(os.tmpdir(), 'attr-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db');
}

test('按人找可继续的问题：只认冻结的，且同群', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    db.saveIssueSession({ originMessageId: 'om_q_A', chatId: 'oc_1', requesterOpenId: 'ou_A', sessionId: 's_A' });
    assert.equal(db.findContinuableIssue('oc_1', 'ou_A'), null, '未冻结时不可继续');

    db.setIssueFrozen('om_q_A', true);
    const hit = db.findContinuableIssue('oc_1', 'ou_A');
    assert.equal(hit?.originMessageId, 'om_q_A');
    assert.equal(hit?.sessionId, 's_A');

    assert.equal(db.findContinuableIssue('oc_2', 'ou_A'), null, '别的群不行');
    assert.equal(db.findContinuableIssue('oc_1', 'ou_B'), null, '别人不能续');
    db.close();
  } finally { fs.rmSync(p, { force: true }); }
});

test('继续之后冻结解除，就不会被反复认领', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    db.saveIssueSession({ originMessageId: 'om_q_A', chatId: 'oc_1', requesterOpenId: 'ou_A', sessionId: 's_A' });
    db.setIssueFrozen('om_q_A', true);
    assert.ok(db.findContinuableIssue('oc_1', 'ou_A'));
    db.setIssueFrozen('om_q_A', false);   // 已续成功，不再是可继续状态
    assert.equal(db.findContinuableIssue('oc_1', 'ou_A'), null);
    db.close();
  } finally { fs.rmSync(p, { force: true }); }
});

test('两条问题并行时互不干扰', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    db.saveIssueSession({ originMessageId: 'om_q_A', chatId: 'oc', requesterOpenId: 'ou_A', sessionId: 's_A' });
    db.setIssueFrozen('om_q_A', true);
    db.saveIssueSession({ originMessageId: 'om_q_B', chatId: 'oc', requesterOpenId: 'ou_B', sessionId: 's_B' });
    db.setIssueFrozen('om_q_B', true);

    assert.equal(db.findContinuableIssue('oc', 'ou_A')?.originMessageId, 'om_q_A');
    assert.equal(db.findContinuableIssue('oc', 'ou_B')?.originMessageId, 'om_q_B');
    db.close();
  } finally { fs.rmSync(p, { force: true }); }
});
