import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const modulePath = '../../scripts/eval/release_gate.mjs';
const { evaluateRelease, checkReleaseReport } = await import(modulePath);
test('缺少业务评分、隐私测试或构建验证时不允许正式分发', () => {
  assert.equal(evaluateRelease({}, [], {}).passed, false);
  const cases = Array.from({ length: 20 }, (_, i) => ({ id: String(i) }));
  const grades = cases.flatMap(c => [1, 2, 3].flatMap(round => ['baseline', 'candidate'].map(variant => ({ variant, caseId: c.id, round, usable: true, completed: true, severeMisleading: false, grade: 'usable', rationale: '人工核对对应业务证据', evidenceChecked: true }))));
  const checks = Object.fromEntries(['unit', 'typecheck', 'integration', 'chromeUi', 'privacy', 'businessIdentifiers', 'candidateExe', 'migration'].map(key => [key, true]));
  assert.equal(evaluateRelease({ cases }, grades, checks).passed, true);
  assert.equal(evaluateRelease({ cases }, grades, { ...checks, privacy: false }).passed, false);
  grades.find(g => g.variant === 'candidate')!.severeMisleading = true;
  assert.equal(evaluateRelease({ cases }, grades, checks).passed, false);
});
test('已验收的候选包被替换后必须阻止分发', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xkang-release-'));
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  try {
    fs.writeFileSync(path.join(directory, 'source.ts'), 'frozen');
    fs.writeFileSync(path.join(directory, 'candidate.exe'), 'tested');
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ sourceHashes: { 'source.ts': hash('frozen') } }));
    fs.writeFileSync(path.join(directory, 'grades.json'), '[]');
    fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify({ sourceHashes: { 'source.ts': hash('frozen') }, candidate: { path: 'candidate.exe', sha256: hash('tested') } }));
    assert.equal(checkReleaseReport(directory, directory).reasons.includes('候选包在验收后改变'), false);
    fs.writeFileSync(path.join(directory, 'candidate.exe'), 'rebuilt');
    assert.equal(checkReleaseReport(directory, directory).reasons.includes('候选包在验收后改变'), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
