// 通过调试端口操作 zcode 桌面版界面。用法：node scripts/eval/zc_ui.mjs <动作脚本.js> [参数JSON]
// 动作脚本是一个 async 函数体，可用 page、args、shot(name)；返回值打印为 JSON。只断开连接，不关闭 zcode。
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/skt/AppData/Roaming/npm/node_modules/openclaw/node_modules/playwright-core');
const [file, argJson] = process.argv.slice(2);
const args = argJson ? JSON.parse(fs.readFileSync(argJson, 'utf8')) : {};
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('renderer/index.html'));
if (!page) { console.log(JSON.stringify({ error: 'zcode main page not found' })); process.exit(2); }
fs.mkdirSync('D:/xk_cmp/zc_shots', { recursive: true });
const shot = async name => { const p = 'D:/xk_cmp/zc_shots/' + name + '.png'; await page.screenshot({ path: p }); return p; };
const body = fs.readFileSync(file, 'utf8');
const fn = new (Object.getPrototypeOf(async function () {}).constructor)('page', 'args', 'shot', body);
try { const result = await fn(page, args, shot); if (process.env.ZC_OUT) fs.writeFileSync(process.env.ZC_OUT, JSON.stringify(result, null, 1)); console.log(JSON.stringify(result, null, 1).slice(0, process.env.ZC_OUT ? 2000 : Infinity)); }
catch (e) { console.log(JSON.stringify({ error: String(e?.message || e).slice(0, 800) })); }
process.exit(0);