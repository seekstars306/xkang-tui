import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadServerConfig } from '../../server/src/config.ts';

/** 复核器开关：默认必须是 llm（保证引入 jev 不改变现有行为），非法值要报错 */
test('REVIEWER 缺省为 llm，引入 jev 不改变默认行为', () => {
  const prev = process.env.REVIEWER;
  delete process.env.REVIEWER;
  try {
    assert.equal(loadServerConfig().reviewer, 'llm');
  } finally { if (prev !== undefined) process.env.REVIEWER = prev; }
});

test('REVIEWER 可切到 jev', () => {
  const prev = process.env.REVIEWER;
  process.env.REVIEWER = 'jev';
  try {
    assert.equal(loadServerConfig().reviewer, 'jev');
  } finally { if (prev === undefined) delete process.env.REVIEWER; else process.env.REVIEWER = prev; }
});

test('REVIEWER 非法值在加载时就报错，不静默回退', () => {
  const prev = process.env.REVIEWER;
  process.env.REVIEWER = 'gpt';
  try {
    assert.throws(() => loadServerConfig(), /REVIEWER 只能是 llm 或 jev/);
  } finally { if (prev === undefined) delete process.env.REVIEWER; else process.env.REVIEWER = prev; }
});

test('OUTBOUND_PROXY 缺省为空且不影响默认行为', () => {
  const prev = process.env.OUTBOUND_PROXY;
  delete process.env.OUTBOUND_PROXY;
  try {
    assert.equal(loadServerConfig().outboundProxy, undefined);
  } finally { if (prev !== undefined) process.env.OUTBOUND_PROXY = prev; }
});
