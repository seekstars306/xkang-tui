import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { checkReleaseReport } from './eval/release_gate.mjs';

const root = process.cwd();
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
const output = path.join(root, 'out');
const candidate = path.join(output, `xhang-${version}-candidate.exe`);
const publish = process.argv.includes('--publish');
const reportIndex = process.argv.indexOf('--report');
if (publish) {
  if (reportIndex < 0) throw new Error('正式发布必须提供 --report 验收目录');
  const gate = checkReleaseReport(path.resolve(process.argv[reportIndex + 1]), root);
  if (!gate.passed) throw new Error('未达到发布门槛：' + gate.reasons.join('；'));
  const verification = JSON.parse(fs.readFileSync(path.join(path.resolve(process.argv[reportIndex + 1]), 'verification.json'), 'utf8'));
  if (path.resolve(root, verification.candidate.path) !== candidate) throw new Error('已验收候选包与当前版本不一致');
  // Publish the exact tested bytes. Rebuilding here would create an untested binary.
  const bytes = fs.readFileSync(candidate);
  const release = path.join(root, 'server', 'data', 'releases'); fs.mkdirSync(release, { recursive: true });
  fs.copyFileSync(candidate, path.join(release, 'xhang.exe'));
  fs.writeFileSync(path.join(release, 'version.json'), JSON.stringify({ version, releaseDate: new Date().toISOString().slice(0, 10), releaseNotes: ['业务排障改为服务端执行', '客服业务数据完整展示，开发内部信息不下发', '独立证据复核与历史会话迁移'], mandatory: true, downloadUrl: '/download/latest/xhang.exe', fileSize: bytes.length }, null, 2));
  console.log(`已分发通过验收的客户端：${candidate}`);
  process.exit(0);
}
const command = (program, args) => execFileSync(process.platform === 'win32' ? 'cmd.exe' : program, process.platform === 'win32' ? ['/d', '/c', program, ...args] : args, { cwd: root, stdio: 'inherit', windowsHide: true });
command('npm', ['run', 'build']);
command('npm', ['run', '--prefix', 'server', 'build']);
fs.mkdirSync(output, { recursive: true });
const stage = fs.mkdtempSync(path.join(output, 'candidate-stage-'));
try {
  // Package an explicit client allowlist. Never feed the entire workspace to the bundler.
  fs.cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'web'));
  for (const name of ['index.html', 'app.js', 'answer.js', 'style.css', 'favicon.png', 'logo.png']) fs.copyFileSync(path.join(root, 'web', name), path.join(stage, 'web', name));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(stage, 'package.json'));
  fs.cpSync(path.join(root, 'node_modules'), path.join(stage, 'node_modules'), { recursive: true, dereference: true,
    filter: source => !/[\\/]node_modules[\\/](?:typescript|@types)(?:[\\/]|$)/.test(source) && !/[\\/]@xkang[\\/]agent-core[\\/](?:src|tsconfig.json)(?:[\\/]|$)/.test(source) });
  const inventory = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const absolute = path.join(dir, entry.name); if (entry.isSymbolicLink()) throw new Error('Client staging must not contain symbolic links'); if (entry.isDirectory()) walk(absolute); else inventory.push(path.relative(stage, absolute).replaceAll('\\', '/')); } };
  walk(stage);
  if (inventory.some(file => /^(?:server|memory|tests|scripts|src)\//.test(file) || /(?:^|\/)\.env(?:\.|$)|\.db(?:-wal|-shm)?$|\.jsonl$/.test(file))) throw new Error('Client staging contains private workspace artifacts');
  fs.writeFileSync(path.join(output, `xhang-${version}-inventory.json`), JSON.stringify(inventory, null, 2));
  // npm dedupe would recreate the file: dependency as a Windows-privileged symlink.
  command('npx', ['--yes', 'caxa', '--no-dedupe', '--input', stage, '--output', candidate, '--', '{{caxa}}/node_modules/.bin/node', '{{caxa}}/dist/cli.js']);
  const bytes = fs.readFileSync(candidate);
  fs.writeFileSync(path.join(output, `xhang-${version}-candidate.json`), JSON.stringify({ version, candidate, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), published: publish }, null, 2));
  console.log(`候选客户端已生成：${candidate}；正式分发：${publish ? '已通过验收并发布' : '未修改'}`);
} finally {
  const resolved = fs.realpathSync(stage), relative = path.relative(fs.realpathSync(output), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing cleanup outside candidate staging');
  fs.rmSync(resolved, { recursive: true, force: true });
}
