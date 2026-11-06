import fs from 'node:fs';
import { HarnessContext, ToolDefinition } from '../types/index.js';
import { validatePathInRepo } from './sandbox.js';

function countMatches(content: string, substring: string): number {
  if (!substring) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(substring, pos)) !== -1) {
    count++;
    pos += substring.length;
  }
  return count;
}

function buildDiffPreview(
  relativePath: string,
  oldStr: string,
  newStr: string,
  matchCount: number
): string {
  const oldLines = oldStr.split('\n').map((l) => `- ${l}`).join('\n');
  const newLines = newStr.split('\n').map((l) => `+ ${l}`).join('\n');

  return `--- a/${relativePath}\n+++ b/${relativePath}\n@@ 替换代码片段 (${matchCount} 处匹配) @@\n${oldLines}\n${newLines}`;
}

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: '对本地工作区文件执行精确的字符串替换修改（严格唯一性匹配防误改，受路径沙箱与操作审批门管控）。',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '要修改的目标文件路径（绝对路径或相对于工作区根目录的相对路径）',
      },
      old_string: {
        type: 'string',
        description: '要被替换的原始代码片段（必须在文件中精确、唯一匹配；请确保携带足够的上下文行）',
      },
      new_string: {
        type: 'string',
        description: '替换后的新代码片段',
      },
      replace_all: {
        type: 'boolean',
        description: '可选：如果 old_string 在文件中多次出现，是否全部替换（默认为 false）',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  requiresApproval: true,
  getApprovalInfo: async (args: Record<string, unknown>, context: HarnessContext) => {
    const rawPath = String(args.file_path || '');
    const oldString = String(args.old_string || '');
    const newString = String(args.new_string || '');
    const replaceAll = Boolean(args.replace_all);

    const { safePath, relativePath } = validatePathInRepo(rawPath, context.localCwd);

    if (!fs.existsSync(safePath)) {
      throw new Error(`文件不存在: "${relativePath}"。如需新建文件请使用 write_file 工具。`);
    }

    const fileContent = fs.readFileSync(safePath, 'utf-8');
    const matches = countMatches(fileContent, oldString);

    if (matches === 0) {
      throw new Error(
        `FS_EDIT_NOT_FOUND: 未在文件 "${relativePath}" 中匹配到指定的 old_string。请先调用 read_file_lines 确认最新文件内容与缩进格式后再试。`
      );
    }

    if (matches > 1 && !replaceAll) {
      throw new Error(
        `FS_AMBIGUOUS_EDIT: old_string 在文件 "${relativePath}" 中共匹配了 ${matches} 处。为了防止误改，请提供包含更多上下文字符的唯一 old_string，或显式设置 replace_all: true。`
      );
    }

    const summary = `精确替换文件内容: ${relativePath} (匹配 ${matches} 处代码片段)`;
    const diffPreview = buildDiffPreview(relativePath, oldString, newString, matches);

    return {
      filePath: relativePath,
      summary,
      diffPreview,
    };
  },
  execute: async (args: Record<string, unknown>, context: HarnessContext) => {
    const rawPath = String(args.file_path || '');
    const oldString = String(args.old_string || '');
    const newString = String(args.new_string || '');
    const replaceAll = Boolean(args.replace_all);

    const { safePath, relativePath } = validatePathInRepo(rawPath, context.localCwd);

    if (!fs.existsSync(safePath)) {
      throw new Error(`文件不存在: "${relativePath}"。如需新建文件请使用 write_file 工具。`);
    }

    const fileContent = fs.readFileSync(safePath, 'utf-8');
    const matches = countMatches(fileContent, oldString);

    if (matches === 0) {
      throw new Error(
        `FS_EDIT_NOT_FOUND: 未在文件 "${relativePath}" 中匹配到指定的 old_string。请先调用 read_file_lines 确认最新文件内容与缩进格式后再试。`
      );
    }

    if (matches > 1 && !replaceAll) {
      throw new Error(
        `FS_AMBIGUOUS_EDIT: old_string 在文件 "${relativePath}" 中共匹配了 ${matches} 处。为了防止误改，请提供包含更多上下文字符的唯一 old_string，或显式设置 replace_all: true。`
      );
    }

    let updatedContent = '';
    if (replaceAll) {
      updatedContent = fileContent.replaceAll(oldString, newString);
    } else {
      updatedContent = fileContent.replace(oldString, newString);
    }

    fs.writeFileSync(safePath, updatedContent, 'utf-8');
    return `成功修改文件: ${relativePath} (已成功替换 ${matches} 处匹配)`;
  },
};
