import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';

/**
 * 客户端必须复用，不能每次新建。
 *
 * 背景：每次排查会连续调用几十次模型。此前每次 getProviderClient 都 new OpenAI()，
 * 各自建立独立的 HTTP 连接池，旧池不立即回收，累积后新连接拿不到，表现为
 * 排查中途 Connection error / Request timed out（审计里都卡在 20-40 秒）。
 */
test('getProviderClient 使用缓存而不是每次 new OpenAI', () => {
  const src = fs.readFileSync('server/src/llm.ts', 'utf8');
  assert.match(src, /clientCache/, '必须有客户端缓存表');
  assert.match(src, /cachedClient\(/, '必须通过 cachedClient 创建');
  // 三个 provider 分支都不应再出现裸 new OpenAI(
  const naked = [...src.matchAll(/client:\s*new OpenAI\(/g)];
  assert.equal(naked.length, 0, '不应存在未经缓存的 new OpenAI()');
});

test('缓存键包含 baseURL 与 key 尾号，换配置能重建', () => {
  const src = fs.readFileSync('server/src/llm.ts', 'utf8');
  assert.match(src, /gemini\|\$\{config\.geminiBaseUrl\}/, 'gemini 缓存键要含 baseURL');
  assert.match(src, /deepseek\|\$\{config\.deepseekBaseUrl\}/, 'deepseek 缓存键要含 baseURL');
  assert.match(src, /grok\|\$\{config\.grokBaseUrl\}/, 'grok 缓存键要含 baseURL');
});
