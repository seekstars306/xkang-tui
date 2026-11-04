// 读 DSH 会话文件：按 zstd 帧魔数切分后逐帧解压，输出 JSONL 事件数组
import fs from 'node:fs';
import zlib from 'node:zlib';
export function readSession(file) {
  const buf = fs.readFileSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = []; let i = buf.indexOf(magic, 0);
  while (i >= 0) { starts.push(i); i = buf.indexOf(magic, i + 4); }
  let text = ''; let ok = 0, bad = 0;
  for (let k = 0; k < starts.length; k++) {
    const seg = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length);
    try { text += zlib.zstdDecompressSync(seg).toString('utf8'); ok++; } catch { bad++; }
  }
  const events = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { events, frames: starts.length, ok, bad };
}
if (import.meta.main) {
  const { events, frames, ok, bad } = readSession(process.argv[2]);
  const types = {}; for (const e of events) types[e.type] = (types[e.type] || 0) + 1;
  console.log(JSON.stringify({ frames, ok, bad, events: events.length, types }));
  for (const t of Object.keys(types).slice(0, 12)) console.log(t, '=>', JSON.stringify(events.find(e => e.type === t)).slice(0, 400));
}