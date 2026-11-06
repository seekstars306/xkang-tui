import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// 桌面版跨框架盲评：xkang（线上同版本代码）/ zcode 桌面版 / DSH 桌面版；模型统一经代理 deepseek-v4.1-flash、推理 max、输出 128000
const name = 'blind-desktop-20261030';
const OUT = path.join('eval_run', name), KEY = path.join('eval_run', name + '-key');
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(KEY, { recursive: true });
const NOANSWER = '（没有给出答案）';
const fmtObj = a => { if (!a) return NOANSWER; const p = ['结论：' + (a.conclusion || '')]; if (a.businessData?.length) p.push('业务数据：\n' + a.businessData.map(x => '- ' + x.label + '：' + x.value).join('\n')); if (a.evidenceSummary?.length) p.push('依据：\n' + a.evidenceSummary.map(x => '- ' + x).join('\n')); if (a.customerReply) p.push('给提问人的回复：' + a.customerReply); if (a.pendingItems?.length) p.push('待确认事项：\n' + a.pendingItems.map(x => '- ' + x).join('\n')); return p.join('\n\n'); };
const md = s => String(s || '').replace(/^#{1,6}\s*/gm, '').replace(/\*\*/g, '').replace(/^---+$/gm, '').trim();
const entries = [];
// xkang
const xk = { a12c3554: { dir: 'eval_run/replay-a12c3554-dk-xk-2026-10-30T01-59-47-449Z', seconds: 484 } };
for (const t of ['T001', 'T003', 'T004', 'T006']) { const d = fs.readdirSync('eval_run').find(x => x.startsWith('batch-dkxk' + t + '-deepseek-images-')); xk[t] = { dir: 'eval_run/' + d }; }
for (const [t, v] of Object.entries(xk)) {
  let a, seconds = v.seconds;
  if (t === 'a12c3554') a = JSON.parse(fs.readFileSync(v.dir + '/public.json', 'utf8')).final?.turns?.at(-1)?.answer;
  else { const r = JSON.parse(fs.readFileSync(v.dir + '/' + t + '.json', 'utf8')); a = r.answer; seconds = Math.round(r.durationMin * 60); }
  entries.push({ ticket: t, text: fmtObj(a), key: { harness: 'xkang', seconds } });
}
// zcode（有效那一轮）
const zc = JSON.parse(fs.readFileSync('D:/xk_cmp/zcode-collect.json', 'utf8'));
for (const t of ['a12c3554', 'T001', 'T003', 'T004', 'T006']) {
  const e = zc.find(x => x.ticket === t && /已工作 \d/.test(x.status.join(' ')) && x.answerChars > 200);
  const m = e?.status.join(' ').match(/已工作 (?:(\d+) 分 )?(\d+) 秒/);
  const seconds = m ? (Number(m[1] || 0) * 60 + Number(m[2])) : null;
  const text = e ? md(e.answer.replace(/^已工作[^\n]*\n+/, '')) : NOANSWER;
  entries.push({ ticket: t, text, key: { harness: 'zcode', seconds, empty: !e } });
}
// DSH 第二轮（已接入 xkang 工具）
const ds = JSON.parse(fs.readFileSync('D:/xk_cmp/dsh-desktop2/summary.json', 'utf8'));
for (const t of ['a12c3554', 'T001', 'T003', 'T004', 'T006']) {
  const s = ds.find(x => x.ticket === t);
  const f = 'D:/xk_cmp/dsh-desktop2/' + t + '/answer.md';
  const raw = fs.existsSync(f) ? md(fs.readFileSync(f, 'utf8')) : '';
  const empty = raw.length < 200;
  entries.push({ ticket: t, text: empty ? NOANSWER : raw, key: { harness: 'dsh', seconds: s?.seconds ?? null, empty, note: empty ? '模型接口返回 finish_reason=error，会话中断' : undefined } });
}
for (const e of entries) e.blindId = 'D' + crypto.randomBytes(3).toString('hex');
entries.sort((x, y) => x.blindId.localeCompare(y.blindId));
const rubrics = JSON.parse(fs.readFileSync('eval_run/blind-20261029/pack.json', 'utf8')).rubrics;
fs.writeFileSync(path.join(OUT, 'pack.json'), JSON.stringify({ rubrics, answers: entries.map(e => ({ blindId: e.blindId, ticket: e.ticket, answer: e.text })) }, null, 2));
fs.writeFileSync(path.join(KEY, 'key.json'), JSON.stringify(entries.map(e => ({ blindId: e.blindId, ticket: e.ticket, ...e.key })), null, 2));
console.log(JSON.stringify(entries.map(e => [e.key.harness, e.ticket, e.key.seconds, e.text.length])));