import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// 统一模型配置后的跨框架盲评：三家都走统一参数代理（deepseek-v4.1-flash、推理 high、输出上限 128000、上下文 1048576）。
const name = process.argv[2] || 'blind-sameconfig';
const OUT = path.join('eval_run', name), KEY = path.join('eval_run', name + '-key');
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(KEY, { recursive: true });
const TICKETS = ['a12c3554', 'T001', 'T003', 'T004', 'T006'];
const NOANSWER = '（在时限内没有给出答案）';
const fmtObj = a => { if (!a) return NOANSWER; const p = ['结论：' + (a.conclusion || '')]; if (a.businessData?.length) p.push('业务数据：\n' + a.businessData.map(x => '- ' + x.label + '：' + x.value).join('\n')); if (a.evidenceSummary?.length) p.push('依据：\n' + a.evidenceSummary.map(x => '- ' + x).join('\n')); if (a.customerReply) p.push('给提问人的回复：' + a.customerReply); if (a.pendingItems?.length) p.push('待确认事项：\n' + a.pendingItems.map(x => '- ' + x).join('\n')); return p.join('\n\n'); };
const md = s => String(s || '').replace(/^#{1,6}\s*/gm, '').replace(/\*\*/g, '').replace(/^---+$/gm, '').trim();
const entries = [];
const dshAnswer = dir => { const a = path.join(dir, 'answer.md'); if (!fs.existsSync(a)) return null; const timedOut = fs.existsSync(path.join(dir, 'timeout.txt')); const s = md(fs.readFileSync(a, 'utf8')); return { text: timedOut || s.length < 80 ? NOANSWER : s, empty: timedOut || s.length < 80, timedOut, seconds: JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')).seconds }; };
const zcAnswer = dir => { const f = path.join(dir, 'messages.json'); const err = fs.existsSync(path.join(dir, 'error.json')); let text = ''; if (fs.existsSync(f)) { const list = JSON.parse(fs.readFileSync(f, 'utf8')).messages || []; for (let i = list.length - 1; i >= 0 && !text; i--) { const m = list[i]; if ((m.info?.role || m.role) === 'assistant') text = (m.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n').trim(); } } const res = fs.existsSync(path.join(dir, 'result.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')) : null; return { text: err || !text ? NOANSWER : md(text), empty: err || !text, timedOut: err, seconds: res ? Math.round(res.durationMs / 1000) : null }; };
// DSH 20 分钟
for (const t of TICKETS) { const a = dshAnswer(path.join('D:/xk_cmp/sm-dsh', t)); if (a) entries.push({ ticket: t, text: a.text, key: { arm: 'dsh-20', empty: a.empty, seconds: a.seconds } }); }
// DSH 45 分钟补充（20 分钟内已完成的单不重跑，不进这一组）
for (const t of ['T001', 'T003', 'T004', 'T006']) { const a = dshAnswer(path.join('D:/xk_cmp/sm-dsh-ext', t)); if (a) entries.push({ ticket: t, text: a.text, key: { arm: 'dsh-45ext', empty: a.empty, seconds: a.seconds } }); }
// zcode 20 分钟（a12c3554/T004/T006 用修好启动判定后的重跑）
const zc20 = { a12c3554: 'D:/xk_cmp/sm-zcode-fix-a12c3554/zcode-a12c3554-1', T001: 'D:/xk_cmp/sm-zcode-a/zcode-T001-1', T003: 'D:/xk_cmp/sm-zcode-a/zcode-T003-1', T004: 'D:/xk_cmp/sm-zcode-fix-T004/zcode-T004-1', T006: 'D:/xk_cmp/sm-zcode-fix-T006/zcode-T006-1' };
for (const [t, d] of Object.entries(zc20)) { const a = zcAnswer(d); entries.push({ ticket: t, text: a.text, key: { arm: 'zcode-20', empty: a.empty, seconds: a.seconds } }); }
{ const a = zcAnswer('D:/xk_cmp/sm-zcode-ext-T003/zcode-T003-1'); entries.push({ ticket: 'T003', text: a.text, key: { arm: 'zcode-45ext', empty: a.empty, seconds: a.seconds } }); }
// xkang（线上配置：不复核）
const runs = fs.readdirSync('eval_run');
for (const d of runs.filter(x => /^replay-a12c3554-sm-xk-r[123]-/.test(x)).sort()) { const a = JSON.parse(fs.readFileSync(path.join('eval_run', d, 'public.json'), 'utf8')).final?.turns?.at(-1)?.answer; const s = JSON.parse(fs.readFileSync(path.join('eval_run', d, 'summary.json'), 'utf8')); entries.push({ ticket: 'a12c3554', text: fmtObj(a), key: { arm: 'xkang', seconds: s.seconds } }); }
for (const d of runs.filter(x => /^batch-smxk-deepseek-images-/.test(x))) for (const t of TICKETS.slice(1)) { const f = path.join('eval_run', d, t + '.json'); if (fs.existsSync(f)) { const r = JSON.parse(fs.readFileSync(f, 'utf8')); entries.push({ ticket: t, text: fmtObj(r.answer), key: { arm: 'xkang', seconds: Math.round(r.durationMin * 60), fallback: r.isFallback } }); } }
for (const e of entries) e.blindId = 'U' + crypto.randomBytes(3).toString('hex');
entries.sort((x, y) => x.blindId.localeCompare(y.blindId));
const rubrics = JSON.parse(fs.readFileSync('eval_run/blind-20261029/pack.json', 'utf8')).rubrics;
fs.writeFileSync(path.join(OUT, 'pack.json'), JSON.stringify({ rubrics, answers: entries.map(e => ({ blindId: e.blindId, ticket: e.ticket, answer: e.text })) }, null, 2));
fs.writeFileSync(path.join(KEY, 'key.json'), JSON.stringify(entries.map(e => ({ blindId: e.blindId, ticket: e.ticket, ...e.key })), null, 2));
const c = {}; for (const e of entries) { const k = e.key.arm; c[k] = (c[k] || 0) + 1; }
console.log(JSON.stringify({ total: entries.length, c, noAnswer: entries.filter(e => e.key.empty).map(e => e.key.arm + ' ' + e.ticket) }));