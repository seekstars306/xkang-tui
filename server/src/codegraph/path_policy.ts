// 统一路径排除策略：检索（search_code）、读取（read_file_lines）、git 历史（git_inspect）
// 与代码图谱索引（indexer）四个入口共用同一份定义，避免"改了 glob 漏了图谱"。
// 匹配按路径段进行，不是子串——否则 FooServiceOld.java 之类会被 *.old 误伤。

/** 目录名命中即排除（按段完整匹配） */
export const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  '.idea',
  '.vscode',
  'bin',
  'prod-config',
]);

/** ripgrep --glob 排除项（负向 glob） */
export const EXCLUDED_FILE_GLOBS: readonly string[] = [
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/target/**',
  '!**/build/**',
  '!**/.git/**',
  '!**/*.min.js',
  '!**/*.min.css',
  '!**/*.map',
  '!**/*.log',
  '!**/package-lock.json',
  '!**/yarn.lock',
  '!**/pnpm-lock.yaml',
  '!**/prod-config/**',
  '!**/*.bak',
  '!**/*.bak.*',
  '!**/*.old',
  '!**/*.orig',
];

/** 给工具结果用的一句话说明 */
export const EXCLUDED_REASON: Record<string, string> = {
  dir: '该目录属于构建产物、版本库元数据或生产配置目录，按安全策略不向模型开放',
  backup: '备份/旧版/合并残留文件可能含历史配置与凭据，按安全策略不向模型开放',
};

function toSegments(relPath: string): string[] {
  return relPath.replace(/\\/g, '/').split('/').filter(Boolean);
}

/** 目录名是否在排除名单内 */
export function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIR_NAMES.has(name);
}

/**
 * 返回命中排除策略的原因；未命中返回 null。
 * 目录段完整匹配 EXCLUDED_DIR_NAMES；文件名按后缀匹配 *.bak / *.bak.<日期> / *.old / *.orig（大小写不敏感）。
 */
export function excludedReason(relPath: string): string | null {
  const segments = toSegments(relPath);
  const dir = segments.find(seg => EXCLUDED_DIR_NAMES.has(seg));
  if (dir) return `${EXCLUDED_REASON.dir}（命中目录 ${dir}）`;
  const fileName = segments[segments.length - 1] || '';
  if (/\.bak(?:\.[^.]+)?$/i.test(fileName)) return `${EXCLUDED_REASON.backup}（命中文件 ${fileName}）`;
  if (/\.(?:old|orig)$/i.test(fileName)) return `${EXCLUDED_REASON.backup}（命中文件 ${fileName}）`;
  return null;
}

/** 相对路径是否命中排除策略 */
export function isExcludedPath(relPath: string): boolean {
  return excludedReason(relPath) !== null;
}
