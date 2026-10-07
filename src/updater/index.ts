import fs from 'node:fs';
import path from 'node:path';

export const CURRENT_CLIENT_VERSION = '1.1.99';

export interface RemoteVersionInfo {
  version: string;
  releaseDate: string;
  releaseNotes: string[];
  mandatory: boolean;
  downloadUrl: string;
  fileSize?: number;
}

export interface CheckUpdateResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseNotes?: string[];
  downloadUrl?: string;
  error?: string;
}

function compareVersions(v1: string, v2: string): number {
  const p1 = v1.replace(/^v/i, '').split('.').map(Number);
  const p2 = v2.replace(/^v/i, '').split('.').map(Number);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

export async function checkForUpdates(serverUrl?: string): Promise<CheckUpdateResult> {
  if (!serverUrl) {
    return { hasUpdate: false, currentVersion: CURRENT_CLIENT_VERSION };
  }

  const cleanServer = serverUrl.replace(/\/+$/, '');
  const url = `${cleanServer}/download/latest/version`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);

    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);

    if (!resp.ok) {
      return {
        hasUpdate: false,
        currentVersion: CURRENT_CLIENT_VERSION,
        error: `HTTP ${resp.status}`,
      };
    }

    const data = (await resp.json()) as RemoteVersionInfo;
    const hasUpdate = compareVersions(data.version, CURRENT_CLIENT_VERSION) > 0;

    return {
      hasUpdate,
      currentVersion: CURRENT_CLIENT_VERSION,
      latestVersion: data.version,
      releaseNotes: data.releaseNotes,
      downloadUrl: data.downloadUrl.startsWith('http')
        ? data.downloadUrl
        : `${cleanServer}${data.downloadUrl.startsWith('/') ? '' : '/'}${data.downloadUrl}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      hasUpdate: false,
      currentVersion: CURRENT_CLIENT_VERSION,
      error: msg,
    };
  }
}

/**
 * 安全写入文件（处理 Windows 下已存在/被占用文件的重试与回退命名）
 */
function safeWriteDownloadedBinary(targetPath: string, buffer: Buffer): string {
  // 1. 先尝试直接写入目标路径
  try {
    // 如果文件已存在，先尝试安全重命名备份以避开文件锁
    if (fs.existsSync(targetPath)) {
      const oldBackup = `${targetPath}.old_${Date.now()}`;
      try {
        fs.renameSync(targetPath, oldBackup);
        try { fs.unlinkSync(oldBackup); } catch {}
      } catch {
        // 如果无法重命名（正在被另一个进程以写独占打开），则尝试直接 unlink
        try { fs.unlinkSync(targetPath); } catch {}
      }
    }

    fs.writeFileSync(targetPath, buffer);
    return targetPath;
  } catch (err) {
    // 2. 如果因为 EBUSY（文件正在运行/被占用）导致直接写入失败，则写入带时间戳的可用文件
    const dir = path.dirname(targetPath);
    const ext = path.extname(targetPath) || '.exe';
    const base = path.basename(targetPath, ext);
    const fallbackPath = path.join(dir, `${base}_v${Date.now()}${ext}`);
    fs.writeFileSync(fallbackPath, buffer);
    return fallbackPath;
  }
}

export async function performAutoUpdate(
  downloadUrl: string,
  onProgress?: (message: string) => void
): Promise<{ success: boolean; message: string }> {
  try {
    onProgress?.('正在从服务端下载最新版可执行程序...');

    const resp = await fetch(downloadUrl);
    if (!resp.ok) {
      return {
        success: false,
        message: `下载失败 (HTTP ${resp.status}): 请确认服务端更新文件是否存在。`,
      };
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length < 10) {
      return {
        success: false,
        message: '下载的文件内容异常，更新中止。',
      };
    }

    // Determine current running binary location
    const currentExe = process.execPath;
    const isWindowsExe = currentExe.toLowerCase().endsWith('.exe');

    // 1. 如果当前就是作为打包好的单文件 EXE 运行
    if (isWindowsExe && !currentExe.toLowerCase().includes('node.exe')) {
      const tempNewExe = `${currentExe}.new_${Date.now()}`;
      fs.writeFileSync(tempNewExe, buffer);

      // Windows 下正在运行的 exe 允许重命名为 .bak，但不允许直接覆写
      const backupExe = `${currentExe}.bak_${Date.now()}`;
      try {
        fs.renameSync(currentExe, backupExe);
        fs.renameSync(tempNewExe, currentExe);
        try {
          fs.unlinkSync(backupExe);
        } catch {
          // ignore backup cleanup error on Windows
        }

        onProgress?.('更新包替换完成！');
        return {
          success: true,
          message: '客户端已成功自动更新至最新版本！请重启终端生效。',
        };
      } catch (renameErr) {
        // Fallback: 写入到当前目录下
        const savedPath = safeWriteDownloadedBinary(path.resolve(process.cwd(), 'xhang_latest.exe'), buffer);
        try { fs.unlinkSync(tempNewExe); } catch {}
        return {
          success: true,
          message: `新版本已下载到: ${savedPath}，请关闭当前终端并使用新版本启动。`,
        };
      }
    } else {
      // 2. 在开发环境或通过 node 启动时
      const defaultDownloadPath = path.resolve(process.cwd(), 'xhang_latest.exe');
      const finalPath = safeWriteDownloadedBinary(defaultDownloadPath, buffer);
      return {
        success: true,
        message: `已成功将最新独立可执行文件下载至: ${finalPath} (共 ${(buffer.length / 1024 / 1024).toFixed(1)} MB)，双击即可直接使用！`,
      };
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      message: `自动更新失败: ${errorMsg}`,
    };
  }
}
