import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';

/**
 * 结论必须原样转达。
 *
 * 曾经把“尚未形成可直接采信的业务结论”当成服务故障抛错，
 * 结果群里收到的是通用话术，而不是模型实际给出的结论，
 * 客服既看不到查了什么，也分不清是“查了没结果”还是“服务挂了”。
 */
test('runner 不得拦截“没查出结论”的答案', () => {
  const src = fs.readFileSync('server/src/feishu/runner.ts', 'utf8');
  assert.doesNotMatch(
    src,
    /includes\('尚未形成可直接采信/,
    '不能把模型给出的结论判断成故障并替换掉',
  );
  assert.doesNotMatch(
    src,
    /throw new Error\('模型服务暂时不可用/,
    '不能用通用话术覆盖模型结论',
  );
});

test('真正的故障仍然通过 streamError 抛出', () => {
  const src = fs.readFileSync('server/src/feishu/runner.ts', 'utf8');
  assert.match(src, /if \(streamError\) throw new Error\(streamError\)/, '流内错误必须抛出');
  assert.match(src, /if \(!answer\) throw new Error/, '没拿到答案必须抛出');
});

test('结论为空时才用兜底句', () => {
  const src = fs.readFileSync('server/src/feishu/runner.ts', 'utf8');
  assert.match(
    src,
    /lines\.push\(answer\.conclusion \|\|/,
    '有结论就用结论，空着才兜底',
  );
});
