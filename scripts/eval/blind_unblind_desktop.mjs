import fs from 'node:fs';
const name = 'blind-desktop-20261030';
const scores = JSON.parse(fs.readFileSync('eval_run/' + name + '/scores.json', 'utf8'));
const key = Object.fromEntries(JSON.parse(fs.readFileSync('eval_run/' + name + '-key/key.json', 'utf8')).map(k => [k.blindId, k]));
const val = { hit: 1, partial: 0.5, miss: 0 };
const rows = scores.map(s => { const k = key[s.blindId]; const its = Object.values(s.items || {}); return { ...k, rate: its.reduce((a, v) => a + (val[v] ?? 0), 0) / (its.length || 1), wrongA: (s.wrongClaims || []).filter(w => w.where === 'asserted').length, usable: s.usable, items: s.items, note: s.note }; });
for (const r of rows.sort((a, b) => (a.ticket + a.harness).localeCompare(b.ticket + b.harness))) console.log([r.ticket.padEnd(8), r.harness.padEnd(6), 'rate=' + r.rate.toFixed(2), 'use=' + r.usable, 'wrongA=' + r.wrongA, (r.seconds != null ? Math.round(r.seconds / 6) / 10 + 'min' : '-'), r.empty ? '（未作答）' : '', JSON.stringify(r.items), '|', r.note].join(' '));
console.log('\n== 五单合计（每单 1 份，等权）');
for (const h of ['xkang', 'zcode', 'dsh']) { const rs = rows.filter(r => r.harness === h); const m = f => rs.reduce((a, r) => a + f(r), 0) / rs.length; const done = rs.filter(r => !r.empty); console.log(h.padEnd(6) + ' 出答案=' + done.length + '/5 要点得分=' + m(r => r.rate).toFixed(2) + ' 能直接用=' + m(r => r.usable).toFixed(1) + ' 肯定说错=' + m(r => r.wrongA).toFixed(1) + ' 平均用时=' + (done.reduce((a, r) => a + r.seconds, 0) / done.length / 60).toFixed(1) + '分钟'); }
console.log('\n== 只看三家都出了答案的 4 单（去掉 T001）');
for (const h of ['xkang', 'zcode', 'dsh']) { const rs = rows.filter(r => r.harness === h && r.ticket !== 'T001'); const m = f => rs.reduce((a, r) => a + f(r), 0) / rs.length; console.log(h.padEnd(6) + ' 要点得分=' + m(r => r.rate).toFixed(2) + ' 能直接用=' + m(r => r.usable).toFixed(1) + ' 肯定说错=' + m(r => r.wrongA).toFixed(1) + ' 平均用时=' + (rs.reduce((a, r) => a + r.seconds, 0) / rs.length / 60).toFixed(1) + '分钟'); }