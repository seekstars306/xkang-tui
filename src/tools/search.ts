import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { HarnessContext, ToolDefinition } from '../types/index.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export const searchCodeTool: ToolDefinition = {
  name: 'search_code',
  description: '在本地代码仓库中高速搜索关键字、错误码、提示文案或 API 路由（支持 scope: frontend/backend 前后端分域定向过滤，基于内置 ripgrep）',
  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: '要搜索的关键字、错误码（如 ERR_PAY_001）或文案（如 "没有修改出行地点的权限", "当前航司不支持线上改签"）',
      },
      scope: {
        type: 'string',
        enum: ['frontend', 'backend', 'all'],
        description: '可选的搜索工程范围：frontend(优先在前端工程 skt-front 中查找页面文案与接口), backend(在后端微服务 skt-back 中查找业务逻辑), all(全量搜索，默认)',
      },
      filePattern: {
        type: 'string',
        description: '可选的文件过滤通配符，例如 "*.vue", "*.java", "*.xml", "*.yml"',
      },
    },
    required: ['keyword'],
  },
  execute: async (args: Record<string, unknown>, context: HarnessContext) => {
    const keyword = String(args.keyword || '');
    const scope = (args.scope as string) || 'all';
    const filePattern = args.filePattern ? String(args.filePattern) : undefined;
    const repoPath = context.repoPath;

    if (!keyword.trim()) {
      return '错误: 搜索关键字不能为空。';
    }

    const globArgs: string[] = [
      '--glob', '!**/node_modules/**',
      '--glob', '!**/dist/**',
      '--glob', '!**/target/**',
      '--glob', '!**/build/**',
      '--glob', '!**/.git/**',
      '--glob', '!**/*.min.js',
      '--glob', '!**/*.map',
      '--glob', '!**/*.log',
    ];

    // Scope filter handling
    if (scope === 'frontend') {
      globArgs.push('--glob', 'skt-front*/**');
      globArgs.push('--glob', '*front*/**');
      globArgs.push('--glob', '*webview*/**');
      globArgs.push('--glob', '*mobile*/**');
      globArgs.push('--glob', '*pc*/**');
    } else if (scope === 'backend') {
      globArgs.push('--glob', '!skt-front*/**');
      globArgs.push('--glob', '!*webview*/**');
    }

    if (filePattern) {
      globArgs.push('--glob', filePattern);
    }

    const scopeNote = scope === 'frontend' ? '【前端项目 skt-front】' : (scope === 'backend' ? '【后端项目 skt-back】' : '【全量项目】');

    // 1. First priority: Use built-in @vscode/ripgrep binary
    if (rgPath && fs.existsSync(rgPath)) {
      try {
        const rgArgs = ['-n', '-C', '2', '-m', '20', '--max-columns', '300', '--max-columns-preview', ...globArgs, '--', keyword, repoPath];

        const { stdout, stderr } = await execFileAsync(rgPath, rgArgs, {
          maxBuffer: 1024 * 1024 * 5,
        });

        const output = (stdout || stderr || '').trim();
        if (!output) {
          return `未在 ${scopeNote} 代码库中检索到与 "${keyword}" 相关的代码。`;
        }

        const lines = output.split('\n');
        const safeLines = lines.slice(0, 60).map((l) => (l.length > 250 ? l.slice(0, 250) + '...' : l));
        let trimmed = safeLines.join('\n');
        if (trimmed.length > 12000) {
          trimmed = trimmed.slice(0, 12000) + '\n... (搜索结果已安全截断)';
        } else if (lines.length > 60) {
          trimmed += `\n... (搜索结果已截断，保留前 60 行)`;
        }
        return trimmed;
      } catch (err: any) {
        if (err?.code === 1) {
          return `未在 ${scopeNote} 代码库中检索到与 "${keyword}" 相关的代码。`;
        }
      }
    }

    // 2. Fallback: Try system rg command or git grep
    try {
      const globPatternStr = globArgs.map((g, idx) => (idx % 2 === 1 ? `"${g}"` : g)).join(' ');
      const safeKeyword = keyword.replace(/"/g, '\\"');
      const cmd = `rg -n -C 2 ${globPatternStr} -- "${safeKeyword}" "${repoPath}" || git -C "${repoPath}" grep -n -C 2 "${safeKeyword}"`;
      const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 5 });
      const output = (stdout || stderr || '').trim();
      if (!output) {
        return `未在 ${scopeNote} 代码库中检索到与 "${keyword}" 相关的代码。`;
      }
      const lines = output.split('\n');
      if (lines.length > 100) {
        return lines.slice(0, 100).join('\n') + `\n... (搜索结果已截断，共 ${lines.length} 行)`;
      }
      return output;
    } catch {
      return `未在 ${scopeNote} 代码库中检索到与 "${keyword}" 相关的代码。`;
    }
  },
};
