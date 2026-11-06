import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

/**
 * 回复的幂等键规则。
 *
 * 飞书：同一个 uuid 一小时内至多成功回复一条。此前回执和最终结论共用
 * `issueId-triggerId`，导致只有第一条能发出，后续全被去重吞掉
 * （现象：排查完成了但群里收不到回复）。
 *
 * 规则：issueId + 用途 + 内容指纹。同内容幂等，不同内容/不同用途各自独立。
 */
function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}
function key(issueId: string, purpose: string, text: string): string {
  return `${issueId}-${purpose}-${fingerprint(text)}`.slice(0, 50);
}

test('回执与最终结论必须使用不同的幂等键', () => {
  const issueId = 'cae6f355';
  const ack = key(issueId, 'ack', '已开始排查（编号 cae6f355）');
  const final = key(issueId, 'final', '【结论】该订单已完成退款');
  assert.notEqual(ack, final, '共用键会让第二条被飞书去重吞掉');
});

test('失败通知与最终结论也不能共用键', () => {
  const issueId = 'abc12345';
  assert.notEqual(key(issueId, 'failed', '排查出现问题'), key(issueId, 'final', '结论'));
});

test('同一用途同一内容重复调用时键相同（网络重试保持幂等）', () => {
  const text = '已开始排查（编号 abc12345）';
  assert.equal(key('abc12345', 'ack', text), key('abc12345', 'ack', text));
});

test('同一用途不同内容视为不同消息，不能被去重', () => {
  assert.notEqual(
    key('abc12345', 'ack', '排队中，前面有 2 个任务'),
    key('abc12345', 'ack', '已开始排查'),
    '补充信息与排队提示是两条不同的消息',
  );
});

test('键长度不超过飞书 50 字符上限', () => {
  const longIssue = 'x'.repeat(40);
  const k = key(longIssue, 'final', '很长的结论'.repeat(50));
  assert.ok(k.length <= 50, `键长度 ${k.length} 超出上限`);
});
