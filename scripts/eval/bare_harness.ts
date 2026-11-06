import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentCore, type Message } from '@xkang/agent-core';
import { loadServerConfig } from '../../server/src/config.ts';
import { AuditLogger } from '../../server/src/auth.ts';
import { BusinessModel } from '../../server/src/agent/model.ts';
import { BusinessRegistry, BUSINESS_PROMPT } from '../../server/src/agent/service.ts';
import { buildSystemPrompt } from '../../server/src/agent/investigation_prompt.ts';
import { getCompanyServerSkills } from '../../server/src/skills.ts';
import { PROJECT_MAP_PROMPT } from '../../server/src/agent/project_map.ts';

/**
 * 同模型"裸跑"对照：与线上 xkang 用同一个排查模型、同一套业务工具、同样 15 分钟预算，
 * 但系统提示只有说明性内容（身份 + 项目目录说明 + 用中文回答），不挂复核、不走发布裁剪，
 * 也不要求 JSON 输出协议。用来回答"是模型查不出来，还是流水线把结论压掉了"。
 *
 * 用法：node --import tsx scripts/eval/bare_harness.ts <a12c3554|T001..T007> <标签>
 */
const target = process.argv[2] || 'a12c3554';
const label = (process.argv[3] || 'run').replace(/[^\w-]/g, '_');
const slot = (process.argv[4] === 'gemini' ? 'gemini' : 'deepseek') as 'gemini' | 'deepseek';
// 提示词对照：desc=只有说明性提示词；prod=与线上 service.ts 完全相同的拼法（通用排查指引 + BUSINESS_PROMPT + 项目说明）。
// 两臂都不挂复核、都不加 response_format，只有系统提示词不同。
const arm = process.argv.includes('--prompt=prod') ? 'prod' : 'desc';

function inputFor(id: string): string | any[] {
  if (id === 'a12c3554') {
    const db = new DatabaseSync('data/xkang.db', { readOnly: true });
    const row = db.prepare('SELECT private_json FROM agent_sessions WHERE id = ?').get('s_c6f265a076ea482195a36e9ca07565a4') as { private_json: string };
    db.close();
    return (JSON.parse(row.private_json) as any[]).find(m => m.role === 'user' && !m.internal && !m.isReminder).content;
  }
  const j = JSON.parse(fs.readFileSync(path.join('tests/eval/reports/_retest/tickets', id, id + '.json'), 'utf8'));
  const texts: string[] = []; const images: any[] = [];
  for (const m of j.messages || []) {
    const c: any = m.content;
    if (typeof c === 'string') { if (c.trim()) texts.push(c.trim()); continue; }
    if (!Array.isArray(c)) continue;
    const t = c.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n').trim();
    if (t) texts.push(t);
    for (const p of c) if (p.type === 'image_url' && p.image_url?.url) images.push({ type: 'image_url', image_url: { url: p.image_url.url } });
  }
  const text = texts.join('\n\n');
  return images.length ? [{ type: 'text', text }, ...images.slice(0, 4)] : text;
}

const PROMPT = [
  '你是公司内部的排障助手，负责回答客服在飞书群里提出的问题。你可以调用工具查询业务数据库、阅读代码、查询日志。',
  PROJECT_MAP_PROMPT,
  '最后用中文直接回答客服的问题。',
].join('\n\n');

const config = loadServerConfig();
const noopDb: any = { prepare: () => ({ run() {}, all: () => [], get: () => undefined }) };
const audit = new AuditLogger(noopDb);
const owner = 'eval-bare';
const controller = new AbortController();
const model = new BusinessModel(config, slot, audit, owner, controller.signal, false);
const registry = new BusinessRegistry(config, owner, audit);
const core = new AgentCore({
  gateway: model, registry, context: { repoPath: config.codeRepoPath || '', localCwd: '' },
  buildPrompt: arm === 'prod'
    ? (tools, _skills, input) => buildSystemPrompt(tools, getCompanyServerSkills(), 'l2', { hasImages: Array.isArray(input?.content) && input.content.some((part: any) => part.type === 'image_url') }) + '\n\n' + BUSINESS_PROMPT + '\n\n' + PROJECT_MAP_PROMPT
    : () => PROMPT,
  budget: { activeMs: 15 * 60 * 1000, extensions: 0, reviewsPerExtension: 1, repairTurnsPerReview: 4, wrapUpMs: 180000 },
});
const started = Date.now();
const input = inputFor(target);
let answer = '';
let error: string | null = null;
try {
  answer = await core.run(input as any, (event: any) => {
    if (event.type === 'question_requested') event.resolve('客服暂时无法回答，请依据现有信息说明待确认事项。');
    if (event.type === 'approval_requested') event.resolve(false);
  });
} catch (e: any) { error = String(e?.message ?? e); }
const messages: Message[] = core.getMessages();
const outDir = path.join('eval_run', 'bare-' + target + '-' + label + '-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'answer.md'), answer + '\n');
fs.writeFileSync(path.join(outDir, 'private.json'), JSON.stringify(messages, null, 2));
const calls: string[] = [];
for (const m of messages as any[]) for (const c of m.tool_calls || []) {
  let a: any = c.arguments; try { if (typeof a === 'string') a = JSON.parse(a); } catch { a = {}; }
  calls.push(c.name + ' ' + (a.filePath ? a.filePath + ':' + (a.startLine ?? '') + '-' + (a.endLine ?? '') : a.keyword ?? a.action ?? a.id ?? a.query ?? ''));
}
const systemPrompt = String((messages as any[]).find(m => m.role === 'system')?.content ?? '');
const summary = { target, label, slot, arm, systemPromptChars: systemPrompt.length, seconds: Math.round((Date.now() - started) / 1000), error, toolCalls: calls.length, names1330: /13[:：]30|一点半|1点半/.test(answer), namesHuazhu: /华住/.test(answer), calls };
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('=== RESULT === ' + outDir);
console.log(JSON.stringify({ ...summary, calls: undefined }));
console.log('--- ANSWER ---');
console.log(answer);
process.exit(0);
