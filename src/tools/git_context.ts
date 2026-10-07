import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { HarnessContext, ToolDefinition } from '../types/index.js';
import { validatePathInRepo } from './sandbox.js';

const execAsync = promisify(exec);

export const gitContextTool: ToolDefinition = {
  name: 'git_inspect',
  description: '查询代码的 Git 提交历史（Log）或代码行变更作者与原因（Blame），用于排查业务规则是何时以及为何变更的（受工作区安全沙箱管控）',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['log', 'blame'],
        description: '操作类型：log（查看近期提交记录）或 blame（查看指定行修改原因）',
      },
      filePath: {
        type: 'string',
        description: '相关代码文件的相对路径',
      },
      lineRange: {
        type: 'string',
        description: 'blame 操作时的行号范围，例如 "50,70"（可选）',
      },
    },
    required: ['action', 'filePath'],
  },
  execute: async (args: Record<string, unknown>, context: HarnessContext) => {
    const action = String(args.action || 'log');
    const rawPath = String(args.filePath || '');
    const repoPath = context.repoPath;

    if (!rawPath.trim()) {
      return '错误: filePath 参数不能为空。';
    }

    // Enforce sandbox boundary validation
    const { relativePath } = validatePathInRepo(rawPath, repoPath);

    // Validate lineRange format to prevent option injection
    let lineRange = '';
    if (args.lineRange) {
      const lr = String(args.lineRange).trim();
      if (!/^\d+,\d+$/.test(lr) && !/^\d+$/.test(lr)) {
        return '错误: lineRange 格式必须为数字范围，如 "50,70"。';
      }
      lineRange = `-L ${lr}`;
    }

    try {
      let cmd = '';
      if (action === 'blame') {
        cmd = `git -C "${repoPath}" blame ${lineRange} -- "${relativePath}"`;
      } else {
        cmd = `git -C "${repoPath}" log -n 5 --pretty=format:"%h - %an (%ad): %s" --date=short -- "${relativePath}"`;
      }

      const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 5 });
      if (!stdout.trim()) {
        return `未获取到 [${relativePath}] 的 Git ${action} 记录。`;
      }
      return `【Git ${action.toUpperCase()} 记录】\n` + stdout;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return `Git 查询失败: ${errorMsg}`;
    }
  },
};
