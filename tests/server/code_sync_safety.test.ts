import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CodeSyncManager } from '../../server/src/codegraph/sync_manager.ts';

interface Call { command: string; cwd: string }

/** 记录调用并按命令关键词分发的假 git 执行器；stdout 传数组时按顺序消耗（用于 before/after SHA） */
function fakeGit(handlers: Array<[string, { stdout?: string | string[]; error?: string }]>) {
  const calls: Call[] = [];
  const run = async (command: string, options: { cwd: string; timeout: number }) => {
    calls.push({ command, cwd: options.cwd });
    for (const [pattern, result] of handlers) {
      if (!command.includes(pattern)) continue;
      if (result.error) throw new Error(result.error);
      const out = result.stdout;
      const value = Array.isArray(out) ? (out.length ? `${out.shift()}\n` : '') : `${out ?? ''}\n`;
      return { stdout: value, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  return { run, calls };
}

/** 只实现 rebuildIndex() 和 getStats() 的替身 service */
function stubService() {
  const state = { rebuildCalls: 0, stats: null as any };
  const service = {
    rebuildIndex: async () => { state.rebuildCalls++; state.stats = { totalFiles: 3, totalDefinitions: 7 }; return { stats: state.stats }; },
    getStats: () => state.stats,
  };
  return { state, service: service as any };
}

function makeMirror(repos: string[]): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-mirror-'));
  for (const repo of repos) fs.mkdirSync(path.join(root, repo, '.git'), { recursive: true });
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function forbiddenCommands(calls: Call[]): string[] {
  return calls.filter(c => /\b(reset|clean|checkout)\b/.test(c.command)).map(c => c.command);
}

/** Windows 下 path.relative 返回反斜杠，统一成正斜杠再比对 */
const posix = (value: string) => value.replace(/\\/g, '/');

test('工作区有未提交改动时跳过拉取，绝不执行 reset/pull，mirror-health.json 记 dirty', async () => {
  const mirror = makeMirror(['skt-back/skt_cxy']);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-graph-'));
  try {
    const git = fakeGit([
      ['fetch --all --prune', { stdout: '' }],
      ['status --porcelain', { stdout: ' M src/Foo.java\n?? Notes.txt' }],
      ['rev-parse --abbrev-ref HEAD', { stdout: 'main' }],
      ['rev-parse HEAD', { stdout: 'sha-before' }],
    ]);
    const { service } = stubService();
    const manager = new CodeSyncManager(service, mirror.root, git.run, dataDir);
    const result = await manager.syncAndRebuild();
    assert.equal(result.totalRepos, 1);
    assert.equal(result.skippedRepos, 1);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.details[0].pullResult, 'skipped');
    assert.equal(result.details[0].dirty, true);
    assert.deepEqual(result.details[0].dirtyFiles, ['src/Foo.java', 'Notes.txt']);
    assert.equal(result.updatedRepos, 0);
    assert.deepEqual(forbiddenCommands(git.calls), []);
    assert.ok(git.calls.some(c => c.command.includes('fetch --all --prune')), 'fetch 保留');
    assert.ok(git.calls.some(c => c.command.includes('status --porcelain')), '先判断工作区');
    assert.equal(git.calls.some(c => c.command.includes('pull')), false, '脏工作区不 pull');
    const health = JSON.parse(fs.readFileSync(path.join(dataDir, 'mirror-health.json'), 'utf8'));
    assert.equal(health.healthy, false);
    assert.equal(health.repos.length, 1);
    assert.equal(posix(health.repos[0].relativePath), 'skt-back/skt_cxy');
    assert.equal(health.repos[0].branch, 'main');
    assert.equal(health.repos[0].dirty, true);
    assert.equal(health.repos[0].pullResult, 'skipped');
    assert.deepEqual(health.skippedRepos.map(posix), ['skt-back/skt_cxy']);
    assert.deepEqual(health.staleRepos, []);
    assert.equal(manager.getStatus().lastMirrorHealth?.repos[0].dirty, true);
  } finally { mirror.cleanup(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('工作区干净且 pull --ff-only 成功时正常更新并重建图谱', async () => {
  const mirror = makeMirror(['skt-back/skt_cxy']);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-graph-'));
  try {
    const git = fakeGit([
      ['fetch --all --prune', { stdout: '' }],
      ['status --porcelain', { stdout: '' }],
      ['rev-parse --abbrev-ref HEAD', { stdout: 'main' }],
      ['rev-parse HEAD', { stdout: ['sha-before', 'sha-after'] }],
      ['pull --ff-only', { stdout: 'Updating 1234567..89abcde' }],
    ]);
    const { state, service } = stubService();
    const manager = new CodeSyncManager(service, mirror.root, git.run, dataDir);
    const result = await manager.syncAndRebuild();
    assert.equal(result.details[0].pullResult, 'ok');
    assert.equal(result.details[0].updated, true);
    assert.equal(result.updatedRepos, 1);
    assert.equal(result.skippedRepos, 0);
    assert.equal(result.indexRebuilt, true);
    assert.equal(state.rebuildCalls, 1);
    assert.deepEqual(forbiddenCommands(git.calls), []);
    assert.ok(git.calls.some(c => c.command.includes('pull --ff-only')), '干净工作区才 pull');
    const health = JSON.parse(fs.readFileSync(path.join(dataDir, 'mirror-health.json'), 'utf8'));
    assert.equal(health.healthy, true);
    assert.equal(health.repos[0].headSha, 'sha-after');
    assert.deepEqual(health.skippedRepos, []);
    assert.deepEqual(health.staleRepos, []);
    const trust = JSON.parse(fs.readFileSync(path.join(dataDir, 'version-trust.json'), 'utf8'));
    assert.equal(trust.repos.length, 1);
    assert.equal(trust.repos[0].relativePath, 'skt-back/skt_cxy');
    assert.equal(trust.repos[0].headSha, 'sha-after');
  } finally { mirror.cleanup(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('pull --ff-only 失败时如实返回失败，仍然没有 reset', async () => {
  const mirror = makeMirror(['skt-back/prod-config']);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-graph-'));
  try {
    const git = fakeGit([
      ['fetch --all --prune', { stdout: '' }],
      ['status --porcelain', { stdout: '' }],
      ['rev-parse --abbrev-ref HEAD', { stdout: 'main' }],
      ['rev-parse HEAD', { stdout: 'sha-before' }],
      ['pull --ff-only', { error: 'fatal: Not possible to fast-forward, aborting.' }],
    ]);
    const { service } = stubService();
    const manager = new CodeSyncManager(service, mirror.root, git.run, dataDir);
    const result = await manager.syncAndRebuild();
    assert.equal(result.failedRepos, 1);
    assert.equal(result.details[0].pullResult, 'failed');
    assert.match(result.details[0].error || '', /fast-forward/);
    assert.equal(result.updatedRepos, 0);
    assert.deepEqual(forbiddenCommands(git.calls), []);
    const health = JSON.parse(fs.readFileSync(path.join(dataDir, 'mirror-health.json'), 'utf8'));
    assert.equal(health.healthy, false);
    assert.deepEqual(health.staleRepos.map(posix), ['skt-back/prod-config']);
    assert.equal(health.repos[0].error, 'fatal: Not possible to fast-forward, aborting.');
  } finally { mirror.cleanup(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('fetch 失败时该仓库记为 failed，不再尝试 pull', async () => {
  const mirror = makeMirror(['skt-remote']);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-graph-'));
  try {
    const git = fakeGit([
      ['fetch --all --prune', { error: 'Could not resolve host' }],
      ['status --porcelain', { stdout: '' }],
      ['rev-parse --abbrev-ref HEAD', { stdout: 'main' }],
      ['rev-parse HEAD', { stdout: 'sha-before' }],
    ]);
    const { service } = stubService();
    const manager = new CodeSyncManager(service, mirror.root, git.run, dataDir);
    const result = await manager.syncAndRebuild();
    assert.equal(result.failedRepos, 1);
    assert.equal(result.details[0].pullResult, 'failed');
    assert.equal(git.calls.some(c => c.command.includes('pull')), false);
    assert.deepEqual(forbiddenCommands(git.calls), []);
  } finally { mirror.cleanup(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
