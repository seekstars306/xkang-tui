import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeishuMonitorDb } from '../../server/src/feishu/monitor_db.ts';
import { isContinueIntent } from '../../server/src/feishu/continue_intent.ts';

/**
 * 加预算链路的基础件：
 *   客服在机器人的结论下面回复"继续" → 复用原会话、给新一轮预算。
 *
 * 三个条件必须同时成立，否则会错位：
 *   ① 被引用的确实是本系统的结论（findIssueByReply 命中）
 *   ② 发话人是当初的发起者
 *   ③ 语义确实是"继续"
 * 这里覆盖 ① 的存储/反查，以及 ③ 的判定入口。
 */

function tempPath(): string {
  return path.join(os.tmpdir(), 'issue-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.db');
}

test('记录会话后可反查到同一个问题', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    db.saveIssueSession({ originMessageId: 'om_q', chatId: 'oc', requesterOpenId: 'ou_a', sessionId: 's_1' });
    const got = db.getIssue('om_q');
    assert.equal(got?.sessionId, 's_1');
    assert.equal(got?.requesterOpenId, 'ou_a');
    db.close();
  } finally { fs.rmSync(p, { force: true }); }
});

test('按结论消息反查问题：命中说明"回复的是我们的结论"', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    db.saveIssueSession({ originMessageId: 'om_q', chatId: 'oc', requesterOpenId: 'ou_a', sessionId: 's_1' });
    db.setIssueReply('om_q', 'om_bot_reply');

    const hit = db.findIssueByReply('om_bot_reply');
    assert.ok(hit, '必须能命中');
    assert.equal(hit!.originMessageId, 'om_q', '要回到原来那条原问题');
    assert.equal(hit!.sessionId, 's_1', '要能拿到原会话');
    assert.equal(hit!.requesterOpenId, 'ou_a');

    assert.equal(db.findIssueByReply('om_someone_else'), null, '不是我们的结论要返回 null');
    db.close();
  } finally { fs.rmSync(p, { force: true }); }
});

test('继续多轮时轮次累加，会话保持不变', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    db.saveIssueSession({ originMessageId: 'om_q', chatId: 'oc', requesterOpenId: 'ou_a', sessionId: 's_1' });
    assert.equal(db.getIssue('om_q')?.rounds, 1, '首轮记为 1');
    assert.equal(db.bumpIssueRound('om_q'), 2);
    assert.equal(db.bumpIssueRound('om_q'), 3);
    db.setIssueReply('om_q', 'om_reply_2');
    const hit = db.findIssueByReply('om_reply_2');
    assert.equal(hit?.rounds, 3);
    assert.equal(hit?.sessionId, 's_1', '多轮之后还是同一个会话');
    db.close();
  } finally { fs.rmSync(p, { force: true }); }
});

test('发过的每一条结论都能作为继续入口，全部锁到同一条原问题', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    db.saveIssueSession({ originMessageId: 'om_q', chatId: 'oc', requesterOpenId: 'ou_a', sessionId: 's_1' });
    db.setIssueReply('om_q', 'om_reply_1');
    db.setIssueReply('om_q', 'om_reply_2');
    // 多轮问题里客服引用的是哪一条并不固定。只认最近一条时，
    // 引用第一轮的结论会被判成"查不到对应原问题"，然后什么也不做。
    assert.equal(db.findIssueByReply('om_reply_1')?.originMessageId, 'om_q', '旧结论同样是继续入口');
    assert.equal(db.findIssueByReply('om_reply_2')?.originMessageId, 'om_q');
    assert.equal(db.findIssueByReply('om_reply_2')?.sessionId, 's_1');
    // 跨群仍然不认领
    db.saveIssueSession({ originMessageId: 'om_q', chatId: 'oc', requesterOpenId: 'ou_a', sessionId: 's_1' });
    assert.equal(db.findIssueByReply('om_reply_1', 'oc_other'), null);
    const latest = (db.db.prepare('SELECT last_reply_message_id v FROM feishu_issues WHERE origin_message_id = ?').get('om_q') as { v: string }).v;
    assert.equal(latest, 'om_reply_2', '最新一条仍然记在这一列上');
    db.close();
  } finally { fs.rmSync(p, { force: true }); }
});

test('同一问题的会话被重写时不会产生重复记录', () => {
  const p = tempPath();
  try {
    const db = new FeishuMonitorDb(p);
    db.saveIssueSession({ originMessageId: 'om_q', chatId: 'oc', requesterOpenId: 'ou_a', sessionId: 's_1' });
    db.saveIssueSession({ originMessageId: 'om_q', chatId: 'oc', requesterOpenId: 'ou_a', sessionId: 's_2' });
    const n = (db.db.prepare('SELECT COUNT(*) n FROM feishu_issues').get() as { n: number }).n;
    assert.equal(n, 1, '一个问题只有一条记录');
    assert.equal(db.getIssue('om_q')?.sessionId, 's_2', '会话取最新的');
    db.close();
  } finally { fs.rmSync(p, { force: true }); }
});

// ---------- 意图判定 ----------

test('明显的继续词直接判定，不需要联网', async () => {
  for (const t of ['继续', '继续吧', '接着查', '再往下查', '继续排查', 'continue', 'go on']) {
    const r = await isContinueIntent(t);
    assert.equal(r.isContinue, true, `"${t}" 应判为继续`);
  }
});

test('空消息不算继续', async () => {
  const r = await isContinueIntent('   ');
  assert.equal(r.isContinue, false);
});

test('提出新问题时不算继续', async () => {
  // 这句话与"继续"无关，Jev 会判 new_request；即使判不出来也必须给 false，
  // 否则会白烧一轮预算。
  const r = await isContinueIntent('这个订单的发票什么时候能开出来');
  assert.equal(r.isContinue, false);
});

test('判定服务不可用时退回关键词，且不误判', async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const plain = await isContinueIntent('帮我看看这个单子');
    assert.equal(plain.isContinue, false, '拿不到判定时不能当成继续');
    assert.match(String(plain.degraded), /TYPESAFE_API_KEY/, '要说明是缺配置');

    const keyword = await isContinueIntent('继续');
    assert.equal(keyword.isContinue, true, '关键词兜底仍要认出"继续"');
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});
