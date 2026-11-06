import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { executeGitInspect } from '../../server/src/tools/code_search.ts';
import { applyDataOnlyMode, DATA_ONLY_CONCLUSION, isDataFactText } from '../../server/src/agent/publication.ts';
import { beginRunPin, checkRepoDrift, formatDriftLine, hasUnknownInvolvedRepo, involvedRepos, writeTrustReport } from '../../server/src/codegraph/version_trust.ts';
import { BusinessRegistry } from '../../server/src/agent/service.ts';

/** 构造带多次提交与标签的临时 git 仓库（skt-back/svc 布局，与 fixture 一致） */
function makeGitRepo(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-pin-'));
  const repo = path.join(root, 'skt-back', 'svc');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'src', 'A.java'), 'class A { void v1() {} }\n');
  git('add', '-A'); git('commit', '-q', '-m', 'v1'); git('tag', 'P1.0.1');
  fs.writeFileSync(path.join(repo, 'src', 'A.java'), 'class A { void v2() {} }\n');
  git('add', '-A'); git('commit', '-q', '-m', 'v2'); git('tag', 'P1.0.2');
  fs.writeFileSync(path.join(repo, 'src', 'A.java'), 'class A { void v3() {} }\n');
  git('add', '-A'); git('commit', '-q', '-m', 'v3');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const cfg = (root: string) => ({ codeRepoPath: root }) as any;

test('V4：runPin 在运行起点固定 HEAD，运行期间漂移被检出并给出提示行', () => {
  const fx = makeGitRepo();
  try {
    const pin = beginRunPin(fx.root);
    assert.equal(pin.heads.get('skt-back/svc'), execFileSync('git', ['-C', path.join(fx.root, 'skt-back', 'svc'), 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim());
    assert.equal(checkRepoDrift(pin, 'skt-back/svc', fx.root).drifted, false, '起点即当前，无漂移');
    // 运行期间产生新提交
    fs.writeFileSync(path.join(fx.root, 'skt-back', 'svc', 'src', 'A.java'), 'class A { void v4() {} }\n');
    execFileSync('git', ['-C', path.join(fx.root, 'skt-back', 'svc'), 'add', '-A'], { windowsHide: true });
    execFileSync('git', ['-C', path.join(fx.root, 'skt-back', 'svc'), 'commit', '-q', '-m', 'v4'], { windowsHide: true });
    const drift = checkRepoDrift(pin, 'skt-back/svc', fx.root);
    assert.equal(drift.drifted, true);
    assert.match(formatDriftLine('skt-back/svc', drift.from!, drift.to!), /【版本漂移】本次运行期间 skt-back\/svc 已从 [0-9a-f]{8} 变为 [0-9a-f]{8}/);
    // 未固定的仓库（pin 里没有）不报漂移
    assert.equal(checkRepoDrift(pin, 'skt-back/other', fx.root).drifted, false);
  } finally { fx.cleanup(); }
});

test('V4：git_inspect show 支持标签/提交号/before:日期，路径仍过策略与边界校验', async () => {
  const fx = makeGitRepo();
  try {
    const atTag = await executeGitInspect({ action: 'show', filePath: 'skt-back/svc/src/A.java', ref: 'P1.0.1' }, cfg(fx.root));
    assert.match(atTag, /void v1\(\)/);
    assert.doesNotMatch(atTag, /void v3/);
    const atCommit = await executeGitInspect({ action: 'show', filePath: 'skt-back/svc/src/A.java', ref: 'HEAD' }, cfg(fx.root));
    assert.match(atCommit, /void v3\(\)/);
    const before = await executeGitInspect({ action: 'show', filePath: 'skt-back/svc/src/A.java', ref: 'before:2026-01-01' }, cfg(fx.root));
    assert.match(before, /没有 2026-01-01 之前的提交|未找到/);
    const badRef = await executeGitInspect({ action: 'show', filePath: 'skt-back/svc/src/A.java', ref: 'nope123' }, cfg(fx.root));
    assert.match(badRef, /Git 查询失败|没有/);
    const noRef = await executeGitInspect({ action: 'show', filePath: 'skt-back/svc/src/A.java' }, cfg(fx.root));
    assert.match(noRef, /必须提供 ref/);
    const badAction = await executeGitInspect({ action: 'rewrite', filePath: 'x' }, cfg(fx.root));
    assert.match(badAction, /不支持的 action/);
    // 路径校验：越界与排除路径照旧拦截
    assert.match(await executeGitInspect({ action: 'show', filePath: '../../etc/passwd', ref: 'HEAD' }, cfg(fx.root)), /安全拦截/);
    fs.mkdirSync(path.join(fx.root, 'skt-back', 'prod-config'), { recursive: true });
    fs.writeFileSync(path.join(fx.root, 'skt-back', 'prod-config', 'application.yml'), 'x: 1\n');
    assert.match(await executeGitInspect({ action: 'show', filePath: 'skt-back/prod-config/application.yml', ref: 'HEAD' }, cfg(fx.root)), /已排除/);
  } finally { fx.cleanup(); }
});

test('V4：数据核对模式——unknown 涉及时结论统一替换、机制类条目过滤、数据事实保留', () => {
  const draft = {
    conclusion: '退款失败是因为风控分支拦截了请求，该规则对所有场景一律生效。',
    businessData: [
      { label: '订单状态', value: '已取消' },
      { label: '失败原因', value: '风控分支拦截' },
      { label: '金额', value: '81.43 元' },
    ],
    evidenceSummary: ['数据库记录显示两笔收款', '代码机制决定了必然拦截'],
    customerReply: '因为系统规则，您的退款一定会失败。',
    pendingItems: ['核实风控配置'],
  };
  const filtered = applyDataOnlyMode(draft, true);
  assert.equal(filtered.conclusion, DATA_ONLY_CONCLUSION);
  assert.deepEqual(filtered.businessData.map(i => i.value), ['已取消', '81.43 元'], '只保留数据事实');
  assert.deepEqual(filtered.evidenceSummary, ['数据库记录显示两笔收款']);
  assert.equal(filtered.customerReply, '', '话术含机制表述被清空');
  assert.deepEqual(filtered.pendingItems, ['核实风控配置'], '待确认事项不过滤');
  // 非 unknown 场景原样返回（不改变现有行为）
  assert.equal(applyDataOnlyMode(draft, false), draft);
  // 判定函数本身
  assert.equal(isDataFactText('订单状态：已取消'), true);
  assert.equal(isDataFactText('因为分支逻辑导致'), false);
});

test('V4：involvedRepos / hasUnknownInvolvedRepo 识别正反斜杠源码路径，BusinessRegistry 在运行期漂移时注入提示行', async () => {
  assert.deepEqual(
    involvedRepos([
      '【文件】skt-back/payment-service/src/PayService.java（共 50 行）',
      '命中: skt-back\\skt_cxy\\src\\OrderServiceImpl.java:120',
      '【Git LOG】仓库: skt-remote/skt-remote-sdk | 文件: pom.xml',
    ]),
    ['skt-back/payment-service', 'skt-back/skt_cxy', 'skt-remote/skt-remote-sdk'],
  );

  const fx = makeGitRepo();
  const prevTrustPath = process.env.VERSION_TRUST_PATH;
  const trustFile = path.join(fx.root, 'version-trust.json');
  process.env.VERSION_TRUST_PATH = trustFile;
  try {
    writeTrustReport({
      createdAt: new Date().toISOString(),
      mirrorRoot: fx.root,
      manifestLoaded: false,
      summary: { approved: 0, presumed: 0, unknown: 1 },
      repos: [{
        relativePath: 'skt-back/svc',
        headSha: execFileSync('git', ['-C', path.join(fx.root, 'skt-back', 'svc'), 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
        dirty: false,
        nearestTag: '',
        headEqualsTag: false,
        verdict: { level: 'unknown', reason: '仓库没有任何标签' },
      }],
    }, trustFile);
    assert.equal(hasUnknownInvolvedRepo(['【文件】skt-back/svc/src/A.java（共 1 行）']), true);

    const pin = beginRunPin(fx.root);
    const registry = new BusinessRegistry({ codeRepoPath: fx.root, repoAllowlist: ['*'] } as any, 'alice', { log() {} } as any, pin);
    const beforeDrift = String(await registry.executeTool('read_file_lines', { filePath: 'skt-back/svc/src/A.java' }));
    assert.doesNotMatch(beforeDrift, /【版本漂移】/);

    // 运行期间仓库 HEAD 变化
    fs.writeFileSync(path.join(fx.root, 'skt-back', 'svc', 'src', 'A.java'), 'class A { void v4() {} }\n');
    execFileSync('git', ['-C', path.join(fx.root, 'skt-back', 'svc'), 'add', '-A'], { windowsHide: true });
    execFileSync('git', ['-C', path.join(fx.root, 'skt-back', 'svc'), 'commit', '-q', '-m', 'v4'], { windowsHide: true });

    const afterDrift = String(await registry.executeTool('read_file_lines', { filePath: 'skt-back/svc/src/A.java' }));
    assert.match(afterDrift, /^【版本漂移】本次运行期间 skt-back\/svc 已从 [0-9a-f]{8} 变为 [0-9a-f]{8}/);
  } finally {
    if (prevTrustPath === undefined) delete process.env.VERSION_TRUST_PATH;
    else process.env.VERSION_TRUST_PATH = prevTrustPath;
    fx.cleanup();
  }
});
