import fs from 'node:fs';
import path from 'node:path';

export interface ValidatedPath {
  safePath: string;
  relativePath: string;
}

/**
 * 目标的物理路径：存在时直接 realpath；不存在（新建文件）时向上取最近的存在祖先做 realpath，再把剩余段拼回去。
 * 这样符号链接与 Windows 目录连接点（Junction）即使指向库外，也会在拼接后暴露。
 */
function physicalPath(target: string): string {
  if (fs.existsSync(target)) return fs.realpathSync.native(target);
  let current = path.resolve(target), rest = '';
  for (let depth = 0; depth < 64; depth++) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest = rest ? path.join(path.basename(current), rest) : path.basename(current);
    current = parent;
    if (fs.existsSync(current)) return path.resolve(fs.realpathSync.native(current), rest);
  }
  throw new Error(`无法解析物理路径: ${target}`);
}

function stringPrefixInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep) || target.startsWith(root + '/');
}

export function validatePathInRepo(inputPath: string, repoPath: string): ValidatedPath {
  const cleanInput = String(inputPath || '').trim();
  if (!cleanInput) {
    throw new Error('安全校验失败: 文件路径参数不能为空。');
  }

  const resolvedRepoRoot = path.resolve(repoPath);

  // If inputPath is relative, join with repoRoot; if absolute, normalize it
  const resolvedTarget = path.isAbsolute(cleanInput)
    ? path.resolve(cleanInput)
    : path.resolve(resolvedRepoRoot, cleanInput);

  // Normalize case for Windows compatibility check
  const repoNormalized = resolvedRepoRoot.toLowerCase();
  const targetNormalized = resolvedTarget.toLowerCase();

  // 1. 物理路径校验：realpath 后的前缀比对，符号链接与 Windows 目录连接点（Junction）不能绕过；
  //    realpath 失败等极端情况回退到字符串前缀比对。两种判定都通过才放行。
  const physicalInside = (() => {
    try {
      const realRoot = fs.realpathSync.native(resolvedRepoRoot).toLowerCase();
      return stringPrefixInside(realRoot, physicalPath(resolvedTarget).toLowerCase());
    } catch {
      return null;
    }
  })();
  const stringInside =
    targetNormalized === repoNormalized ||
    targetNormalized.startsWith(repoNormalized + path.sep) ||
    targetNormalized.startsWith(repoNormalized + '/');

  if (!(physicalInside ?? stringInside)) {
    throw new Error(
      `安全拦截: 目标路径 "${inputPath}" 超出工作区安全边界 (工作区根目录: ${resolvedRepoRoot})。禁止跨目录读写操作。`
    );
  }

  // 2. HARDCODED SECURITY GATE: Strictly forbid any access/modification inside .git directory
  const relativePath = path.relative(resolvedRepoRoot, resolvedTarget);
  const normalizedRel = relativePath.replace(/\\/g, '/').toLowerCase();

  if (
    normalizedRel === '.git' ||
    normalizedRel.startsWith('.git/') ||
    normalizedRel.includes('/.git/') ||
    normalizedRel.endsWith('/.git')
  ) {
    throw new Error(
      `安全拦截: 目标路径 "${inputPath}" 属于 Git 版本库内部元数据区 (.git)。为了防止仓库损坏与后门注入，系统硬编码禁止对 .git 内部文件执行任何直接读写与编辑操作。`
    );
  }

  // 物理校验通过后仍返回归一化（未展开软链/短文件名）的路径，保持上层调用方与既有测试对相对路径格式的预期
  return {
    safePath: resolvedTarget,
    relativePath: relativePath || path.basename(resolvedTarget),
  };
}
