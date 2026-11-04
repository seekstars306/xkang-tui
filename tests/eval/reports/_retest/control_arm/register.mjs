// 对照组（改动前）模块替换钩子：解析到 redirects.mjs 里列的源码文件时，换成改动前的原样副本。
// 副本里的相对导入、包导入一律按"原文件所在位置"解析，所以除被替换的文件外，其余模块与实验组是同一份实例、同一种编译方式。
// 用法：ARM=control node --import tsx --import ./tests/eval/reports/_retest/control_arm/register.mjs <脚本>
// 只在 ARM=control 时生效；隔离服务端子进程继承 ARM，由运行器追加同一个 --import，两个进程换的是同一组文件。
// tsx 在本机 Node 上用的是同步钩子 module.registerHooks，这里也用它，保证在同一条钩子链上（后注册的先执行）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTROL_REDIRECTS, PROJECT_ROOT } from './redirects.mjs';

if (process.env.ARM === 'control') {
  if (typeof registerHooks !== 'function') throw new Error(`当前 Node ${process.version} 没有 module.registerHooks，对照组无法搭建`);
  const byOriginal = new Map();
  const byCopy = new Map();
  for (const r of CONTROL_REDIRECTS) {
    const original = path.join(PROJECT_ROOT, r.original);
    const copy = path.join(PROJECT_ROOT, r.copy);
    const actual = createHash('sha256').update(fs.readFileSync(copy)).digest('hex');
    if (actual !== r.sha256) throw new Error(`对照组副本哈希不符：${r.copy}`);
    byOriginal.set(original.toLowerCase(), pathToFileURL(copy).href);
    byCopy.set(copy.toLowerCase(), pathToFileURL(original).href);
  }
  const keyOf = (url) => {
    if (!url?.startsWith('file:')) return null;
    try { return path.resolve(fileURLToPath(url.split(/[?#]/)[0])).toLowerCase(); } catch { return null; }
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const asParent = byCopy.get(keyOf(context.parentURL));
      const result = nextResolve(specifier, asParent ? { ...context, parentURL: asParent } : context);
      const copy = byOriginal.get(keyOf(result.url));
      if (!copy) return result;
      return { ...result, url: copy + result.url.slice(result.url.split(/[?#]/)[0].length), shortCircuit: true };
    },
  });
}
