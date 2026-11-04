import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function evaluateRelease(manifest, grades, verification) {
  const reasons = [];
  if (manifest?.cases?.length !== 20 || new Set(manifest?.cases?.map(c => c.id)).size !== 20) reasons.push('必须预登记20道不同问题');
  const expected = new Set((manifest?.cases || []).flatMap(c => [1, 2, 3].flatMap(round => ['baseline', 'candidate'].map(variant => `${variant}:${c.id}:${round}`))));
  if (!Array.isArray(grades) || grades.length !== 120 || new Set(grades.map(g => `${g.variant}:${g.caseId}:${g.round}`)).size !== 120 || grades.some(g => !expected.has(`${g.variant}:${g.caseId}:${g.round}`))) reasons.push('两版各60次评分必须完整且无重复');
  const candidate = (grades || []).filter(g => g.variant === 'candidate');
  if (candidate.filter(g => g.usable === true).length < 54) reasons.push('新版完整可用次数不足54');
  if (candidate.filter(g => g.completed === true).length < 59) reasons.push('新版正常结束次数不足59');
  if (candidate.some(g => g.severeMisleading !== false)) reasons.push('严重误导未全部核验为零');
  if ((grades || []).some(g => !g.rationale || !g.evidenceChecked || !['usable', 'partial', 'incorrect', 'runtime_failure'].includes(g.grade))) reasons.push('必须逐次核验证据，不能用模型自评或关键词代替评分');
  for (const check of ['unit', 'typecheck', 'integration', 'chromeUi', 'privacy', 'businessIdentifiers', 'candidateExe', 'migration']) if (verification?.[check] !== true) reasons.push(`验证未完成: ${check}`);
  return { passed: reasons.length === 0, reasons };
}

export function checkReleaseReport(directory, root = process.cwd()) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const grades = JSON.parse(fs.readFileSync(path.join(directory, 'grades.json'), 'utf8'));
  const verification = JSON.parse(fs.readFileSync(path.join(directory, 'verification.json'), 'utf8'));
  const result = evaluateRelease(manifest, grades, verification);
  if (!manifest.sourceHashes || !Object.keys(manifest.sourceHashes).length) result.reasons.push('缺少实现冻结哈希');
  const evaluationFiles = new Set(manifest.evaluationFiles || Object.keys(manifest.sourceHashes || {}));
  for (const [file, expected] of Object.entries(manifest.sourceHashes || {}).filter(([file]) => evaluationFiles.has(file))) {
    const actual = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    if (actual !== expected) result.reasons.push(`源码已在验收后改变: ${file}`);
  }
  if (manifest.businessPromptSourceHash) {
    const source = fs.readFileSync(path.join(root, 'server/src/agent/service.ts'), 'utf8').match(/export const BUSINESS_PROMPT = `[\s\S]*?`;/)?.[0];
    if (!source || createHash('sha256').update(source).digest('hex') !== manifest.businessPromptSourceHash) result.reasons.push('业务提示词在评测后改变');
  }
  if (!verification.sourceHashes || !Object.keys(verification.sourceHashes).length) result.reasons.push('缺少最终接口、客户端及构建验证的源码哈希');
  for (const [file, expected] of Object.entries(verification.sourceHashes || {})) {
    if (createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') !== expected) result.reasons.push(`最终验证后源码改变: ${file}`);
  }
  const candidate = verification.candidate;
  if (!candidate?.path || !/^[a-f0-9]{64}$/.test(candidate.sha256 || '')) result.reasons.push('缺少已验收候选包哈希');
  else if (createHash('sha256').update(fs.readFileSync(path.resolve(root, candidate.path))).digest('hex') !== candidate.sha256) result.reasons.push('候选包在验收后改变');
  result.passed = result.reasons.length === 0;
  return result;
}
