import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { executeSearchCode, executeReadFileLines, executeGitInspect } from '../../server/src/tools/code_search.ts';
import { executeCodeGraph } from '../../server/src/tools/codegraph.ts';
import { CodeGraphService } from '../../server/src/codegraph/service.ts';
import { createFixtureRepo, type FixtureRepo } from '../helpers/fixture.ts';

let fx: FixtureRepo;
let cfg: any;
let trustFile: string;
const savedTrustPath = process.env.VERSION_TRUST_PATH;

/** 写一份判定产物（仓库键与 fixture 的 skt-back/svc 对应） */
function writeTrustReport(over: { level?: 'approved' | 'presumed' | 'unknown'; tag?: string; dirty?: boolean } = {}): void {
  const level = over.level ?? 'presumed';
  fs.writeFileSync(trustFile, JSON.stringify({
    createdAt: '2026-10-15T02:30:00.000Z',
    mirrorRoot: fx.root,
    manifestLoaded: false,
    summary: { approved: level === 'approved' ? 1 : 0, presumed: level === 'presumed' ? 1 : 0, unknown: level === 'unknown' ? 1 : 0 },
    repos: [{ relativePath: 'skt-back/svc', headSha: 'b87627d85', dirty: over.dirty ?? false, nearestTag: over.tag ?? 'P1.2.1', headEqualsTag: true, verdict: { level, reason: '测试用' } }],
  }, null, 2));
}

before(() => {
  fx = createFixtureRepo();
  cfg = { codeRepoPath: fx.root, repoAllowlist: ['*'], codeGraphEndpoint: '' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-trust-'));
  trustFile = path.join(dir, 'version-trust.json');
  process.env.VERSION_TRUST_PATH = trustFile;
});
after(() => {
  fx.cleanup();
  if (savedTrustPath === undefined) delete process.env.VERSION_TRUST_PATH; else process.env.VERSION_TRUST_PATH = savedTrustPath;
  fs.rmSync(path.dirname(trustFile), { recursive: true, force: true });
});

test('V3：search_code 结果头带版本行，文件行带短版本标识；无判定产物时静默不加', async () => {
  writeTrustReport();
  const withStamp = await executeSearchCode({ keyword: 'commonToken', output_mode: 'files_with_matches' }, cfg);
  assert.match(withStamp, /【版本】skt-back\/svc @ P1\.2\.1 \(b87627d, 工作区干净\) \| 档位: 推定 \| 判定时刻: 2026-10-15T02:30/);
  assert.match(withStamp, /- skt-back\/svc\/src\/main\/java\/com\/x\/gen\/Gen01\.java@P1\.2\.1 \(1 处\)/);
  const content = await executeSearchCode({ keyword: 'refundFee AND checkOrder', output_mode: 'content' }, cfg);
  assert.match(content, /【版本】skt-back\/svc @ P1\.2\.1/);
  assert.match(content, /### skt-back\/svc\/src\/main\/java\/com\/x\/PayService\.java@P1\.2\.1（\d+ 处匹配）/);
  const unknown = await executeSearchCode({ keyword: 'commonToken', output_mode: 'files_with_matches' }, cfg);
  assert.match(unknown, /档位: 推定/);

  fs.rmSync(trustFile);
  const without = await executeSearchCode({ keyword: 'commonToken', output_mode: 'files_with_matches' }, cfg);
  assert.doesNotMatch(without, /【版本】/);
  assert.doesNotMatch(without, /@P1\.2\.1/);
});

test('V3：read_file_lines 与 git_inspect 结果头带版本行', async () => {
  writeTrustReport();
  const read = await executeReadFileLines({ filePath: 'skt-back/svc/src/main/java/com/x/OrderService.java' }, cfg);
  assert.match(read, /【版本】skt-back\/svc @ P1\.2\.1 \(b87627d, 工作区干净\) \| 档位: 推定/);
  assert.match(read, /【文件】skt-back\/svc\/src\/main\/java\/com\/x\/OrderService\.java/);
  const git = await executeGitInspect({ action: 'log', filePath: 'OrderService.java' }, cfg);
  assert.match(git, /【版本】skt-back\/svc @ P1\.2\.1/);
  assert.match(git, /Fixture Author/);
  // 脏工作区与未知档位如实呈现
  writeTrustReport({ level: 'unknown', dirty: true, tag: '' });
  const dirty = await executeReadFileLines({ filePath: 'skt-back/svc/src/main/java/com/x/OrderService.java' }, cfg);
  assert.match(dirty, /工作区有未提交改动/);
  assert.match(dirty, /档位: 未知/);
});

test('V3：rebuildIndex 同刻落盘 snapshot-manifest.json（createdAt 与 stats.json 一致）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-snap-'));
  try {
    const service = new CodeGraphService(fx.root, dataDir);
    const index = await service.rebuildIndex();
    const stats = JSON.parse(fs.readFileSync(path.join(dataDir, 'stats.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'snapshot-manifest.json'), 'utf8'));
    assert.equal(manifest.createdAt, stats.createdAt, 'createdAt 必须完全一致');
    assert.equal(manifest.createdAt, index.createdAt);
    assert.equal(manifest.logicalRoot, service['targetProjectRoot'] || path.resolve(fx.root));
    assert.ok(manifest.sourceManifestHash.length === 64);
    assert.ok(Array.isArray(manifest.repositories) && manifest.repositories.length >= 1, '枚举到 fixture 的 git 仓库');
    assert.ok(manifest.repositories.some((r: any) => r.repo === 'skt-back/svc' && r.commit.length === 40));
    assert.ok(manifest.excludedPaths.dirs.includes('prod-config'));
    assert.ok(manifest.excludedPaths.fileGlobs.includes('!**/*.bak'));
    assert.deepEqual(manifest.graphFiles, ['stats.json', 'definitions.json', 'implementations.json', 'callers.json', 'callees.json', 'references.json']);
    assert.equal(manifest.stats.totalFiles, index.stats.totalFiles);
    // 服务实例可直接读回
    assert.equal(service.getSnapshotManifest()!.createdAt, manifest.createdAt);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('V3：codegraph 结果头带图谱快照行（构建时刻/起点/清单哈希/一致性）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-snap-'));
  try {
    const service = new CodeGraphService(fx.root, dataDir);
    await service.rebuildIndex();
    const out = await executeCodeGraph({ symbol: 'OrderService', queryType: 'definitions' }, cfg, fetch, service);
    assert.match(out, /【图谱快照】构建于 \d{4}-\d{2}-\d{2}T/);
    assert.match(out, /起点 /);
    assert.match(out, /清单哈希 [0-9a-f]{16}/);
    assert.match(out, /与镜像当前状态一致: (是|否（\d+ 个仓库在构建后已变化\)|无法判断)/);
    assert.match(out, /OrderService/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('V3：远程图谱结果明确标注非本地快照', async () => {
  const cfgRemote: any = { repoAllowlist: ['*'], codeGraphEndpoint: 'http://127.0.0.1:1/codegraph' };
  const out = await executeCodeGraph({ symbol: 'Foo', queryType: 'definitions' }, cfgRemote, (async () => ({ ok: true, json: async () => ({ results: [{ name: 'Foo', kind: 'def', domain: 'backend', repo: 'r', filePath: 'a/b.java', line: 1 }], totalMatches: 1 }) })) as any, { query: () => ({ status: 'not_found', symbol: 'Foo', queryType: 'definitions', totalMatches: 0, results: [], message: 'x' }) } as any);
  assert.match(out, /结果来自远程图谱服务，非本地快照/);
  assert.doesNotMatch(out, /【图谱快照】构建于/);
});
