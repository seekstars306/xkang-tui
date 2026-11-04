import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// 答案写法开关对照：旧写法（off）与新写法（v2），同一组 6 单、同样设置（deepseek max、复核关闭），同批盲评
const name = 'blind-guide-20261030';
const OUT = path.join('eval_run', name), KEY = path.join('eval_run', name + '-key');
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(KEY, { recursive: true });
const fmtObj = a => { if (!a) return '（没有给出答案）'; const p = ['结论：' + (a.conclusion || '')]; if (a.businessData?.length) p.push('业务数据：\n' + a.businessData.map(x => '- ' + x.label + '：' + x.value).join('\n')); if (a.evidenceSummary?.length) p.push('依据：\n' + a.evidenceSummary.map(x => '- ' + x).join('\n')); if (a.customerReply) p.push('给提问人的回复：' + a.customerReply); if (a.pendingItems?.length) p.push('待确认事项：\n' + a.pendingItems.map(x => '- ' + x).join('\n')); return p.join('\n\n'); };
const runs = fs.readdirSync('eval_run');
const entries = [];
for (const arm of ['g0b', 'g2b']) {
  for (const [ticket, prefix] of [['a12c3554', 'replay-a12c3554-' + arm + '-a12c3554-'], ['c4a2f188', 'replay-sess-2f31a306-' + arm + '-c4a2f188-']]) {
    const d = runs.filter(x => x.startsWith(prefix)).sort().at(-1); if (!d) { console.log('missing', arm, ticket); continue; }
    const a = JSON.parse(fs.readFileSync(path.join('eval_run', d, 'public.json'), 'utf8')).final?.turns?.at(-1)?.answer;
    const s = JSON.parse(fs.readFileSync(path.join('eval_run', d, 'summary.json'), 'utf8'));
    entries.push({ ticket, text: fmtObj(a), key: { arm, seconds: s.seconds, dir: d } });
  }
  for (const t of ['T001', 'T003', 'T004', 'T006']) {
    const d = runs.filter(x => x.startsWith('batch-' + arm + t + '-deepseek-images-')).sort().at(-1); if (!d) { console.log('missing', arm, t); continue; }
    const f = path.join('eval_run', d, t + '.json'); if (!fs.existsSync(f)) { console.log('missing file', arm, t); continue; }
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    entries.push({ ticket: t, text: fmtObj(r.answer), key: { arm, seconds: Math.round(r.durationMin * 60), dir: d, fallback: r.isFallback } });
  }
}
for (const e of entries) e.blindId = 'G' + crypto.randomBytes(3).toString('hex');
entries.sort((x, y) => x.blindId.localeCompare(y.blindId));
const rubrics = JSON.parse(fs.readFileSync('eval_run/blind-20261029/pack.json', 'utf8')).rubrics;
rubrics.c4a2f188 = JSON.parse(fs.readFileSync('D:/xk_cmp/rubric-c4a2f188.json', 'utf8'));
fs.writeFileSync(path.join(OUT, 'pack.json'), JSON.stringify({ rubrics, answers: entries.map(e => ({ blindId: e.blindId, ticket: e.ticket, answer: e.text })) }, null, 2));
fs.writeFileSync(path.join(KEY, 'key.json'), JSON.stringify(entries.map(e => ({ blindId: e.blindId, ticket: e.ticket, ...e.key })), null, 2));
console.log(JSON.stringify(entries.map(e => [e.key.arm, e.ticket, e.key.seconds])));
