import fs from 'node:fs';
const name = process.argv[2] || 'blind-sameconfig';
const scores = JSON.parse(fs.readFileSync('eval_run/' + name + '/scores.json', 'utf8'));
const key = Object.fromEntries(JSON.parse(fs.readFileSync('eval_run/' + name + '-key/key.json', 'utf8')).map(k => [k.blindId, k]));
const val = { hit: 1, partial: 0.5, miss: 0 };
const rows = scores.map(s => { const k = key[s.blindId]; const its = Object.values(s.items || {}); return { ...k, rate: its.reduce((a, v) => a + (val[v] ?? 0), 0) / (its.length || 1), wrongA: (s.wrongClaims || []).filter(w => w.where === 'asserted').length, usable: s.usable, note: s.note }; });
for (const r of rows.sort((a, b) => (a.ticket + a.arm).localeCompare(b.ticket + b.arm))) console.log([r.ticket, r.arm.padEnd(10), 'rate=' + r.rate.toFixed(2), 'use=' + r.usable, 'wrongA=' + r.wrongA, r.seconds != null ? r.seconds + 's' : '', r.empty ? '（未作答）' : '', '|', r.note].join(' '));
const view = (label, pick) => {
  console.log('\n== ' + label);
  for (const [arm, sel] of Object.entries(pick)) {
    const per = {}; for (const t of ['a12c3554', 'T001', 'T003', 'T004', 'T006']) { const rs = sel(t); if (rs.length) per[t] = rs; }
    const n = Object.keys(per).length; if (!n) continue;
    const avg = f => Object.values(per).reduce((a, g) => a + g.reduce((x, r) => x + f(r), 0) / g.length, 0) / n;
    const answered = Object.values(per).filter(g => g.some(r => !r.empty)).length;
    console.log(arm.padEnd(8) + ' 工单=' + n + ' 有答案=' + answered + ' 要点得分=' + avg(r => r.rate).toFixed(2) + ' 能直接用=' + avg(r => r.usable).toFixed(1) + ' 肯定说错=' + avg(r => r.wrongA).toFixed(1));
  }
};
const of = (arm, t) => rows.filter(r => r.arm === arm && r.ticket === t);
view('统一 20 分钟（未作答计 0 分）', { xkang: t => of('xkang', t), DSH: t => of('dsh-20', t), zcode: t => of('zcode-20', t) });
view('放宽到 45 分钟（20 分钟内已完成的沿用原结果）', { xkang: t => of('xkang', t), DSH: t => (of('dsh-45ext', t).length ? of('dsh-45ext', t) : of('dsh-20', t)), zcode: t => (of('zcode-45ext', t).length ? of('zcode-45ext', t) : of('zcode-20', t)) });