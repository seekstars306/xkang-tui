import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  executeSearchCode,
  executeReadFileLines,
  executeGitInspect,
  resolveScopeRoots,
  parseKeyword,
  splitFilePatterns,
  resolveRepoFile,
  findGitRoot,
} from '../../server/src/tools/code_search.ts';
import { createFixtureRepo, FixtureRepo } from '../helpers/fixture.ts';

let fx: FixtureRepo;
let cfg: any;

before(() => {
  fx = createFixtureRepo();
  cfg = { codeRepoPath: fx.root };
});
after(() => fx.cleanup());

describe('resolveScopeRoots', () => {
  test('frontend 只取 skt-front，backend 取其余一级目录', () => {
    const front = resolveScopeRoots(fx.root, 'frontend');
    const back = resolveScopeRoots(fx.root, 'backend');
    assert.deepEqual(front.roots.map((r) => path.basename(r)), ['skt-front']);
    assert.deepEqual(back.roots.map((r) => path.basename(r)), ['skt-back', 'skt-back-new', 'skt-remote']);
    assert.deepEqual(resolveScopeRoots(fx.root, 'all').roots, [fx.root]);
  });

  test('CODE_FRONTEND_DIRS 可覆盖默认的前端目录识别', () => {
    process.env.CODE_FRONTEND_DIRS = 'skt-remote';
    try {
      assert.deepEqual(resolveScopeRoots(fx.root, 'frontend').roots.map((r) => path.basename(r)), ['skt-remote']);
    } finally {
      delete process.env.CODE_FRONTEND_DIRS;
    }
  });
});

describe('parseKeyword / splitFilePatterns', () => {
  test('OR 转为正则交替', () => {
    assert.deepEqual(parseKeyword('退票费 OR refundFee OR refund_fee'), { pattern: '退票费|refundFee|refund_fee', andTerms: [] });
  });
  test('AND 保留为"同一文件同时包含"语义', () => {
    const p = parseKeyword('refundFee AND checkOrder');
    assert.deepEqual(p.andTerms, ['refundFee', 'checkOrder']);
  });
  test('英文逗号分隔的标识符列表拆分，中文全角逗号的报错文案不拆分', () => {
    assert.equal(parseKeyword('refundFee, refund_fee').pattern, 'refundFee|refund_fee');
    assert.equal(parseKeyword('您好，该订单无法退票').pattern, '您好，该订单无法退票');
  });
  test('非法正则自动转为字面量', () => {
    assert.equal(parseKeyword('checkPrice(').pattern, 'checkPrice\\(');
  });
  test('filePattern 支持 OR / 逗号 / 竖线，以及按文件名包含', () => {
    assert.deepEqual(splitFilePatterns('*.vue OR *.js'), ['*.vue', '*.js']);
    assert.deepEqual(splitFilePatterns('*.vue,*.java|.xml'), ['*.vue', '*.java', '*.xml']);
    assert.deepEqual(splitFilePatterns('OrderService'), ['*OrderService*']);
    assert.deepEqual(splitFilePatterns(undefined), []);
  });
});

describe('executeSearchCode', () => {
  test('scope=frontend 能检索到前端文件（历史 bug：恒为 0）且排除 node_modules', async () => {
    const out = await executeSearchCode({ keyword: '账户类型', scope: 'frontend' }, cfg);
    assert.match(out, /命中 2 个文件/);
    assert.match(out, /skt-front\/app_pc\/src\/views\/UserEditDialog\.vue/);
    assert.match(out, /skt-front\/app_pc\/src\/config\/constants\.js/);
    assert.doesNotMatch(out, /node_modules/);
    assert.doesNotMatch(out, /skt-remote/);
  });

  test('scope=backend 不会混入前端文件（历史 bug：backend 返回 skt-front 文件）', async () => {
    const out = await executeSearchCode({ keyword: '账户类型', scope: 'backend' }, cfg);
    assert.match(out, /skt-remote\/sdk\/Client\.java/);
    assert.doesNotMatch(out, /skt-front/);
  });

  test('filePattern 支持 "*.vue OR *.js"', async () => {
    const out = await executeSearchCode({ keyword: '账户类型', scope: 'all', filePattern: '*.vue OR *.js', output_mode: 'files_with_matches' }, cfg);
    assert.match(out, /UserEditDialog\.vue/);
    assert.match(out, /constants\.js/);
    assert.doesNotMatch(out, /Client\.java/);
  });

  test('AND 只返回同时包含两个词的文件', async () => {
    const out = await executeSearchCode({ keyword: 'refundFee AND checkOrder', output_mode: 'files_with_matches' }, cfg);
    assert.match(out, /PayService\.java/);
    assert.doesNotMatch(out, /OnlyRefund\.java/);
  });

  test('命中文件很多时明确告知还有多少未展示，并支持 offset 翻页', async () => {
    const first = await executeSearchCode({ keyword: 'commonToken' }, cfg);
    assert.match(first, /命中 40 个文件/);
    assert.match(first, /下面展示第 1-20 个文件的匹配内容；其余 20 个文件只列出路径和匹配数/);
    assert.match(first, /继续查看后续文件内容请用 offset=20/);
    assert.match(first, /Gen40\.java/, '未展示内容的文件也要列出路径');
    const second = await executeSearchCode({ keyword: 'commonToken', offset: 20 }, cfg);
    assert.match(second, /下面展示第 21-40 个文件的匹配内容（已展示全部命中文件）/);
    assert.match(second, /### skt-back\/svc\/src\/main\/java\/com\/x\/gen\/Gen21\.java/);
  });

  test('结果按路径排序，多次检索输出一致', async () => {
    const a = await executeSearchCode({ keyword: 'commonToken', output_mode: 'files_with_matches' }, cfg);
    const b = await executeSearchCode({ keyword: 'commonToken', output_mode: 'files_with_matches' }, cfg);
    assert.equal(a, b);
    const files = a.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
    assert.deepEqual(files, [...files].sort((x, y) => x.localeCompare(y)));
  });

  test('count 模式按仓库统计', async () => {
    const out = await executeSearchCode({ keyword: 'commonToken', output_mode: 'count' }, cfg);
    assert.match(out, /skt-back\/svc: 40 个文件/);
  });

  test('没有命中时说明"不能据此断定不存在"', async () => {
    const out = await executeSearchCode({ keyword: '完全不存在的文案xyz', scope: 'frontend' }, cfg);
    assert.match(out, /未检索到匹配的代码/);
    assert.match(out, /不能据此断定/);
  });

  test('参数错误时给出明确报错', async () => {
    assert.match(await executeSearchCode({ keyword: '  ' }, cfg), /不能为空/);
    assert.match(await executeSearchCode({ keyword: 'x' }, { codeRepoPath: '' } as any), /未配置 CODE_REPO_PATH/);
  });
});

describe('resolveRepoFile / executeReadFileLines', () => {
  test('唯一文件名自动定位并注明', () => {
    const r = resolveRepoFile(fx.root, 'OrderService.java');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.rel, 'skt-back/svc/src/main/java/com/x/OrderService.java');
      assert.match(r.note || '', /自动定位/);
    }
  });

  test('同名文件不唯一时返回候选列表，不再静默挑一个', () => {
    const r = resolveRepoFile(fx.root, 'OrderCommonUtils.java');
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.message, /不唯一/);
      assert.match(r.message, /skt-back\/svc\/src\/main\/java\/com\/x\/util\/OrderCommonUtils\.java/);
      assert.match(r.message, /skt-back\/other\/src\/main\/java\/com\/y\/util\/OrderCommonUtils\.java/);
    }
  });

  test('带部分路径时可唯一确定同名文件', () => {
    const r = resolveRepoFile(fx.root, 'com/y/util/OrderCommonUtils.java');
    assert.equal(r.ok, true);
  });

  test('越界路径与 .git 内部文件被拦截（无论目标是否存在，都先做边界检查）', () => {
    const outside = resolveRepoFile(fx.root, path.join(fx.root, '..', 'escape.txt'));
    assert.equal(outside.ok, false);
    if (!outside.ok) assert.match(outside.message, /安全拦截/);
    const traversal = resolveRepoFile(fx.root, '../../etc/passwd');
    assert.equal(traversal.ok, false);
    if (!traversal.ok) assert.match(traversal.message, /安全拦截/);
    const gitInternal = resolveRepoFile(fx.root, 'skt-back/svc/.git/config');
    assert.equal(gitInternal.ok, false);
    if (!gitInternal.ok) assert.match(gitInternal.message, /安全拦截.*\.git/);
  });

  test('请求 120-160 行时自动扩展窗口，读到第 169 行的覆盖赋值（历史误判场景）', async () => {
    const out = await executeReadFileLines({ filePath: 'skt-back/svc/src/main/java/com/x/OrderService.java', startLine: 120, endLine: 160 }, cfg);
    assert.match(out, /已自动扩大阅读窗口/);
    assert.match(out, /\n129: .*orderAirCopy/);
    assert.match(out, /\n169: .*setReceivableState\(0\)/);
  });

  test('未指定行号时读取整个短文件（不超过 300 行）', async () => {
    const out = await executeReadFileLines({ filePath: 'skt-back/svc/src/main/java/com/x/OrderService.java' }, cfg);
    assert.match(out, /共 202 行/);
    assert.match(out, /显示第 1-202 行/);
  });

  test('读取超出窗口时提示下一次的 startLine', async () => {
    const out = await executeReadFileLines({ filePath: 'skt-back/svc/src/main/java/com/x/OrderService.java', startLine: 1, endLine: 50 }, cfg);
    assert.match(out, /显示第 1-120 行/);
    assert.match(out, /继续阅读请用 startLine=121/);
  });

  test('GBK 编码文件自动转码', async () => {
    const out = await executeReadFileLines({ filePath: 'skt-back/svc/legacy/Legacy.java' }, cfg);
    assert.match(out, /收款状态/);
  });

  test('目录路径返回目录清单而不是报错', async () => {
    const out = await executeReadFileLines({ filePath: 'skt-back/svc/src/main/java/com/x' }, cfg);
    assert.match(out, /【目录】/);
    assert.match(out, /OrderService\.java/);
  });

  test('起始行超出文件长度时明确说明', async () => {
    const out = await executeReadFileLines({ filePath: 'skt-front/app_pc/src/config/constants.js', startLine: 999 }, cfg);
    assert.match(out, /超出文件长度/);
  });
});

describe('git_inspect（嵌套子仓库）', () => {
  test('找到文件所属的子仓库（代码库根目录本身不是仓库）', () => {
    const file = path.join(fx.root, 'skt-back/svc/src/main/java/com/x/OrderService.java');
    assert.equal(findGitRoot(fx.root, file), path.join(fx.root, 'skt-back', 'svc'));
    assert.equal(findGitRoot(fx.root, path.join(fx.root, 'skt-remote/sdk/Client.java')), null);
  });

  test('log 与 blame 能在子仓库中执行（历史 bug：恒报 not a git repository）', async () => {
    const log = await executeGitInspect({ action: 'log', filePath: 'OrderService.java' }, cfg);
    assert.match(log, /仓库: skt-back\/svc/);
    assert.match(log, /Fixture Author: init order service/);
    const blame = await executeGitInspect({ action: 'blame', filePath: 'OrderService.java', lineRange: '169,169' }, cfg);
    assert.match(blame, /Fixture Author/);
    assert.match(blame, /setReceivableState\(0\)/);
  });

  test('lineRange 格式校验与非仓库文件提示', async () => {
    assert.match(await executeGitInspect({ action: 'blame', filePath: 'OrderService.java', lineRange: '1;rm' }, cfg), /格式必须为行号范围/);
    assert.match(await executeGitInspect({ action: 'log', filePath: 'skt-remote/sdk/Client.java' }, cfg), /未找到文件 .* 所属的 Git 仓库/);
  });
});
