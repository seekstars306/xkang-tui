import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** src/feishu and dist/feishu have the same depth; never depend on launch cwd. */
export function resolveFeishuPaths(moduleUrl: string = import.meta.url) {
  const directory = path.dirname(fileURLToPath(moduleUrl));
  return {
    webRoot: path.resolve(directory, '../../../web'),
    monitorDbPath: path.resolve(directory, '../../data/feishu_monitor.db'),
  };
}
export const FEISHU_PATHS = resolveFeishuPaths();
