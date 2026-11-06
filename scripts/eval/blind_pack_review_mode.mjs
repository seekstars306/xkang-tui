import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// 复核模式对照盲评：off（不复核）/ advisory（复核但发布完整草稿）/ gate（现行复核，已有样本）。均为 deepseek、带截图。
const name = process.argv[2] || 'blind-review-mode';
const OUT = path.join('eval_run', name), KEY = path.join('eval_run', name + '-key');
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(KEY, { recursive: true });
const runs = fs.readdirSync('eval_run');
const pick = re => runs.filter(d => re.test(d)).sort();
const fmt = a => { if (!a) return '（没有发布任何答案）'; const p = ['结论：' + (a.conclusion || '')]; if (a.businessData?.length) p.push('业务数据：\n' + a.businessData.map(x => '- ' + x.label + '：' + x.value).join('\n')); if (a.evidenceSummary?.length) p.push('依据：\n' + a.evidenceSummary.map(x => '- ' + x).join('\n')); if (a.customerReply) p.push('给提问人的回复：' + a.customerReply); if (a.pendingItems?.length) p.push('待确认事项：\n' + a.pendingItems.map(x => '- ' + x).join('\n')); return p.join('\n\n'); };
const entries = [];
const replay = (re, arm) => { for (const d of pick(re)) { const f = path.join('eval_run', d, 'public.json'); if (!fs.existsSync(f)) continue; const a = JSON.parse(fs.readFileSync(f, 'utf8')).final?.turns?.at(-1)?.answer; entries.push({ ticket: 'a12c3554', text: fmt(a), key: { d, arm, reviewStatus: a?.reviewStatus } }); } };
const batch = (re, arm) => { for (const d of pick(re)) for (const t of ['T001', 'T003', 'T004', 'T006']) { const f = path.join('eval_run', d, t + '.json'); if (!fs.existsSync(f)) continue; const rec = JSON.parse(fs.readFileSync(f, 'utf8')); entries.push({ ticket: t, text: fmt(rec.answer), key: { d, arm, reviewStatus: rec.answer?.reviewStatus, fallback: rec.isFallback, minutes: rec.durationMin } }); } };
replay(/^replay-a12c3554-ob-ds-r[123]-/, 'gate');
batch(/^batch-cmp2?-deepseek-images-/, 'gate');
replay(/^replay-a12c3554-rm-adv-r[123]-/, 'advisory');
batch(/^batch-rmadv-deepseek-images-/, 'advisory');
replay(/^replay-a12c3554-rm-off2-r[123]-/, 'off');
batch(/^batch-rmoff2-deepseek-images-/, 'off');
for (const e of entries) e.blindId = 'Z' + crypto.randomBytes(3).toString('hex');
entries.sort((x, y) => x.blindId.localeCompare(y.blindId));
const rubrics = JSON.parse(fs.readFileSync('eval_run/blind-20261029/pack.json', 'utf8')).rubrics;
fs.writeFileSync(path.join(OUT, 'pack.json'), JSON.stringify({ rubrics, answers: entries.map(e => ({ blindId: e.blindId, ticket: e.ticket, answer: e.text })) }, null, 2));
fs.writeFileSync(path.join(KEY, 'key.json'), JSON.stringify(entries.map(e => ({ blindId: e.blindId, ticket: e.ticket, ...e.key })), null, 2));
const c = {}; for (const e of entries) { const k = e.ticket + ' ' + e.key.arm; c[k] = (c[k] || 0) + 1; }
console.log(JSON.stringify({ total: entries.length, c }, null, 1));
