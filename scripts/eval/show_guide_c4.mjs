import fs from 'node:fs';
import path from 'node:path';
const runs = fs.readdirSync('eval_run');
for (const arm of ['g0b', 'g2b']) {
  const d = runs.filter(x => x.startsWith('replay-sess-2f31a306-' + arm + '-c4a2f188-')).sort().at(-1);
  const a = JSON.parse(fs.readFileSync(path.join('eval_run', d, 'public.json'), 'utf8')).final?.turns?.at(-1)?.answer;
  console.log('==== ' + (arm === 'g0b' ? '旧写法' : '新写法'));
  console.log('【结论】' + a.conclusion);
  console.log('【还需确认】\n' + (a.pendingItems || []).map((x, i) => '  ' + (i + 1) + '. ' + x).join('\n'));
  console.log('【给提问人的回复】' + a.customerReply);
}