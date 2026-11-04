import fs from 'node:fs';
import path from 'node:path';
const FB = '本次尚未形成可直接采信的业务结论';
const runs = fs.readdirSync('eval_run');
const out = [];
for (const d of runs.filter(x => /^(replay-a12c3554-g[02]b-|replay-sess-2f31a306-g[02]b-|batch-g[02]bT00)/.test(x)).sort()) {
  let concl = null, done = false, secs = null;
  const pub = path.join('eval_run', d, 'public.json');
  if (fs.existsSync(path.join('eval_run', d, 'summary.json'))) { done = true; concl = JSON.parse(fs.readFileSync(pub, 'utf8')).final?.turns?.at(-1)?.answer?.conclusion; secs = JSON.parse(fs.readFileSync(path.join('eval_run', d, 'summary.json'), 'utf8')).seconds; }
  for (const f of fs.readdirSync(path.join('eval_run', d)).filter(x => /^T00\d\.json$/.test(x))) { done = true; const r = JSON.parse(fs.readFileSync(path.join('eval_run', d, f), 'utf8')); concl = r.answer?.conclusion; secs = Math.round(r.durationMin * 60); }
  out.push(d.slice(0, 38).padEnd(39) + (done ? (String(concl || '').startsWith(FB) ? 'FALLBACK' : 'ok      ') + ' ' + secs + 's ' + String(concl || '').slice(0, 60) : 'running'));
}
console.log(out.join('\n'));