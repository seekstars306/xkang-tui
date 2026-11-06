import fs from 'node:fs';
const name = process.argv[2] || 'blind-samemodel';
const scores = JSON.parse(fs.readFileSync('eval_run/' + name + '/scores.json', 'utf8'));
const key = Object.fromEntries(JSON.parse(fs.readFileSync('eval_run/' + name + '-key/key.json', 'utf8')).map(k => [k.blindId, k]));
const val = { hit: 1, partial: 0.5, miss: 0 };
const rows = scores.map(s => { const k = key[s.blindId]; const its = Object.values(s.items || {}); return { ...k, rate: its.reduce((a, v) => a + (val[v] ?? 0), 0) / (its.length || 1), wrongA: (s.wrongClaims || []).filter(w => w.where === 'asserted').length, usable: s.usable, note: s.note }; });
for (const r of rows.sort((a, b) => (a.ticket + a.arm).localeCompare(b.ticket + b.arm))) console.log([r.ticket, r.arm, 'rate=' + r.rate.toFixed(2), 'use=' + r.usable, 'wrongA=' + r.wrongA, r.empty ? '（未作答）' : '', '|', r.note].join(' '));
console.log('\n== 五单（每单等权）');
for (const arm of ['dsh-claude', 'dsh-deepseek', 'zcode-deepseek', 'xkang-deepseek-reasoning', 'xkang-deepseek']) {
  const rs = rows.filter(r => r.arm === arm); if (!rs.length) continue;
  const per = {}; for (const r of rs) (per[r.ticket] = per[r.ticket] || []).push(r);
  const avg = f => Object.values(per).reduce((a, g) => a + g.reduce((x, r) => x + f(r), 0) / g.length, 0) / Object.keys(per).length;
  const a12 = per.a12c3554 ? per.a12c3554.map(r => r.rate.toFixed(2)).join('/') : '-';
  console.log(arm.padEnd(25) + ' 要点得分=' + avg(r => r.rate).toFixed(2) + ' 能直接用=' + avg(r => r.usable).toFixed(1) + ' 肯定说错=' + avg(r => r.wrongA).toFixed(1) + ' 未作答=' + rs.filter(r => r.empty).length + ' a12c3554=' + a12);
}