import fs from 'node:fs';
const name = process.argv[2] || 'blind-harness';
const scores = JSON.parse(fs.readFileSync('eval_run/' + name + '/scores.json', 'utf8'));
const key = Object.fromEntries(JSON.parse(fs.readFileSync('eval_run/' + name + '-key/key.json', 'utf8')).map(k => [k.blindId, k]));
const val = { hit: 1, partial: 0.5, miss: 0 };
const rows = scores.map(s => { const k = key[s.blindId]; const its = Object.values(s.items || {}); return { ...k, rate: its.reduce((a, v) => a + (val[v] ?? 0), 0) / (its.length || 1), wrongA: (s.wrongClaims || []).filter(w => w.where === 'asserted').length, usable: s.usable, note: s.note }; });
for (const r of rows.sort((a, b) => (a.ticket + a.harness).localeCompare(b.ticket + b.harness))) console.log([r.ticket, r.harness, 'rate=' + r.rate.toFixed(2), 'use=' + r.usable, 'wrongA=' + r.wrongA, '|', r.note].join(' '));
// 每个框架：先按工单求平均，再对五单取平均（a12c3554 在 xkang 有 3 份，避免它权重过大）
console.log('\n== 五单（每单等权）');
for (const h of ['dsh', 'zcode', 'xkang-off', 'xkang-gate']) {
  const rs = rows.filter(r => r.harness === h); if (!rs.length) continue;
  const per = {}; for (const r of rs) (per[r.ticket] = per[r.ticket] || []).push(r);
  const avg = f => Object.values(per).reduce((a, g) => a + g.reduce((x, r) => x + f(r), 0) / g.length, 0) / Object.keys(per).length;
  console.log(h.padEnd(11) + ' 工单数=' + Object.keys(per).length + ' 要点得分=' + avg(r => r.rate).toFixed(2) + ' 能直接用=' + avg(r => r.usable).toFixed(1) + ' 肯定说错=' + avg(r => r.wrongA).toFixed(1) + ' 模型=' + rs[0].model);
}