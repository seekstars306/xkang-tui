import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateAll, evaluateRepoTrust, isReleaseTag, type RepoState } from '../../server/src/codegraph/version_trust.ts';

const repo = (over: Partial<RepoState> = {}): RepoState => ({ relativePath: 'skt-back/skt_cxy', headSha: 'b87627d85', dirty: false, nearestTag: 'P1.2.1', headEqualsTag: true, ...over });
const entry = (over: Partial<{ repo: string; commit: string; artifactSha256: string }> = {}) => ({ repo: 'skt-back/skt_cxy', commit: 'b87627d85', artifactSha256: 'a'.repeat(64), ...over });

test('已核准：清单 commit 与 HEAD 一致且有制品标识（脏工作区也以清单为准）', () => {
  assert.equal(evaluateRepoTrust(repo(), entry()).level, 'approved');
  assert.equal(evaluateRepoTrust(repo({ dirty: true }), entry()).level, 'approved');
});

test('清单 commit 与 HEAD 不一致 → 未知（不能算推定）', () => {
  const verdict = evaluateRepoTrust(repo(), entry({ commit: 'ffdfe43aa' }));
  assert.equal(verdict.level, 'unknown');
  assert.match(verdict.reason, /不一致/);
});

test('推定：无清单、工作区干净、HEAD 恰好等于最新 P* 标签', () => {
  const verdict = evaluateRepoTrust(repo());
  assert.equal(verdict.level, 'presumed');
  assert.match(verdict.reason, /P1\.2\.1/);
});

test('未知：HEAD 越过最新 P 标签', () => {
  assert.equal(evaluateRepoTrust(repo({ headEqualsTag: false })).level, 'unknown');
});

test('未知：只有 T 前缀标签（T1.0.0 不是发布标签）', () => {
  const verdict = evaluateRepoTrust(repo({ nearestTag: 'T1.0.0' }));
  assert.equal(verdict.level, 'unknown');
  assert.match(verdict.reason, /不是 P\*/);
  assert.equal(isReleaseTag('T1.0.0'), false);
  assert.equal(isReleaseTag('P1.2.1'), true);
});

test('未知：仓库没有任何标签', () => {
  assert.equal(evaluateRepoTrust(repo({ nearestTag: '', headEqualsTag: false })).level, 'unknown');
});

test('未知：脏工作区即使 HEAD 等于 P 标签也不算推定', () => {
  const verdict = evaluateRepoTrust(repo({ dirty: true }));
  assert.equal(verdict.level, 'unknown');
  assert.match(verdict.reason, /未提交改动/);
});

test('evaluateAll：按 repo 匹配清单并汇总三档计数', () => {
  const report = evaluateAll([
    repo({ relativePath: 'skt-back/skt_cxy' }),
    repo({ relativePath: 'skt-back/logmanage', nearestTag: 'P1.0.9' }),
    repo({ relativePath: 'skt-back/prod-config', nearestTag: 'T1.0.0' }),
    repo({ relativePath: 'skt-front/skt_new_webview', nearestTag: '', headEqualsTag: false }),
    repo({ relativePath: 'skt-remote/skt-remote', nearestTag: 'P1.0.7', dirty: true }),
  ], [entry()]);
  assert.equal(report.manifestLoaded, true);
  assert.equal(report.summary.approved, 1);
  assert.equal(report.summary.presumed, 1);
  assert.equal(report.summary.unknown, 3);
  assert.equal(report.repos.find(r => r.relativePath === 'skt-back/prod-config')!.verdict.level, 'unknown');
});
