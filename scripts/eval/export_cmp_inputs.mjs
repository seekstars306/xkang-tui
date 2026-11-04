import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// 导出与 xkang 评测完全相同的输入（文字 + 截图），供 DSH / zcode 对照使用。
const ROOT = 'D:/xk_cmp';
const saveImages = (id, parts) => parts.map((p, i) => {
  const url = p.image_url.url; const comma = url.indexOf(','); const mime = url.slice(5, url.indexOf(';'));
  const file = path.join(ROOT, 'inputs', id, 'image-' + (i + 1) + '.' + mime.slice(6).replace('jpeg', 'jpg'));
  fs.writeFileSync(file, Buffer.from(url.slice(comma + 1), 'base64')); return file.replace(/\\/g, '/');
});
const cases = [];
const add = (id, text, imageParts) => {
  fs.mkdirSync(path.join(ROOT, 'inputs', id), { recursive: true });
  const images = saveImages(id, imageParts);
  fs.writeFileSync(path.join(ROOT, 'inputs', id, 'question.md'), text + '\n');
  cases.push({ id, text, images });
};
const db = new DatabaseSync('data/xkang.db', { readOnly: true });
const first = JSON.parse(db.prepare('SELECT private_json FROM agent_sessions WHERE id=?').get('s_c6f265a076ea482195a36e9ca07565a4').private_json).find(m => m.role === 'user' && !m.internal && !m.isReminder);
db.close();
add('a12c3554', first.content.filter(p => p.type === 'text').map(p => p.text).join('\n'), first.content.filter(p => p.type === 'image_url'));
for (const id of ['T001', 'T003', 'T004', 'T006']) {
  const j = JSON.parse(fs.readFileSync(path.join('tests/eval/reports/_retest/tickets', id, id + '.json'), 'utf8'));
  const texts = [], images = [];
  for (const m of j.messages || []) {
    const c = m.content;
    if (typeof c === 'string') { if (c.trim()) texts.push(c.trim()); continue; }
    if (!Array.isArray(c)) continue;
    const t = c.filter(p => p.type === 'text').map(p => p.text).join('\n').trim(); if (t) texts.push(t);
    for (const p of c) if (p.type === 'image_url' && p.image_url?.url) images.push(p);
  }
  add(id, texts.join('\n\n').trim(), images.slice(0, 4));
}
// zcode 用例：同样的文字，末尾注明截图文件路径（zcode 用自己的 Read 工具看图）
fs.mkdirSync(path.join(ROOT, 'zcode-a'), { recursive: true }); fs.mkdirSync(path.join(ROOT, 'zcode-b'), { recursive: true });
const zc = c => ({ id: c.id, split: 'holdout', title: c.id, input: c.text + (c.images.length ? '\n\n【附件截图】以下是客服上传的截图文件，请用 Read 工具查看：\n' + c.images.join('\n') : '') });
fs.writeFileSync(path.join(ROOT, 'zcode-a', 'cases.json'), JSON.stringify(cases.filter(c => ['a12c3554', 'T001', 'T003'].includes(c.id)).map(zc), null, 1));
fs.writeFileSync(path.join(ROOT, 'zcode-b', 'cases.json'), JSON.stringify(cases.filter(c => ['T004', 'T006'].includes(c.id)).map(zc), null, 1));
fs.writeFileSync(path.join(ROOT, 'inputs', 'manifest.json'), JSON.stringify(cases.map(c => ({ id: c.id, chars: c.text.length, images: c.images })), null, 1));
console.log(JSON.stringify(cases.map(c => ({ id: c.id, chars: c.text.length, images: c.images.length }))));