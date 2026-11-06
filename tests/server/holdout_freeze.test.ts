// 留出集冻结工具的守门测试：全部在临时目录里跑，不碰真实 tests/eval/data/tickets/。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MANIFEST_FILE,
  PREREGISTERED_THRESHOLDS,
  ensureTicketDir,
  freezeHoldout,
  holdoutStats,
  loadTickets,
  validateTicket,
  verifyHoldout,
} from '../../scripts/eval/holdout.ts';

const ticket = (id: string, over: Record<string, unknown> = {}) => ({
  ticket_id: id,
  business_line: '酒店',
  question_type: 'specific_order',
  core_demand: '核对重复开票',
  event_time: '2026-10-14 09:00:00',
  snapshot_time: '2026-10-16 12:00:00',
  services: ['invoice'],
  answerable: true,
  background: '客服反馈同一订单出现两张金额相同的发票。',
  attachments: [],
  deidentified: false,
  question: '为什么同一个订单重复开了两张发票？',
  ...over,
});

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'xkang-holdout-'));
const writeTicket = (dir: string, id: string, over: Record<string, unknown> = {}, fileName = `${id}.json`): void =>
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(ticket(id, over), null, 2));

test('--init 建目录与说明，说明里写明字段与 git 忽略红线', () => {
  const dir = path.join(tempDir(), 'tickets');
  ensureTicketDir(dir);
  assert.ok(fs.existsSync(dir));
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  for (const field of ['ticket_id', 'core_demand', 'snapshot_time', 'answerable', 'deidentified']) assert.ok(readme.includes(field), `说明缺字段 ${field}`);
  assert.match(readme, /git 忽略/);
  // 幂等：已有说明不被覆盖
  fs.writeFileSync(path.join(dir, 'README.md'), 'hand-edited', 'utf8');
  ensureTicketDir(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'hand-edited');
});

test('冻结：写清单（顺序、逐文件 sha256、manifestHash、预登记判定线）', () => {
  const dir = tempDir();
  for (const id of ['T003', 'T001', 'T002']) writeTicket(dir, id);
  const manifest = freezeHoldout({ dir, seed: 20261016, now: new Date('2026-10-16T00:00:00Z') });
  assert.equal(manifest.ticketCount, 3);
  assert.equal(manifest.seed, 20261016);
  assert.equal(manifest.order.length, 3);
  assert.deepEqual([...manifest.order.map(entry => entry.ticket_id)].sort(), ['T001', 'T002', 'T003']);
  for (const entry of manifest.order) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.equal(entry.sha256, fs.existsSync(path.join(dir, entry.file)) ? entry.sha256 : 'missing');
  }
  assert.match(manifest.manifestHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(manifest.thresholds.release, PREREGISTERED_THRESHOLDS.release);
  assert.equal(manifest.frozenAt, '2026-10-16T00:00:00.000Z');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
  assert.equal(onDisk.manifestHash, manifest.manifestHash);
  // 同种子重冻得到同一顺序（可复现）
  const again = freezeHoldout({ dir, seed: 20261016, force: true, reason: '同种子复现性检查，顺序应一致' });
  assert.deepEqual(again.order.map(entry => entry.ticket_id), manifest.order.map(entry => entry.ticket_id));
});

test('verify：干净时通过，改动/新增/删失单分别被抓到', () => {
  const dir = tempDir();
  for (const id of ['T001', 'T002']) writeTicket(dir, id);
  freezeHoldout({ dir });
  assert.deepEqual(verifyHoldout({ dir }), { ...verifyHoldout({ dir }), ok: true });
  assert.equal(verifyHoldout({ dir }).ok, true);

  // 改动一题的正文
  writeTicket(dir, 'T001', { core_demand: '核对重复开票（改过）' });
  const drifted = verifyHoldout({ dir });
  assert.equal(drifted.ok, false);
  assert.deepEqual(drifted.drifted, ['T001']);
  writeTicket(dir, 'T001');

  // 新增一题
  writeTicket(dir, 'T003');
  const added = verifyHoldout({ dir });
  assert.deepEqual(added.added, ['T003']);
  fs.unlinkSync(path.join(dir, 'T003.json'));

  // 删除一题
  fs.unlinkSync(path.join(dir, 'T002.json'));
  const missing = verifyHoldout({ dir });
  assert.deepEqual(missing.missing, ['T002']);
  assert.equal(missing.ok, false);
});

test('冻结后拒绝覆盖；refreeze 必须给理由，并留档 .prev', () => {
  const dir = tempDir();
  writeTicket(dir, 'T001');
  freezeHoldout({ dir });
  assert.throws(() => freezeHoldout({ dir }), /--refreeze/);
  assert.throws(() => freezeHoldout({ dir, force: true, reason: '太短' }), /不少于 8 个字/);
  writeTicket(dir, 'T002');
  const refrozen = freezeHoldout({ dir, force: true, reason: '补入第二批工单，本次追加 1 单' });
  assert.equal(refrozen.ticketCount, 2);
  assert.match(String(refrozen.reason), /补入第二批/);
  assert.ok(fs.existsSync(path.join(dir, `${MANIFEST_FILE}.prev`)));
  const prev = JSON.parse(fs.readFileSync(path.join(dir, `${MANIFEST_FILE}.prev`), 'utf8'));
  assert.equal(prev.ticketCount, 1);
  assert.equal(verifyHoldout({ dir }).ok, true);
});

test('校验：缺字段、类型错、重复 ticket_id、文件名不一致都会拦住冻结', () => {
  const dir = tempDir();
  writeTicket(dir, 'T001', { answerable: 'yes' });
  assert.ok(validateTicket(ticket('T001', { answerable: 'yes' })).some(error => error.includes('answerable 必须是布尔值')));
  assert.ok(validateTicket({ ticket_id: 'T001' }).length >= 10);
  assert.throws(() => freezeHoldout({ dir }), /answerable 必须是布尔值/);

  const dir2 = tempDir();
  writeTicket(dir2, 'T001', {}, 'T001-副本.json');
  assert.throws(() => freezeHoldout({ dir: dir2 }), /文件名应与 ticket_id 一致/);

  const dir3 = tempDir();
  writeTicket(dir3, 'T001');
  writeTicket(dir3, 'T001', {}, 'T001.json');
  fs.writeFileSync(path.join(dir3, 'T009.json'), JSON.stringify(ticket('T001'), null, 2));
  assert.throws(() => freezeHoldout({ dir: dir3 }), /ticket_id 重复/);
});

test('空留出集不冻结；stats 按业务线与题型统计', () => {
  const empty = tempDir();
  assert.throws(() => freezeHoldout({ dir: empty }), /留出集为空/);

  const dir = tempDir();
  writeTicket(dir, 'T001');
  writeTicket(dir, 'T002', { business_line: '机票', question_type: 'historical_event', answerable: false });
  writeTicket(dir, 'T003', { ground_truth: '已由开发核对' });
  const stats = holdoutStats(loadTickets(dir));
  assert.equal(stats.total, 3);
  assert.equal(stats.answerable, 2);
  assert.equal(stats.unanswerable, 1);
  assert.equal(stats.byLine['酒店'], 2);
  assert.equal(stats.byLine['机票'], 1);
  assert.equal(stats.byType['historical_event'], 1);
  assert.equal(stats.withoutGroundTruth, 2);
});

test('工单目录确实被 git 忽略（工单原文不得进 git）', () => {
  const ignore = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8');
  const lines = ignore.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  // `data/`（无前导斜杠）在所有层级上匹配，可覆盖 tests/eval/data/tickets/**；有前导斜杠的 /data/ 只匹配根目录，不算
  assert.ok(lines.includes('data/'), '`.gitignore` 必须保留 `data/` 规则，才能忽略 tests/eval/data/tickets/**');
});
