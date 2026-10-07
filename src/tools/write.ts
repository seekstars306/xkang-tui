import fs from 'node:fs';
import path from 'node:path';
import { HarnessContext, ToolDefinition } from '../types/index.js';
import { validatePathInRepo } from './sandbox.js';

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: '在本地工作区新建文件或完全覆盖现有文件内容（受路径沙箱约束与员工操作审批门管控）。',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '要写入的目标文件路径（绝对路径或相对于本地工作区根目录的相对路径）',
      },
      content: {
        type: 'string',
        description: '要写入的完整文本内容',
      },
    },
    required: ['file_path', 'content'],
  },
  requiresApproval: true,
  getApprovalInfo: async (args: Record<string, unknown>, context: HarnessContext) => {
    const rawPath = String(args.file_path || '');
    const content = String(args.content || '');
    const { safePath, relativePath } = validatePathInRepo(rawPath, context.localCwd);

    const exists = fs.existsSync(safePath);
    const contentLines = content.split('\n').length;

    let summary = '';
    let diffPreview = '';

    if (exists) {
      const oldContent = fs.readFileSync(safePath, 'utf-8');
      const oldLines = oldContent.split('\n').length;
      summary = `覆盖写入现有文件: ${relativePath} (原 ${oldLines} 行 ➔ 新 ${contentLines} 行)`;
      diffPreview = `--- a/${relativePath}\n+++ b/${relativePath}\n[全量文件覆盖]\n前 5 行预览:\n${content
        .split('\n')
        .slice(0, 5)
        .map((l) => '+ ' + l)
        .join('\n')}${contentLines > 5 ? '\n+ ...' : ''}`;
    } else {
      summary = `新建文件: ${relativePath} (共 ${contentLines} 行)`;
      diffPreview = `+++ b/${relativePath}\n[新建文件]\n前 5 行预览:\n${content
        .split('\n')
        .slice(0, 5)
        .map((l) => '+ ' + l)
        .join('\n')}${contentLines > 5 ? '\n+ ...' : ''}`;
    }

    return {
      filePath: relativePath,
      summary,
      diffPreview,
    };
  },
  execute: async (args: Record<string, unknown>, context: HarnessContext) => {
    const rawPath = String(args.file_path || '');
    const content = String(args.content || '');

    const { safePath, relativePath } = validatePathInRepo(rawPath, context.localCwd);

    const parentDir = path.dirname(safePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const existed = fs.existsSync(safePath);
    fs.writeFileSync(safePath, content, 'utf-8');

    const lines = content.split('\n').length;
    return `${existed ? '成功覆盖更新文件' : '成功创建新文件'}: ${relativePath} (共 ${lines} 行)`;
  },
};
