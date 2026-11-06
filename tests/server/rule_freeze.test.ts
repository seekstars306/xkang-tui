// 规则层冻结守门：清单在 tests/eval/frozen-rules.json。
// 这里只做机器能做的三件事：anchor 是否还在、词表是否逐字未变、有没有偷偷新增工单派生词。
// 「新增了一条规则要登记」没法自动证明，但登记动作本身会进 git diff，配合下面第 3 条断言足以让静默新增不成立。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

interface FrozenEntry {
  id: string;
  class: 'ticket_derived' | 'general_procedure' | 'delivery_policy' | 'infrastructure';
  file: string;
  anchor: string;
  kind?: 'word_table';
  words?: string[];
  provenance: string;
}
interface Manifest {
  frozenAt: string;
  ticketDerivedCount: number;
  classes: string[];
  unfreezeCondition: string;
  entries: FrozenEntry[];
}

const ROOT = process.cwd();
const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/eval/frozen-rules.json'), 'utf8'));
const sources = new Map<string, string>();
const sourceOf = (file: string): string => {
  if (!sources.has(file)) sources.set(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
  return sources.get(file)!;
};

// 角色名词候选：出现这些词的地方必须已被登记的词表覆盖，否则就是又往规则层里塞了一个工单派生词。
// 需要扩充时把新候选加进来即可——它只会让守门更严。
const ROLE_WORD_CANDIDATES = ['开票经办人', '经办人', '操作人', '提交人', '财务', '收银员', '柜员', '制单人', '审核人', '前台', '客服主管'];

test('冻结清单：每条 anchor 仍逐字出现在对应源文件里', () => {
  assert.ok(manifest.entries.length > 0, '清单为空');
  for (const entry of manifest.entries) {
    assert.ok(fs.existsSync(path.join(ROOT, entry.file)), `${entry.id}: 源文件不存在 ${entry.file}`);
    assert.ok(
      sourceOf(entry.file).includes(entry.anchor),
      `${entry.id}: ${entry.file} 里已找不到 anchor「${entry.anchor}」——规则被改写或删除；按清单 unfreezeCondition 处理，不要直接删条目`,
    );
  }
});

test('冻结清单：工单派生词表逐字不变（过拟合风险最集中的地方）', () => {
  const tables = manifest.entries.filter(entry => entry.kind === 'word_table');
  assert.ok(tables.length >= 1, '清单里应至少登记一张工单派生词表');
  for (const entry of tables) {
    assert.ok(entry.words?.length, `${entry.id}: word_table 条目必须写出 words`);
    const match = sourceOf(entry.file).match(new RegExp(`${entry.anchor}\\s*=\\s*'([^']*)'`));
    assert.ok(match, `${entry.id}: 无法从 ${entry.file} 里按 ${entry.anchor} = '…' 提取词表`);
    assert.deepEqual(
      match![1].split('|'),
      entry.words,
      `${entry.id}: 词表变了。往规则层新增/删除工单派生词必须先改清单并写明理由（含留出集对照数据的时点）`,
    );
  }
});

test('冻结清单：没有未登记的角色类新增词', () => {
  const registered = new Set(manifest.entries.flatMap(entry => entry.words || []));
  assert.ok(registered.size > 0, '未登记任何词表，守门无意义');
  const reviewSource = sourceOf('server/src/agent/review.ts');
  const unregistered = ROLE_WORD_CANDIDATES.filter(word => !registered.has(word) && reviewSource.includes(word));
  assert.deepEqual(unregistered, [], `review.ts 出现了未登记的角色称谓：${unregistered.join('、')}——它只能来自某张工单，请先登记或删除`);
});

test('冻结清单：分类合法、id 唯一、出处齐备，ticket_derived 计数与声明一致', () => {
  const allowed = new Set(['ticket_derived', 'general_procedure', 'delivery_policy']);
  const ids = new Set<string>();
  for (const entry of manifest.entries) {
    assert.ok(allowed.has(entry.class), `${entry.id}: 清单条目的分类应为 ${[...allowed].join('/')} 之一，实为 ${entry.class}`);
    assert.ok(!ids.has(entry.id), `清单里 id 重复：${entry.id}`);
    ids.add(entry.id);
    assert.ok((entry.provenance || '').length > 8, `${entry.id}: 必须写出来处（哪张工单/哪次改动、为什么加）`);
  }
  const derived = manifest.entries.filter(entry => entry.class === 'ticket_derived');
  assert.equal(derived.length, manifest.ticketDerivedCount, 'ticket_derived 条数与清单声明不一致：新增工单派生规则要同步改计数');
  assert.match(manifest.unfreezeCondition, /留出集/, '解冻条件必须写明依赖留出集对照数据');
  assert.match(manifest.unfreezeCondition, /不允许再新增 ticket_derived/);
});
