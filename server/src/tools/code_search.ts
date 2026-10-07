import { execFile, exec, spawn, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import { ServerConfig } from '../types.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/**
 * Streams ripgrep output with hard line and byte limits, killing the process once the
 * cap is reached. Never hits child_process maxBuffer limits or blows up LLM context window.
 */
function runRipgrepCapped(
  rgBinary: string,
  rgArgs: string[],
  maxLines = 60,
  maxChars = 12000
): Promise<{ output: string; truncated: boolean; totalLines: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(rgBinary, rgArgs, { windowsHide: true });
    let buffer = '';
    let resolved = false;

    const finish = (result: { output: string; truncated: boolean; totalLines: number }) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (resolved) return;
      buffer += chunk.toString();
      const lines = buffer.split('\n');

      if (lines.length > maxLines || buffer.length > maxChars) {
        // Cap reached: stop consuming, kill the process, return the truncated output
        const safeLines = lines.slice(0, maxLines).map((l) => (l.length > 250 ? l.slice(0, 250) + '...' : l));
        let trimmedBuffer = safeLines.join('\n');
        if (trimmedBuffer.length > maxChars) {
          trimmedBuffer = trimmedBuffer.slice(0, maxChars);
        }
        try {
          child.kill();
        } catch {}
        finish({ output: trimmedBuffer, truncated: true, totalLines: lines.length });
      }
    });

    // Drain stderr to prevent backpressure stalls
    child.stderr.on('data', () => {});

    child.on('error', (err: Error) => {
      if (!resolved) reject(err);
    });

    child.on('close', () => {
      if (resolved) return;
      const rawLines = buffer.split('\n').filter(Boolean);
      const safeLines = rawLines.map((l) => (l.length > 250 ? l.slice(0, 250) + '...' : l));
      let finalOutput = safeLines.join('\n');
      let isTruncated = false;
      if (finalOutput.length > maxChars) {
        finalOutput = finalOutput.slice(0, maxChars);
        isTruncated = true;
      }
      finish({
        output: finalOutput,
        truncated: isTruncated,
        totalLines: rawLines.length,
      });
    });
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalizes LLM boolean-style and list queries into ripgrep regex syntax:
 * - "A OR B OR C"        -> "A|B|C"
 * - "A AND B"            -> "A|B" (returns matches for both terms across files)
 * - "A (B OR C)"         -> "A.*(B|C)"  (bridges same-line co-occurrence)
 * - "A, B, C" / "A，B"   -> "A|B|C" (comma-separated lists)
 * - quoted "phrases"     -> surrounding quotes stripped
 * Keywords without boolean/list syntax pass through untouched (regex capability preserved).
 * Falls back to literal-escaped search if the constructed pattern is invalid regex.
 */
function buildSearchPattern(rawKeyword: string): string {
  const trimmed = rawKeyword.trim();

  // 1. Check if the query has boolean OR, AND, or list syntax
  const hasOr = /\s+(?:OR|\|\|)\s+/i.test(trimmed);
  const hasAnd = /\s+(?:AND|&&)\s+/i.test(trimmed);
  const hasCommas = /[,，]/.test(trimmed) && !/[(){}[\]]/.test(trimmed);

  if (!hasOr && !hasAnd && !hasCommas) {
    return trimmed;
  }

  // Strip surrounding double/single quotes from sub-phrases
  let pattern = trimmed.replace(/["']([^"']*)["']/g, '$1');

  // Handle AND syntax: A AND B -> A|B (finds both concepts across files)
  if (hasAnd && !hasOr && !hasCommas) {
    const parts = pattern.split(/\s+(?:AND|&&)\s+/i).map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      pattern = parts.map(escapeRegExp).join('|');
    }
  } else {
    // Bridge "A (B OR C)" -> "A.*(B|C)"
    pattern = pattern.replace(/\s+\(/g, '.*(');
    // Convert OR / ||
    pattern = pattern.replace(/\s+(?:OR|\|\|)\s+/gi, '|');
    // Convert comma lists: "fee, price" -> "fee|price"
    if (hasCommas && !pattern.includes('|')) {
      const items = pattern.split(/[,，]\s*/).map(s => s.trim()).filter(Boolean);
      if (items.length > 1) {
        pattern = items.map(escapeRegExp).join('|');
      }
    }
  }

  // Invalid regex falls back to literal search
  try {
    new RegExp(pattern);
    return pattern;
  } catch {
    return escapeRegExp(trimmed);
  }
}

/**
 * Auto-locates a file inside the repo by bare name or partial path
 */
function findFileInRepo(repoRoot: string, bareName: string): string[] {
  if (!rgPath || !fs.existsSync(rgPath)) return [];
  try {
    const cleanName = path.basename(bareName);
    const out = execFileSync(rgPath, ['--files', '-g', '*' + cleanName, repoRoot], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function executeSearchCode(
  args: {
    keyword: string;
    scope?: string;
    filePattern?: string;
  },
  config: ServerConfig
): Promise<string> {
  const keyword = String(args.keyword || '');
  const scope = args.scope || 'all';
  const filePattern = args.filePattern;
  const repoPath = config.codeRepoPath || '';

  if (!keyword.trim()) {
    return '错误: 搜索关键字不能为空。';
  }

  if (!repoPath) {
    return '错误: 服务端未配置 CODE_REPO_PATH，无法执行代码检索。请联系管理员在 server/.env 中配置。';
  }

  if (!fs.existsSync(repoPath)) {
    return `错误: 服务端配置的代码库路径不存在: ${repoPath}`;
  }

  const globArgs: string[] = [];

  // 基础排除高危/超大依赖与产物目录
  globArgs.push(
    '--glob', '!**/node_modules/**',
    '--glob', '!**/dist/**',
    '--glob', '!**/target/**',
    '--glob', '!**/build/**',
    '--glob', '!**/.git/**',
    '--glob', '!**/*.min.js',
    '--glob', '!**/*.map',
    '--glob', '!**/*.log'
  );

  if (scope === 'frontend') {
    globArgs.push('--glob', '*skt-front*/**');
    globArgs.push('--glob', '*front*/**');
    globArgs.push('--glob', '*webview*/**');
    globArgs.push('--glob', '*mobile*/**');
    globArgs.push('--glob', '*pc*/**');
  } else if (scope === 'backend') {
    globArgs.push('--glob', '!*skt-front*/**');
    globArgs.push('--glob', '!*front*/**');
    globArgs.push('--glob', '!*webview*/**');
  }

  if (filePattern) {
    // If the filePattern has no wildcards (* or ?), wrap as *pattern* to match partial names (e.g. "HotelOrderService" -> "*HotelOrderService*")
    const cleanPattern = !/[*?]/.test(filePattern) ? `*${filePattern}*` : filePattern;
    globArgs.push('--glob', cleanPattern);
  }

  const scopeNote =
    scope === 'frontend'
      ? '【前端项目 skt-front】'
      : scope === 'backend'
        ? '【后端项目 skt-back】'
        : '【全量项目】';

  if (rgPath && fs.existsSync(rgPath)) {
    try {
      const searchPattern = buildSearchPattern(keyword);
      // -S: smart-case
      // -m 20: at most 20 matches per file
      // --max-columns 300: prevent giant minified/xml lines from exploding context
      // --max-columns-preview: show snippet when line exceeds max columns
      const rgArgs = [
        '-n', '-C', '2', '-S', '-m', '20', '--max-columns', '300', '--max-columns-preview', '--no-messages',
        ...globArgs, '--', searchPattern, repoPath,
      ];
      const { output, truncated } = await runRipgrepCapped(rgPath, rgArgs, 60, 12000);

      const trimmed = (output || '').trim();
      if (!trimmed) {
        return `未在 ${scopeNote} 代码库中检索到与 "${keyword}" 相关的代码。`;
      }

      if (truncated) {
        return trimmed + `\n... (搜索结果过大，已自动安全截断，共保留前序核心匹配行)`;
      }
      return trimmed;
    } catch (err: any) {
      return `搜索执行错误: ${err?.message || String(err)}`;
    }
  }

  return '错误: 服务端未安装 ripgrep 二进制 (@vscode/ripgrep)。';
}

export async function executeReadFileLines(
  args: {
    filePath: string;
    startLine?: number;
    endLine?: number;
  },
  config: ServerConfig
): Promise<string> {
  const rawPath = String(args.filePath || (args as any).file_path || '');
  if (!rawPath.trim()) {
    return '错误: filePath 参数不能为空。';
  }

  const repoPath = config.codeRepoPath || '';
  if (!repoPath) {
    return '错误: 服务端未配置 CODE_REPO_PATH，无法读取代码文件。';
  }

  const resolvedRepoRoot = path.resolve(repoPath);
  const resolvedTarget = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(resolvedRepoRoot, rawPath);

  let actualTarget = resolvedTarget;

  // Auto-locate fallback: if the directly resolved path doesn't exist, search the repo for matching filename
  if (!fs.existsSync(actualTarget)) {
    const candidates = findFileInRepo(resolvedRepoRoot, rawPath);
    if (candidates.length === 1) {
      actualTarget = candidates[0];
    } else if (candidates.length > 1) {
      // Pick best candidate matching subpath fragments, or first candidate
      const cleanNorm = rawPath.replace(/\\/g, '/').toLowerCase();
      const best = candidates.find((c) => c.replace(/\\/g, '/').toLowerCase().includes(cleanNorm)) || candidates[0];
      actualTarget = best;
    }
  }

  const repoNormalized = resolvedRepoRoot.toLowerCase();
  const targetNormalized = actualTarget.toLowerCase();

  const isInside =
    targetNormalized === repoNormalized ||
    targetNormalized.startsWith(repoNormalized + path.sep) ||
    targetNormalized.startsWith(repoNormalized + '/');

  if (!isInside) {
    return `安全拦截: 目标路径 "${rawPath}" 超出代码库安全边界 (根目录: ${resolvedRepoRoot})。禁止跨目录读写操作。`;
  }

  const relativePath = path.relative(resolvedRepoRoot, actualTarget);
  const normalizedRel = relativePath.replace(/\\/g, '/').toLowerCase();
  if (
    normalizedRel === '.git' ||
    normalizedRel.startsWith('.git/') ||
    normalizedRel.includes('/.git/') ||
    normalizedRel.endsWith('/.git')
  ) {
    return '安全拦截: 目标路径属于 Git 版本库内部元数据区 (.git)，禁止访问。';
  }

  try {
    const content = await fs.promises.readFile(actualTarget, 'utf-8');
    const lines = content.split('\n');
    const start = args.startLine ? Math.max(1, Number(args.startLine)) : 1;
    const end = args.endLine ? Math.min(lines.length, Number(args.endLine)) : lines.length;

    const selected = lines.slice(start - 1, end).map((l, idx) => `${start + idx}: ${l}`);
    const note = actualTarget !== resolvedTarget ? `【自动定位文件: ${relativePath}】\n` : '';
    return note + selected.join('\n');
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return `读取文件失败 [${relativePath}]: ${errorMsg}`;
  }
}

export async function executeGitInspect(
  args: {
    action: string;
    filePath: string;
    lineRange?: string;
  },
  config: ServerConfig
): Promise<string> {
  const action = String(args.action || 'log');
  const rawPath = String(args.filePath || '');
  const repoPath = config.codeRepoPath || '';

  if (!rawPath.trim()) {
    return '错误: filePath 参数不能为空。';
  }

  if (!repoPath) {
    return '错误: 服务端未配置 CODE_REPO_PATH。';
  }

  const resolvedRepoRoot = path.resolve(repoPath);
  const resolvedTarget = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(resolvedRepoRoot, rawPath);

  const repoNormalized = resolvedRepoRoot.toLowerCase();
  const targetNormalized = resolvedTarget.toLowerCase();

  const isInside =
    targetNormalized === repoNormalized ||
    targetNormalized.startsWith(repoNormalized + path.sep) ||
    targetNormalized.startsWith(repoNormalized + '/');

  if (!isInside) {
    return `安全拦截: 目标路径 "${rawPath}" 超出代码库安全边界 (根目录: ${resolvedRepoRoot})。`;
  }

  const relativePath = path.relative(resolvedRepoRoot, resolvedTarget);
  const normalizedRel = relativePath.replace(/\\/g, '/').toLowerCase();
  if (
    normalizedRel === '.git' ||
    normalizedRel.startsWith('.git/') ||
    normalizedRel.includes('/.git/') ||
    normalizedRel.endsWith('/.git')
  ) {
    return '安全拦截: 目标路径属于 Git 版本库内部元数据区 (.git)，禁止访问。';
  }

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
      cmd = `git -C "${resolvedRepoRoot}" blame ${lineRange} -- "${relativePath}"`;
    } else {
      cmd = `git -C "${resolvedRepoRoot}" log -n 5 --pretty=format:"%h - %an (%ad): %s" --date=short -- "${relativePath}"`;
    }

    const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 20 });
    if (!stdout.trim()) {
      return `未获取到 [${relativePath}] 的 Git ${action} 记录。`;
    }
    return `【Git ${action.toUpperCase()} 记录】\n` + stdout;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return `Git 查询失败: ${errorMsg}`;
  }
}
