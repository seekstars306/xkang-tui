import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
// 用 DSH headless + 与 xkang 同款 deepseek 跑一个任务。用法：node scripts/eval/dsh_headless.mjs <任务文件> <输出目录> [超时分钟]
const [taskFile, outDir, minutes = '30'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const env = dotenv.parse(fs.readFileSync('server/.env'));
const bin = 'C:/Users/skt/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js';
const task = fs.readFileSync(taskFile, 'utf8');
const out = fs.openSync(path.join(outDir, 'events.jsonl'), 'w');
const err = fs.openSync(path.join(outDir, 'stderr.log'), 'w');
const started = Date.now();
// DSH 命令行入口用 import.meta.main（Node 24+），系统 node 是 22，用 DSH 自带的 Node
const NODE24 = 'C:/Users/skt/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe';
const child = spawn(NODE24, [bin, '--profile', 'headless', '--patch', 'D:/xk_cmp/dsh-headless-deepseek.yml', '--json', task], {
  cwd: 'D:/skt_project', stdio: ['ignore', out, err],
  env: { ...process.env, XK_DEEPSEEK_KEY: env.DEEPSEEK_API_KEY, DSH_PERMISSION_MODE: 'danger-full-access', NODE_TLS_REJECT_UNAUTHORIZED: '0' },
});
const timer = setTimeout(() => { child.kill(); fs.writeFileSync(path.join(outDir, 'timeout.txt'), minutes + ' minutes'); }, Number(minutes) * 60000);
child.on('exit', code => {
  clearTimeout(timer);
  const lines = fs.readFileSync(path.join(outDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const final = lines.filter(e => e.type === 'final').at(-1);
  const texts = lines.filter(e => e.type === 'text').map(e => e.text ?? e.content ?? '').join('');
  const answer = String(final?.text ?? final?.content ?? texts ?? '');
  fs.writeFileSync(path.join(outDir, 'answer.md'), answer + '\n');
  const summary = { exitCode: code, seconds: Math.round((Date.now() - started) / 1000), events: lines.length, toolCalls: lines.filter(e => e.type === 'tool_call').length, types: [...new Set(lines.map(e => e.type))], model: 'deepseek-v4.1-flash（DSH headless，xkang 同款本机接口，推理 high）' };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, answerHead: answer.slice(0, 160) }));
});
