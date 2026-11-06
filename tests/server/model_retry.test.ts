import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * 模型调用的重试判定（与 server/src/agent/model.ts 中 isRetryableModelError 同口径）。
 *
 * 目的：偶发连接中断必须重试，否则一次抖动就让整轮排查降级成兜底文案；
 * 但请求本身有问题时重试只是浪费时间和配额。
 */

function isRetryableModelError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/connection error|econnreset|econnrefused|etimedout|socket hang up|network|timed?\s*out|timeout|fetch failed|terminated|other side closed|premature close|und_err/.test(message)) return true;
  const status = (error as { status?: number; statusCode?: number } | null);
  const code = typeof status?.status === 'number' ? status.status : typeof status?.statusCode === 'number' ? status.statusCode : null;
  if (code !== null) return code === 429 || code >= 500;
  return false;
}

test('连接中断可重试（这是本次排查失败的真实原因）', () => {
  assert.equal(isRetryableModelError(new Error('Connection error.')), true);
  assert.equal(isRetryableModelError(new Error('socket hang up')), true);
  assert.equal(isRetryableModelError(new Error('ECONNRESET')), true);
  assert.equal(isRetryableModelError(new Error('Request timed out.')), true);
});

test('流被切断（undici 的 terminated）也必须重试', () => {
  // 线上真实踩到：模型流中途断开抛 TypeError: terminated，
  // 因为不在白名单里，直接判定失败，一次重试都没有
  assert.equal(isRetryableModelError(new TypeError('terminated')), true);
  assert.equal(isRetryableModelError(new Error('other side closed')), true);
  assert.equal(isRetryableModelError(new Error('premature close')), true);
});

test('上游 5xx 与限流可重试', () => {
  assert.equal(isRetryableModelError(Object.assign(new Error('server error'), { status: 500 })), true);
  assert.equal(isRetryableModelError(Object.assign(new Error('too many'), { status: 429 })), true);
});

test('参数错误与鉴权失败不重试', () => {
  assert.equal(isRetryableModelError(Object.assign(new Error('bad request'), { status: 400 })), false);
  assert.equal(isRetryableModelError(Object.assign(new Error('unauthorized'), { status: 401 })), false);
  assert.equal(isRetryableModelError(Object.assign(new Error('forbidden'), { status: 403 })), false);
  assert.equal(isRetryableModelError(Object.assign(new Error('not found'), { status: 404 })), false);
});

test('无法识别的错误不重试，避免掩盖真实问题', () => {
  assert.equal(isRetryableModelError(new Error('something weird happened')), false);
});
