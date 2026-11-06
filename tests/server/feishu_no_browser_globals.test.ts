import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';

/**
 * dispatcher 不能在 Node 环境里引用浏览器全局对象。
 *
 * 真实事故：改写上下文逻辑时删掉了局部变量 window，但后面两处
 * （日志与监控写入）还在用 `window.length`。TypeScript 不会报错——
 * 它把 window 当成浏览器全局对象；结果运行时第一秒就抛
 * "window is not defined"，任务直接失败，而排查压根没开始。
 */
/** 去掉注释：注释里提到某个名字不会执行，不应算作引用 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(?<![:"'\`])\/\/.*$/gm, '');
}

test('dispatcher 不得引用浏览器全局 window', () => {
  const src = stripComments(fs.readFileSync('server/src/feishu/dispatcher.ts', 'utf8'));
  // 只禁止"当作变量使用"的 window：
  //   - 排除 windowMs 这类更长的标识符
  //   - 排除 { window: x } 这种属性名（后面跟冒号）
  //   - 排除 obj.window 这种属性访问（前面是点）
  // 仍然拦得住 window.length / window.location 这类真正的误用。
  const hits = [...src.matchAll(/(?<![A-Za-z0-9_$.])window(?![A-Za-z0-9_$:])/g)];
  assert.equal(
    hits.length,
    0,
    `发现 ${hits.length} 处独立的 window 引用，Node 环境会抛 window is not defined`,
  );
});

test('dispatcher 不得引用其它浏览器全局', () => {
  const src = stripComments(fs.readFileSync('server/src/feishu/dispatcher.ts', 'utf8'));
  for (const name of ['document', 'localStorage', 'navigator']) {
    const re = new RegExp('(?<![A-Za-z0-9_$.])' + name + '(?![A-Za-z0-9_$])');
    assert.equal(re.test(src), false, `不得在服务端代码里引用 ${name}`);
  }
});
