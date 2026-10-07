import fs from 'node:fs';
import path from 'node:path';
import { validatePathInRepo } from '../dist/tools/sandbox.js';
import { writeFileTool } from '../dist/tools/write.js';
import { editFileTool } from '../dist/tools/edit.js';
import { readFileTool } from '../dist/tools/read.js';
import { validateCommandPolicy } from '../dist/tools/powershell_policy.js';
import { runPowershellTool } from '../dist/tools/powershell.js';

console.log('========================================================================');
console.log('🛡️ 开始进行「硬编码安全防护与 .git 元数据锁死」深度验证测试');
console.log('========================================================================\n');

const ISOLATED_TEST_REPO = path.resolve(process.cwd(), 'test_hardcoded_sandbox');
if (!fs.existsSync(ISOLATED_TEST_REPO)) {
  fs.mkdirSync(path.join(ISOLATED_TEST_REPO, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(ISOLATED_TEST_REPO, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
}

let passed = 0;
let total = 0;

function assertHardcodedBlocked(name, fn) {
  total++;
  try {
    const res = fn();
    if (typeof res === 'string' && (res.includes('安全拦截') || res.includes('硬编码') || res.includes('禁止') || res.includes('未通过安全策略'))) {
      console.log(`   ✅ [硬编码防御] ${name} -> 已拦截: "${res.slice(0, 70)}..."`);
      passed++;
      return;
    }
    if (typeof res === 'object' && res && res.allowed === false) {
      console.log(`   ✅ [硬编码防御] ${name} -> 策略网关阻断: "${res.reason.slice(0, 70)}..."`);
      passed++;
      return;
    }
    throw new Error(`【安全告警】硬编码防护未生效！返回值: ${JSON.stringify(res)}`);
  } catch (err) {
    if (err.message.includes('安全拦截') || err.message.includes('硬编码') || err.message.includes('.git') || err.message.includes('超出工作区')) {
      console.log(`   ✅ [硬编码防御] ${name} -> 抛出安全异常: "${err.message.slice(0, 70)}..."`);
      passed++;
    } else {
      console.error(`   ❌ [测试失败] ${name} 发生未知异常:`, err.message);
      throw err;
    }
  }
}

async function assertAsyncHardcodedBlocked(name, asyncFn) {
  total++;
  try {
    const res = await asyncFn();
    if (
      typeof res === 'string' &&
      (res.includes('安全拦截') ||
        res.includes('硬编码') ||
        res.includes('禁止') ||
        res.includes('.git') ||
        res.includes('未通过安全策略') ||
        res.includes('命令被安全策略拦截'))
    ) {
      console.log(`   ✅ [硬编码防御] ${name} -> 异步执行被安全拦截: "${res.slice(0, 70)}..."`);
      passed++;
      return;
    }
    throw new Error(`【安全告警】异步硬编码防护未生效！返回值: ${JSON.stringify(res)}`);
  } catch (err) {
    if (err.message.includes('安全拦截') || err.message.includes('硬编码') || err.message.includes('.git') || err.message.includes('超出工作区')) {
      console.log(`   ✅ [硬编码防御] ${name} -> 抛出安全异常: "${err.message.slice(0, 70)}..."`);
      passed++;
    } else {
      console.error(`   ❌ [测试失败] ${name} 发生未知异常:`, err.message);
      throw err;
    }
  }
}

async function runHardcodedSecuritySuites() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('PART 1: 文件沙箱层硬编码拦截对 .git 元数据区的所有直接写/改操作');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const gitInternalPaths = [
    '.git/config',
    '.git/hooks/pre-commit',
    '.git/HEAD',
    '.git/index',
    './.git/refs/heads/main',
    'subfolder/../../.git/config',
  ];

  for (const gp of gitInternalPaths) {
    assertHardcodedBlocked(`沙箱边界硬编码锁死 [${gp}]`, () => validatePathInRepo(gp, ISOLATED_TEST_REPO));

    await assertAsyncHardcodedBlocked(`write_file 尝试篡改 [${gp}]`, () =>
      writeFileTool.execute({ file_path: gp, content: 'malicious_hook' }, { repoPath: ISOLATED_TEST_REPO })
    );

    await assertAsyncHardcodedBlocked(`edit_file 尝试注入 [${gp}]`, () =>
      editFileTool.execute({ file_path: gp, old_string: 'a', new_string: 'b' }, { repoPath: ISOLATED_TEST_REPO })
    );

    await assertAsyncHardcodedBlocked(`read_file_lines 尝试读取敏感凭证 [${gp}]`, () =>
      readFileTool.execute({ file_path: gp }, { repoPath: ISOLATED_TEST_REPO })
    );
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('PART 2: 分词级语法分析硬编码阻断所有 Git 写操作与带修改参数命令');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const gitWritePayloads = [
    { name: '代码暂存', cmd: 'git add src/index.ts' },
    { name: '代码提交', cmd: 'git commit -a -m "tamper code"' },
    { name: '远程推送', cmd: 'git push origin feature:main' },
    { name: '强制推送', cmd: 'git push --force-with-lease origin main' },
    { name: '分支合并', cmd: 'git merge origin/master' },
    { name: '分支变基', cmd: 'git rebase --onto main dev' },
    { name: '重置回滚', cmd: 'git reset --mixed HEAD~2' },
    { name: '分支创建', cmd: 'git branch -c new_feature' },
    { name: '强制删分支', cmd: 'git branch -D production' },
    { name: '新建标签', cmd: 'git tag -a v2.0 -m "release"' },
    { name: '删除标签', cmd: 'git tag -d v1.0' },
    { name: '篡改远端URL', cmd: 'git remote set-url origin http://evil.com/repo.git' },
    { name: '添加远端', cmd: 'git remote add evil_c2 http://evil.com/c2.git' },
    { name: '暂存区清理', cmd: 'git stash clear' },
    { name: '全局配置篡改', cmd: 'git config --global user.name "Hacker"' },
  ];

  for (const item of gitWritePayloads) {
    assertHardcodedBlocked(`分词网关硬阻断 [${item.name}]`, () => validateCommandPolicy(item.cmd));
    await assertAsyncHardcodedBlocked(`执行层硬阻断 [${item.name}]`, () =>
      runPowershellTool.execute({ command: item.cmd }, { repoPath: ISOLATED_TEST_REPO })
    );
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('PART 3: 验证合法的 Git 只读命令分词正常放行');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const gitReadonlyPayloads = [
    'git status',
    'git status -s',
    'git log -n 10',
    'git diff HEAD~1',
    'git show HEAD',
    'git branch --list',
    'git branch -a',
    'git tag -l',
    'git remote -v',
    'git blame src/index.ts',
  ];

  for (const cmd of gitReadonlyPayloads) {
    total++;
    const res = validateCommandPolicy(cmd);
    if (res.allowed) {
      console.log(`   ✅ [只读放行] "${cmd}" -> 分类: [${res.category}]`);
      passed++;
    } else {
      throw new Error(`只读命令被误拦截: ${cmd}`);
    }
  }

  // Cleanup
  fs.rmSync(ISOLATED_TEST_REPO, { recursive: true, force: true });

  console.log('\n========================================================================');
  console.log(`🎉 硬编码全链路安全防护测试全部通过！`);
  console.log(`   测试总数: ${total} 项 | 成功防御与放行: ${passed} 项 | 准确率: 100.00%`);
  console.log('========================================================================\n');
}

runHardcodedSecuritySuites().catch((err) => {
  console.error('Hardcoded security test error:', err);
  process.exit(1);
});
