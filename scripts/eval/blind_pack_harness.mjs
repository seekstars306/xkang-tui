import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// 跨框架盲评：DSH / zcode / xkang（off 与 gate），同一组输入、同一套要点、同一个评分者。
const name = process.argv[2] || 'blind-harness';
const OUT = path.join('eval_run', name), KEY = path.join('eval_run', name + '-key');
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(KEY, { recursive: true });
const TICKETS = ['a12c3554', 'T001', 'T003', 'T004', 'T006'];
const fmtObj = a => { if (!a) return '（没有发布任何答案）'; const p = ['结论：' + (a.conclusion || '')]; if (a.businessData?.length) p.push('业务数据：\n' + a.businessData.map(x => '- ' + x.label + '：' + x.value).join('\n')); if (a.evidenceSummary?.length) p.push('依据：\n' + a.evidenceSummary.map(x => '- ' + x).join('\n')); if (a.customerReply) p.push('给提问人的回复：' + a.customerReply); if (a.pendingItems?.length) p.push('待确认事项：\n' + a.pendingItems.map(x => '- ' + x).join('\n')); return p.join('\n\n'); };
const md = s => String(s || '').replace(/^#{1,6}\s*/gm, '').replace(/\*\*/g, '').replace(/^---+$/gm, '').trim();
const entries = [];
for (const t of TICKETS) {
  const f = path.join('D:/xk_cmp/dsh', t, 'answer.md');
  if (fs.existsSync(f)) { const r = path.join('D:/xk_cmp/dsh', t, 'result.json'); const model = fs.existsSync(r) ? JSON.parse(fs.readFileSync(r, 'utf8')).model : '?'; entries.push({ ticket: t, text: md(fs.readFileSync(f, 'utf8')), key: { harness: 'dsh', model, src: f } }); }
}
const zdirs = { a12c3554: 'D:/xk_cmp/zcode-c/zcode-a12c3554-1', T001: 'D:/xk_cmp/zcode-a/zcode-T001-1', T003: 'D:/xk_cmp/zcode-a/zcode-T003-1', T004: 'D:/xk_cmp/zcode-b/zcode-T004-1', T006: 'D:/xk_cmp/zcode-b/zcode-T006-1' };
for (const [t, d] of Object.entries(zdirs)) {
  const f = path.join(d, 'messages.json'); if (!fs.existsSync(f)) continue;
  const list = JSON.parse(fs.readFileSync(f, 'utf8')).messages || [];
  let text = '';
  for (let i = list.length - 1; i >= 0 && !text; i--) { const m = list[i]; if ((m.info?.role || m.role) !== 'assistant') continue; text = (m.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n').trim(); }
  if (text) entries.push({ ticket: t, text: md(text), key: { harness: 'zcode', model: 'deepseek-v4.1-flash（zcode 本机服务）', src: d } });
}
const runs = fs.readdirSync('eval_run');
const pick = re => runs.filter(d => re.test(d)).sort();
for (const [arm, reA, reB] of [['xkang-off', /^replay-a12c3554-rm-off2-r[123]-/, /^batch-rmoff2-deepseek-images-/], ['xkang-gate', /^replay-a12c3554-ob-ds-r[123]-/, /^batch-cmp2-deepseek-images-/]]) {
  for (const d of pick(reA)) { const a = JSON.parse(fs.readFileSync(path.join('eval_run', d, 'public.json'), 'utf8')).final?.turns?.at(-1)?.answer; entries.push({ ticket: 'a12c3554', text: fmtObj(a), key: { harness: arm, model: 'deepseek-v4.1-flash', src: d } }); }
  for (const d of pick(reB)) for (const t of TICKETS.slice(1)) { const f = path.join('eval_run', d, t + '.json'); if (fs.existsSync(f)) entries.push({ ticket: t, text: fmtObj(JSON.parse(fs.readFileSync(f, 'utf8')).answer), key: { harness: arm, model: 'deepseek-v4.1-flash', src: d } }); }
}
for (const e of entries) e.blindId = 'W' + crypto.randomBytes(3).toString('hex');
entries.sort((x, y) => x.blindId.localeCompare(y.blindId));
const rubrics = JSON.parse(fs.readFileSync('eval_run/blind-20261029/pack.json', 'utf8')).rubrics;
fs.writeFileSync(path.join(OUT, 'pack.json'), JSON.stringify({ rubrics, answers: entries.map(e => ({ blindId: e.blindId, ticket: e.ticket, answer: e.text })) }, null, 2));
fs.writeFileSync(path.join(KEY, 'key.json'), JSON.stringify(entries.map(e => ({ blindId: e.blindId, ticket: e.ticket, ...e.key })), null, 2));
const c = {}; for (const e of entries) { const k = e.key.harness + ' ' + e.ticket; c[k] = (c[k] || 0) + 1; }
console.log(JSON.stringify({ total: entries.length, c }));