import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * A 发问题、B 来 @ 的归属规则：
 *   - 问题主体是 **A**（原问题作者），材料看 A 说了什么
 *   - B 只保留 @ 那条里给出的内容，B 的其他消息不进材料
 *
 * 为什么不能用 B（发起 @ 的人）当主体：
 *   A 才是当事人，A 的补充说明才是本案材料；B 可能只是转发/催办，
 *   拿 B 当主体会把 A 的所有材料删掉、把 B 的无关闲聊当成上下文。
 */

interface Msg { messageId: string; senderOpenId: string; createTimeMs: number; text: string; resourceKeys: string[] }

function pipeline(
  timeline: Msg[],
  originId: string,
  trigger: Msg,
  requesterOpenId: string,
  originAuthorOpenId: string | null,
) {
  const mustKeep = new Set([originId, trigger.messageId]);
  const questionParts = timeline.filter(m => mustKeep.has(m.messageId));
  const subjectOpenId = originAuthorOpenId ?? requesterOpenId;
  const others = timeline.filter(m => !mustKeep.has(m.messageId));
  const materials = others.filter(
    m => m.senderOpenId === subjectOpenId && (m.text.trim() || m.resourceKeys.length),
  );
  return { questionParts, materials, subjectOpenId };
}

const T = Date.UTC(2026, 9, 27, 2, 0, 0);
const A = 'ou_A', B = 'ou_B', C = 'ou_C';
const m = (id: string, sender: string, min: number, text = id): Msg => ({ messageId: id, senderOpenId: sender, createTimeMs: T - min * 60000, text, resourceKeys: [] });

const origin = m('origin', A, 20, '护照推送不过来，帮查一下');
const trigger = m('trigger', B, 0, '麻烦看下这个');

test('A 发问题、B 来 @：主体是 A', () => {
  const { materials, subjectOpenId } = pipeline(
    [m('a1', A, 15), origin, m('b1', B, 5), trigger],
    'origin', trigger, B, A,
  );
  assert.equal(subjectOpenId, A, '主体必须是原问题作者 A');
  assert.deepEqual(materials.map(x => x.messageId), ['a1'], '材料只取 A 的消息');
});

test('B 的其他消息不进材料', () => {
  const { materials } = pipeline(
    [origin, m('b-other', B, 10, '今天天气不错'), trigger],
    'origin', trigger, B, A,
  );
  assert.equal(materials.length, 0, 'B 的无关消息不能当材料');
  assert.ok(!materials.some(x => x.messageId === 'b-other'));
});

test('B 在 @ 那条里给出的内容仍然保留（算问题内容）', () => {
  const { questionParts } = pipeline(
    [origin, trigger],
    'origin', trigger, B, A,
  );
  const text = questionParts.map(x => x.text).join('\n');
  assert.match(text, /护照推送不过来/, 'A 的原问题在');
  assert.match(text, /麻烦看下这个/, 'B 在 @ 时的补充也在');
});

test('群里第三方 C 的消息一律排除', () => {
  const { materials } = pipeline(
    [origin, m('c1', C, 10), trigger],
    'origin', trigger, B, A,
  );
  assert.equal(materials.length, 0);
});

test('A 与 B 是同一人时，材料就是这个人自己的消息', () => {
  const sameOrigin = m('origin', A, 20, '发票开不出来');
  const sameTrigger = m('trigger', A, 0, '再看下');
  const { materials, subjectOpenId } = pipeline(
    [m('x1', A, 10), sameOrigin, sameTrigger],
    'origin', sameTrigger, A, A,
  );
  assert.equal(subjectOpenId, A);
  assert.deepEqual(materials.map(x => x.messageId), ['x1']);
});

test('拿不到原问题作者时退回发起 @ 的人，不能没有主体', () => {
  const { subjectOpenId } = pipeline([origin, trigger], 'origin', trigger, B, null);
  assert.equal(subjectOpenId, B, '查不到作者时用请求者兜底');
});
