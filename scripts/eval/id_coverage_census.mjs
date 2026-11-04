import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// 统计：客服问题里给出的长号码（≥10 位数字，含手机号/订单号/票号），在最终答案里有没有被交代
const ids = t => [...new Set((String(t).match(/(?<!\d)\d{10,20}(?!\d)/g) || []))];
const answerText = a => !a ? '' : [a.conclusion, ...(a.businessData || []).map(x => x.label + ' ' + x.value), ...(a.evidenceSummary || []), a.customerReply, ...(a.pendingItems || [])].join('\n');
const textOf = c => typeof c === 'string' ? c : (c || []).filter(p => p.type === 'text').map(p => p.text).join('');
const rows = [];
// 线上会话（全部）
const db = new DatabaseSync('data/xkang.db', { readOnly: true });
for (const r of db.prepare('SELECT id, created_at, private_json, public_json FROM agent_sessions ORDER BY created_at').all()) {
  let msgs, pub; try { msgs = JSON.parse(r.private_json); pub = JSON.parse(r.public_json); } catch { continue; }
  const q = msgs.find(m => m.role === 'user' && !m.internal && !m.isReminder);
  const a = pub.turns?.[0]?.answer;
  if (!q || !a || String(a.conclusion || '').startsWith('本次尚未形成')) continue;
  const qt = textOf(q.content).replace(/问题编号 [0-9a-f]{8}/g, '');
  const want = ids(qt); if (!want.length) continue;
  const at = answerText(a);
  rows.push({ src: 'prod ' + r.created_at.slice(0, 10), id: r.id.slice(2, 10), want: want.length, missing: want.filter(x => !at.includes(x)) });
}
const withMiss = rows.filter(r => r.missing.length);
console.log('线上带长号码的已答问题', rows.length, '有号码没交代的', withMiss.length, '(' + (100 * withMiss.length / Math.max(1, rows.length)).toFixed(0) + '%)');
for (const r of withMiss.slice(-15)) console.log(' ', r.src, r.id, '问题号码数=' + r.want, '没交代=' + r.missing.join(','));
process.exit(0);