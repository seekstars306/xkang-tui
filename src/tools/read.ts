import fs from 'node:fs/promises';
import { HarnessContext, ToolDefinition } from '../types/index.js';
import { validatePathInRepo } from './sandbox.js';

export const readFileTool: ToolDefinition = {
  name: 'read_file_lines',
  description: '读取指定源文件、配置文件或 XML 的代码内容，支持指定起止行号（受工作区安全沙箱管控）',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: '文件路径（支持绝对路径或相对于仓库根目录的相对路径）',
      },
      startLine: {
        type: 'number',
        description: '起始行号（从 1 开始，可选）',
      },
      endLine: {
        type: 'number',
        description: '结束行号（可选）',
      },
    },
    required: ['filePath'],
  },
  execute: async (args: Record<string, unknown>, context: HarnessContext) => {
    const rawPath = String(args.filePath || args.file_path || '');
    if (!rawPath.trim()) {
      return '错误: filePath 参数不能为空。';
    }

    // 1. Enforce sandbox boundary verification
    const { safePath, relativePath } = validatePathInRepo(rawPath, context.repoPath);

    try {
      const content = await fs.readFile(safePath, 'utf-8');
      const lines = content.split('\n');
      const start = args.startLine ? Math.max(1, Number(args.startLine)) : 1;
      const end = args.endLine ? Math.min(lines.length, Number(args.endLine)) : lines.length;

      const selected = lines.slice(start - 1, end).map((l, idx) => `${start + idx}: ${l}`);
      return selected.join('\n');
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return `读取文件失败 [${relativePath}]: ${errorMsg}`;
    }
  },
};
