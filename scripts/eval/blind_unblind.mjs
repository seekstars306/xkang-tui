import fs from 'node:fs';
// 揭盲汇总：scores.json × key.json，按 工单/模型/开关 分组
const scores = JSON.parse(fs.readFileSync('eval_run/blind-20261029/scores.json', 'utf8'));
const key = Object.fromEntries(JSON.parse(fs.readFileSync('eval_run/blind-20261029-key/key.json', 'utf8')).map(k => [k.blindId, k]));
const val = { hit: 1, partial: 0.5, miss: 0 };
const rows = [];
for (const s of scores) {
  const k = key[s.blindId];
  if (!k) { console.log('no key for', s.blindId); continue; }
  const its = Object.values(s.items || {});
  const rate = its.length ? its.reduce((a, v) => a + (val[v] ?? 0), 0) / its.length : 0;
  rows.push({ ticket: s.ticket, model: k.model, sw: k.sw, infra: !!k.infraFail || (k.model === 'claude' && /尚未形成/.test(s.note || '')), rate, hits: its.filter(v => v === 'hit').length + '/' + its.length, wrongAsserted: (s.wrongClaims || []).filter(w => w.where === 'asserted').length, wrongAny: (s.wrongClaims || []).length, usable: s.usable, l3: k.l3, minutes: k.minutes, items: s.items, note: s.note, wrong: (s.wrongClaims || []).map(w => w.where + ':' + w.quote) });
}
rows.sort((a, b) => (a.ticket + a.model + a.sw).localeCompare(b.ticket + b.model + b.sw));
console.log('== 逐条');
for (const r of rows) console.log([r.ticket, r.model, 'sw=' + r.sw, r.infra ? 'INFRA' : '', 'rate=' + r.rate.toFixed(2), 'hit=' + r.hits, 'wrongA=' + r.wrongAsserted, 'use=' + r.usable, 'L3=' + (r.l3 || ''), r.minutes ? r.minutes + 'min' : '', '|', JSON.stringify(r.items), '|', r.note, r.wrong.length ? '| ' + r.wrong.join(' / ').slice(0, 220) : ''].join(' '));
const groups = {};
for (const r of rows.filter(r => !r.infra)) { const g = r.ticket + ' ' + r.model + ' ' + r.sw; (groups[g] = groups[g] || []).push(r); }
console.log('\n== 分组均值（不含网络故障兜底）');
for (const [g, rs] of Object.entries(groups)) {
  const m = f => (rs.reduce((a, r) => a + f(r), 0) / rs.length);
  console.log(g.padEnd(26) + ' n=' + rs.length + ' rate=' + m(r => r.rate).toFixed(2) + ' usable=' + m(r => r.usable).toFixed(1) + ' wrongAsserted=' + m(r => r.wrongAsserted).toFixed(1));
}
const byModelSw = {};
for (const r of rows.filter(r => !r.infra && r.ticket !== 'a12c3554')) { const g = r.model + ' ' + r.sw; (byModelSw[g] = byModelSw[g] || []).push(r); }
console.log('\n== 四单合计（不含网络故障兜底）');
for (const [g, rs] of Object.entries(byModelSw)) {
  const m = f => (rs.reduce((a, r) => a + f(r), 0) / rs.length);
  console.log(g.padEnd(16) + ' n=' + rs.length + ' rate=' + m(r => r.rate).toFixed(2) + ' usable=' + m(r => r.usable).toFixed(1) + ' wrongAsserted=' + m(r => r.wrongAsserted).toFixed(1));
}
console.log('\n== 网络故障兜底（未计入）: ' + rows.filter(r => r.infra).map(r => r.ticket + ' ' + r.model).join(', '));