import fs from 'node:fs';
import path from 'node:path';
// 汇总对照实验：读 eval_run 下 replay-* 目录的 summary.json，按 case / 模型 / 开关分组列出关键指标。
const rows = [];
for (const d of fs.readdirSync('eval_run')) {
  if (!d.startsWith('replay-')) continue;
  const f = path.join('eval_run', d, 'summary.json');
  if (!fs.existsSync(f)) continue;
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!s.modelSlot && !/after-fix|review-time/.test(d)) continue;
  rows.push({ dir: d.slice(7, 60), caseName: s.caseName || 'a12c3554', model: s.modelSlot || 'deepseek', ob: s.observedBranch || 'off', sec: s.seconds, status: s.reviewStatus, c1330: s.names1330, hz: s.namesHuazhu, cause: (s.causeWordsInConclusion || []).join('/'), conclusion: String(s.conclusion || '').replace(/\s+/g, ' ').slice(0, 110) });
}
rows.sort((a, b) => (a.caseName + a.model + a.ob).localeCompare(b.caseName + b.model + b.ob));
for (const r of rows) console.log([r.caseName, r.model, 'ob=' + r.ob, r.sec + 's', r.status, '1330=' + r.c1330, 'hz=' + r.hz, r.cause ? 'CAUSE=' + r.cause : '', '|', r.conclusion].join(' '));