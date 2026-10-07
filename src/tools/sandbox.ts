import path from 'node:path';

export interface ValidatedPath {
  safePath: string;
  relativePath: string;
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

  // 1. Target must be inside repo root or equal to repo root
  const isInside =
    targetNormalized === repoNormalized ||
    targetNormalized.startsWith(repoNormalized + path.sep) ||
    targetNormalized.startsWith(repoNormalized + '/');

  if (!isInside) {
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

  return {
    safePath: resolvedTarget,
    relativePath: relativePath || path.basename(resolvedTarget),
  };
}
