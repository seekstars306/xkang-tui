// V2：对只读镜像状态运行三档判定，落盘 version-trust.json（git 忽略目录）。
// 采集用只读 git（--no-optional-locks，不 fetch/pull）；mirror-health.json 要等 G0 后首次同步才生成，
// 因此本次不读它、也不触发生产同步或写生产数据目录。
// 用法: node --import tsx scripts/eval/evaluate_version_trust.ts [manifest.json]
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { collectRepoStates, evaluateAll, type ManifestEntryLite } from '../../server/src/codegraph/version_trust.ts';

const env = dotenv.parse(fs.readFileSync('server/.env'));
const mirror = env.CODE_REPO_PATH || 'D:\\skt_project';
const manifestPath = process.argv.find(arg => arg.endsWith('.json')) || 'tests/eval/reports/exec-v3/deployment-manifest.json';
let manifest: ManifestEntryLite[] | undefined;
if (fs.existsSync(manifestPath)) {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest = (parsed.entries || []).map((e: any) => ({ repo: e.repo, commit: e.commit, artifactSha256: e.artifactSha256 }));
  console.log(`部署清单: ${manifestPath}（${manifest?.length ?? 0} 条）`);
} else {
  console.log(`部署清单不存在（${manifestPath}），按"无清单"判定——所有仓库最多推定`);
}

const states = collectRepoStates(mirror);
const report = evaluateAll(states, manifest, { mirrorRoot: mirror });
const out = path.resolve('tests/eval/reports/exec-v3/version-trust.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2));

for (const item of report.repos) console.log(`  ${item.relativePath.padEnd(30)} ${item.verdict.level.padEnd(9)} ${item.verdict.reason}`);
console.log(`三档汇总: 已核准 ${report.summary.approved} / 推定 ${report.summary.presumed} / 未知 ${report.summary.unknown}（共 ${report.repos.length} 个仓库）`);
console.log(`产物: ${out}`);
