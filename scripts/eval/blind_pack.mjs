import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// 盲评打包：去掉模型/开关标签、打乱顺序；评分细则与答案放一起，身份对照表单独存放。
// 用法：node scripts/eval/blind_pack.mjs <输出名>
const name = process.argv[2] || 'blind';
const OUT = path.join('eval_run', name);
const KEY = path.join('eval_run', name + '-key');
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(KEY, { recursive: true });
const runs = fs.readdirSync('eval_run');
const pick = (prefix) => runs.filter(d => d.startsWith(prefix)).sort();
const fmt = (a) => {
  if (!a) return '（没有发布任何答案）';
  const parts = ['【结论】' + (a.conclusion || '')];
  if (a.businessData?.length) parts.push('【业务数据】\n' + a.businessData.map(d => '- ' + d.label + '：' + d.value).join('\n'));
  if (a.evidenceSummary?.length) parts.push('【依据摘要】\n' + a.evidenceSummary.map(s => '- ' + s).join('\n'));
  if (a.customerReply) parts.push('【客服话术】' + a.customerReply);
  if (a.pendingItems?.length) parts.push('【待确认事项】\n' + a.pendingItems.map(s => '- ' + s).join('\n'));
  return parts.join('\n\n');
};
const entries = [];
// a12c3554：开关关（修复后）与开关开
const a12 = [
  ...['after-fix-2026', 'after-fix-r2-', 'after-fix-r3-'].flatMap(p => pick('replay-a12c3554-' + p)).map(d => ({ d, model: 'deepseek', sw: 'off' })),
  ...pick('replay-a12c3554-gemini-full-').map(d => ({ d, model: 'gemini', sw: 'off' })),
  ...pick('replay-a12c3554-ob-ds-').map(d => ({ d, model: 'deepseek', sw: 'on' })),
  ...pick('replay-a12c3554-ob-gm-').map(d => ({ d, model: 'gemini', sw: 'on' })),
  ...pick('replay-a12c3554-ob-cl-').map(d => ({ d, model: 'claude', sw: 'on' })),
];
for (const r of a12) {
  const f = path.join('eval_run', r.d, 'public.json');
  if (!fs.existsSync(f)) continue;
  const a = JSON.parse(fs.readFileSync(f, 'utf8')).final?.turns?.at(-1)?.answer;
  const audit = fs.existsSync(path.join('eval_run', r.d, 'audit.json')) ? JSON.parse(fs.readFileSync(path.join('eval_run', r.d, 'audit.json'), 'utf8')) : [];
  const l3 = audit.filter(x => x.type === 'llm_chat' && String(x.model).includes('[L3]'));
  entries.push({ ticket: 'a12c3554', text: fmt(a), key: { ...r, reviewStatus: a?.reviewStatus, l3: l3.length + '/' + l3.filter(x => !x.success).length + 'fail' } });
}
// 六工单中有金标准的四单：基线（deepseek 关）与本次对比（deepseek 开 / gemini 开），均带截图
const batches = [
  ...pick('batch-final-images-').map(d => ({ d, model: 'deepseek', sw: 'off' })),
  ...pick('batch-cmp-deepseek-images-').map(d => ({ d, model: 'deepseek', sw: 'on' })),
  ...pick('batch-cmp2-deepseek-images-').map(d => ({ d, model: 'deepseek', sw: 'on' })),
  ...pick('batch-cmp-gemini-images-').map(d => ({ d, model: 'gemini', sw: 'on' })),
  ...pick('batch-cmpre-gemini-images-').map(d => ({ d, model: 'gemini', sw: 'on', rerun: true })),
];
for (const b of batches) for (const t of ['T001', 'T003', 'T004', 'T006']) {
  const f = path.join('eval_run', b.d, t + '.json');
  if (!fs.existsSync(f)) continue;
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  const a = rec.answer;
  const l3 = (rec.metrics?.llmByModel || []).find(m => String(m.model).includes('[L3]'));
  const l2 = (rec.metrics?.llmByModel || []).find(m => String(m.model).includes('[L2]'));
  entries.push({ ticket: t, text: fmt(a), key: { ...b, reviewStatus: a?.reviewStatus, l3: l3 ? l3.n + '/' + l3.fail + 'fail' : 'none', l2: l2 ? l2.n + '/' + l2.fail + 'fail' : 'none', infraFail: Boolean(rec.isFallback && l2 && l2.fail > 0), minutes: rec.durationMin } });
}
for (const e of entries) e.blindId = 'X' + crypto.randomBytes(3).toString('hex');
entries.sort((x, y) => x.blindId.localeCompare(y.blindId));
const rubrics = {
  a12c3554: {
    question: '订单号 1564286324519862273 酒店部分退为啥选不了日期啊（附截图：部分退房页，顶部提示"只有入住了，才能进行部分退房操作……另外如果当天时间超过下午1点半，则该天不可退"，入离日期 10月26日-10月28日 2晚，日期列表为空）。提问时间 2026-10-27 18:13:31。',
    background: '已核实的事实：订单为华住（carrier=1002）酒店，入住 10/26、离店 10/28，共 2 晚。截图顶部那句提示只在华住分支（isHz=true）显示。华住分支的可退日期从"今天"起算到离店日前一晚（10/28 是离店日，不是一晚），并在当天已过 13:30 时剔除当天。所以 10/27 18:13 打开时列表只剩 10/27，又因已过 13:30 被剔除，列表为空。另有一条 10/27 18:17 由客服线下手动登记的部分退（退 10/27 一晚），比提问晚约 4 分钟。',
    items: [
      'A1 认定走的是华住分支（依据截图提示文案只在华住分支显示，或 carrier=1002 华住）',
      'A2 指出 13:30 截止规则：当天过了下午 1 点半，该天不可退',
      'A3 说明可选日期从当天起算，10/28 是离店日、不是可退的一晚（当时候选只有 10/27）',
      'A4 给出成因：提问时（10/27 18:13 左右）已过 13:30，10/27 被剔除，所以列表为空（可带"以打开时间约为 18:13 为前提"之类的前提）',
      'A5 区分时序：18:17 的客服线下部分退晚于提问，不能用它解释当时为什么选不了',
    ],
    wrongClaims: '把原因归为 18 点规则；说 10/26 或 10/28 是剩余可选日期；用 18:17 的退单解释当时的空列表；编造其他成因（如"只剩一晚不能全退""供应商数据未同步"）。',
  },
};
for (const t of ['T001', 'T003', 'T004', 'T006']) {
  const v = JSON.parse(fs.readFileSync(path.join('tests/eval/reports/_retest/tickets', t, 'verdict.json'), 'utf8'));
  const md = fs.readFileSync(path.join('tests/eval/reports/_retest/tickets', t, 'ticket.md'), 'utf8');
  rubrics[t] = { question: v.question, background: md, items: (v.L2?.items || []).map(i => i.item), itemNotes: (v.L2?.items || []).map(i => i.item + ' —— 历史判定说明（针对旧版答案，仅帮助理解要点含义）：' + i.verdict), wrongClaims: '与上述要点相反的说法，或没有证据支撑却说得很肯定的成因/动作。' };
}
fs.writeFileSync(path.join(OUT, 'pack.json'), JSON.stringify({ rubrics, answers: entries.map(e => ({ blindId: e.blindId, ticket: e.ticket, answer: e.text })) }, null, 2));
fs.writeFileSync(path.join(KEY, 'key.json'), JSON.stringify(entries.map(e => ({ blindId: e.blindId, ticket: e.ticket, ...e.key })), null, 2));
const count = {}; for (const e of entries) { const k = e.ticket + ' ' + e.key.model + ' ' + e.key.sw; count[k] = (count[k] || 0) + 1; }
console.log(JSON.stringify({ out: OUT, total: entries.length, count }, null, 1));
