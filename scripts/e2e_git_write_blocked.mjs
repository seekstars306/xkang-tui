import { validateCommandPolicy } from '../dist/tools/powershell_policy.js';
import { runPowershellTool } from '../dist/tools/powershell.js';

console.log('========================================================================');
console.log('🛡️ 开始进行「Git 纯只读与越权写操作阻断」专项安全测试');
console.log('========================================================================\n');

const forbiddenGitCommands = [
  { name: 'Git 代码暂存 (git add)', cmd: 'git add .' },
  { name: 'Git 提交操作 (git commit)', cmd: 'git commit -m "fix bug"' },
  { name: 'Git 远程推送 (git push)', cmd: 'git push origin main' },
  { name: 'Git 强制推送 (git push -f)', cmd: 'git push -f origin master' },
  { name: 'Git 分支合并 (git merge)', cmd: 'git merge feature-dev' },
  { name: 'Git 变基操作 (git rebase)', cmd: 'git rebase main' },
  { name: 'Git 硬重置回滚 (git reset --hard)', cmd: 'git reset --hard HEAD~1' },
  { name: 'Git 创建新分支并切换 (git checkout -b)', cmd: 'git checkout -b evil-branch' },
  { name: 'Git 切换并创建分支 (git switch -c)', cmd: 'git switch -c new-feature' },
  { name: 'Git 未跟踪文件清理 (git clean -fd)', cmd: 'git clean -fd' },
  { name: 'Git 暂存丢弃 (git stash drop)', cmd: 'git stash drop' },
  { name: 'Git 强删分支 (git branch -D)', cmd: 'git branch -D main' },
  { name: 'Git 遴选提交 (git cherry-pick)', cmd: 'git cherry-pick a1b2c3d' },
  { name: 'Git 提交反转 (git revert)', cmd: 'git revert HEAD' },
  { name: 'Git 创建标签 (git tag v1.0)', cmd: 'git tag v1.0.0' },
  { name: 'Git 删除标签 (git tag -d)', cmd: 'git tag -d v1.0.0' },
];

const allowedGitCommands = [
  { name: 'Git 状态查看', cmd: 'git status' },
  { name: 'Git 提交历史查看', cmd: 'git log -n 5 --oneline' },
  { name: 'Git 变更比对', cmd: 'git diff HEAD~1' },
  { name: 'Git 提交详情查阅', cmd: 'git show HEAD' },
  { name: 'Git 分支列表查看', cmd: 'git branch --list' },
  { name: 'Git 代码行作者溯源', cmd: 'git blame README.md' },
];

let successCount = 0;
let totalCount = 0;

console.log('▶ [1/2] 验证所有 Git 修改性与提交写操作被绝对硬阻断...');
for (const item of forbiddenGitCommands) {
  totalCount++;
  const policyRes = validateCommandPolicy(item.cmd);
  if (!policyRes.allowed) {
    console.log(`   ✅ [防御成功] 拦截 ${item.name} -> "${item.cmd}": ${policyRes.reason.slice(0, 60)}...`);
    successCount++;
  } else {
    throw new Error(`【安全漏洞】未拦截 Git 修改命令: ${item.cmd}`);
  }
}

console.log('\n▶ [2/2] 验证正常的 Git 只读查询命令保持畅通...');
for (const item of allowedGitCommands) {
  totalCount++;
  const policyRes = validateCommandPolicy(item.cmd);
  if (policyRes.allowed) {
    console.log(`   ✅ [正常放行] 放行 ${item.name} -> "${item.cmd}" [分类: ${policyRes.category}]`);
    successCount++;
  } else {
    throw new Error(`【误杀报错】只读命令被误拦截: ${item.cmd}`);
  }
}

console.log('\n========================================================================');
console.log(`🎉 Git 只读与修改拦截专项测试全部通过！`);
console.log(`   测试总数: ${totalCount} 项 | 成功拦截/放行: ${successCount} 项 | 准确率: 100.00%`);
console.log('========================================================================\n');
