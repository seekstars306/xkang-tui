import fs from 'node:fs';
import path from 'node:path';
import { startIsolatedServer } from '../tests/helpers/isolated_server.ts';
import { BusinessClient } from '../src/adapters/business_client.ts';
import { parseSlot, slotOptions, effectiveSwitch, effectiveEnv } from './eval/model_env.ts';

/**
 * 用原本的 6 个工单回归当前系统。
 * 用法：node --import tsx scripts/eval_batch.ts <标签> [--images]
 *  - 默认只发文字（与之前两批的输入一致，可直接对比）；
 *  - --images 时连同工单原截图一起发（贴近飞书真实输入）。
 * 每批单独一个目录，不覆盖上一批；每个工单另存完整私有轨迹，便于事后判断失败发生在哪一步。
 */
const TICKETS = ['T001', 'T002', 'T003', 'T004', 'T006', 'T007'];
const label = (process.argv[2] || 'run').replace(/[^\w-]/g, '_');
const withImages = process.argv.includes('--images');
const argValue = (name: string) => process.argv.find(a => a.startsWith('--' + name + '='))?.split('=')[1];
const modelSlot = parseSlot(argValue('model'));
const slot = slotOptions(modelSlot);
const port = Number(argValue('port')) || 8693;
const observedBranch = effectiveSwitch(slot.env);
const reviewMode = effectiveEnv('REVIEW_MODE', 'gate', slot.env);
const OUT = path.resolve('eval_run', 'batch-' + label + '-' + modelSlot + (withImages ? '-images' : '-text') + '-' + new Date().toISOString().replace(/[:.]/g, '-'));
if (process.argv.includes('--dry')) { console.log(JSON.stringify({ OUT, modelSlot, port, withImages, observedBranch, reviewMode })); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });

function questionOf(id: string): string | any[] {
  const file = path.join('tests/eval/reports/_retest/tickets', id, id + '.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const texts: string[] = [];
  const images: any[] = [];
  for (const m of j.messages || []) {
    const c: any = m.content;
    if (typeof c === 'string') { if (c.trim()) texts.push(c.trim()); continue; }
    if (!Array.isArray(c)) continue;
    const t = c.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n').trim();
    if (t) texts.push(t);
    for (const p of c) if (p.type === 'image_url' && p.image_url?.url) images.push({ type: 'image_url', image_url: { url: p.image_url.url } });
  }
  const text = texts.join('\n\n').trim();
  return withImages && images.length ? [{ type: 'text', text }, ...images.slice(0, 4)] : text;
}

const summary: any[] = [];
// --only=T004,T006：只跑指定工单（补跑因网络故障兜底的单）
const onlyIds = argValue('only')?.split(',');
for (const id of (onlyIds ? TICKETS.filter(x => onlyIds.includes(x)) : TICKETS)) {
  const question = questionOf(id);
  const started = Date.now();
  let streamError: string | null = null;
  let answer: any = null;
  let metrics: any = {};
  const server = await startIsolatedServer(port, slot.model, { env: slot.env });
  try {
    const client = new BusinessClient(server.url, server.token);
    const session = await client.create();
    try {
      await client.chat(session.id, question, () => {});
    } catch (e: any) {
      streamError = String(e?.message ?? e).slice(0, 300);
    }
    const final: any = await client.get(session.id);
    answer = final?.turns?.at(-1)?.answer ?? null;
    try {
      const trace = await (await fetch(server.url + '/admin/agent/sessions/' + session.id, { headers: { Authorization: 'Bearer ' + server.adminToken } })).json();
      fs.writeFileSync(path.join(OUT, id + '.private.json'), JSON.stringify(trace, null, 2));
    } catch (e: any) { fs.writeFileSync(path.join(OUT, id + '.private.error.txt'), String(e?.message ?? e)); }
    const audit = server.readAudit() as any[];
    // 审计日志随临时库一起删除，单独存一份：复核为什么降级、哪一步失败都只记在这里
    fs.writeFileSync(path.join(OUT, id + '.audit.json'), JSON.stringify(audit, null, 2));
    const llm = audit.filter(r => r.type === 'llm_chat');
    const by: Record<string, { n: number; ms: number; fail: number }> = {};
    for (const r of llm) { const k = String(r.model || '?'); by[k] = by[k] || { n: 0, ms: 0, fail: 0 }; by[k].n++; by[k].ms += Number(r.duration_ms) || 0; if (!r.success) by[k].fail++; }
    const claims = Array.isArray(answer?.claims) ? answer.claims : [];
    metrics = {
      sessionId: session.id,
      seconds: Math.round((Date.now() - started) / 1000),
      inputImages: Array.isArray(question) ? question.filter((p: any) => p.type === 'image_url').length : 0,
      totalTokens: llm.reduce((s, r) => s + (Number(r.total_tokens) || 0), 0),
      toolCalls: audit.filter(r => r.type === 'tool_call').length,
      llmByModel: Object.entries(by).map(([model, v]) => ({ model, ...v })),
      claims: claims.length,
      confirmed: claims.filter((c: any) => c.status === 'confirmed').length,
      pendingReasons: claims.filter((c: any) => c.status === 'pending').map((c: any) => c.reason),
    };
  } finally {
    await server.stop();
  }
  const record = {
    id,
    durationMin: Math.round((Date.now() - started) / 600) / 100,
    modelSlot,
    observedBranch,
    reviewMode,
    streamError,
    reviewStatus: answer?.reviewStatus ?? null,
    conclusion: String(answer?.conclusion ?? ''),
    dataCount: answer?.businessData?.length ?? 0,
    pendingCount: answer?.pendingItems?.length ?? 0,
    evidenceCount: answer?.evidenceSummary?.length ?? 0,
    isFallback: /尚未形成可直接采信的业务结论|目前尚未得出可靠结论/.test(String(answer?.conclusion ?? '')),
    answer,
    metrics,
  };
  fs.writeFileSync(path.join(OUT, id + '.json'), JSON.stringify(record, null, 2));
  const l3 = (metrics.llmByModel || []).find((m: any) => String(m.model).includes('[L3]'));
  const line = [id, modelSlot, record.durationMin + 'min', record.reviewStatus, 'img=' + metrics.inputImages, 'data=' + record.dataCount, 'evid=' + record.evidenceCount, 'pend=' + record.pendingCount, 'claims=' + metrics.confirmed + '/' + metrics.claims, 'fallback=' + record.isFallback, l3 ? 'L3fail=' + l3.fail + '/' + l3.n : '', streamError ? 'ERR=' + streamError.slice(0, 80) : ''].join(' | ');
  console.log(line);
  summary.push(record);
}
fs.writeFileSync(path.join(OUT, '_batch.json'), JSON.stringify(summary.map(s => ({ id: s.id, durationMin: s.durationMin, reviewStatus: s.reviewStatus, dataCount: s.dataCount, evidenceCount: s.evidenceCount, pendingCount: s.pendingCount, isFallback: s.isFallback, confirmed: s.metrics.confirmed, claims: s.metrics.claims, streamError: s.streamError })), null, 2));
console.log('=== DONE === ' + OUT);
