import express, { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';

export interface VersionInfo {
  version: string;
  releaseDate: string;
  releaseNotes: string[];
  mandatory: boolean;
  downloadUrl: string;
  fileSize?: number;
}

export const LATEST_CLIENT_VERSION: VersionInfo = {
  version: '1.1.0',
  releaseDate: '2026-08-18',
  releaseNotes: [
    '新增「前端工程优先检索」模式，截图与界面文案秒级定位',
    '全量接入 GitLab 16 个代码库 CodeGraph 拓扑知识图谱',
    '硬编码防越权安全网关：彻底锁死 Git 写操作与 .git 元数据区',
    '新增 / 键快捷指令弹窗与 Tab 键智能补全',
    '优化实时流式思考与工具调用的高可视度动态加载动画',
  ],
  mandatory: false,
  downloadUrl: '/download/latest/xhang.exe',
};

function resolveReleasesDir(customDir?: string): string {
  const candidates = [
    customDir ? path.resolve(customDir) : '',
    path.resolve(process.cwd(), 'server/data/releases'),
    path.resolve(process.cwd(), 'data/releases'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'xhang.exe'))) {
      return c;
    }
  }
  return candidates[0] || path.resolve(process.cwd(), 'server/data/releases');
}

export function setupDownloadRoutes(app: express.Express, releasesDir: string): void {
  const resolvedReleasesDir = resolveReleasesDir(releasesDir);
  if (!fs.existsSync(resolvedReleasesDir)) {
    fs.mkdirSync(resolvedReleasesDir, { recursive: true });
  }

  // 1. Version Check API (Public, unauthenticated for seamless startup check)
  app.get('/download/latest/version', (_req: Request, res: Response) => {
    const currentDir = resolveReleasesDir(releasesDir);
    const exePath = path.join(currentDir, 'xhang.exe');
    const versionJsonPath = path.join(currentDir, 'version.json');
    let fileSize = 0;
    if (fs.existsSync(exePath)) {
      try {
        fileSize = fs.statSync(exePath).size;
      } catch {
        // ignore
      }
    }

    let dynamicVersionInfo: Partial<VersionInfo> = {};
    if (fs.existsSync(versionJsonPath)) {
      try {
        dynamicVersionInfo = JSON.parse(fs.readFileSync(versionJsonPath, 'utf-8'));
      } catch {
        // fallback to default
      }
    }

    res.json({
      ...LATEST_CLIENT_VERSION,
      ...dynamicVersionInfo,
      fileSize: fileSize || dynamicVersionInfo.fileSize || 0,
    });
  });

  // 2. Direct EXE binary & Icon download for clients
  app.get('/download/latest/xhang.exe', (_req: Request, res: Response) => {
    const currentDir = resolveReleasesDir(releasesDir);
    const exePath = path.join(currentDir, 'xhang.exe');
    if (fs.existsSync(exePath)) {
      res.download(exePath, 'xhang.exe');
    } else {
      res.status(404).json({
        error: '未找到发布的可执行文件包，请管理员先执行打包构建发布脚本 (npm run build:exe)。',
      });
    }
  });

  app.get('/download/latest/icon.ico', (_req: Request, res: Response) => {
    const currentDir = resolveReleasesDir(releasesDir);
    const icoPath = path.join(currentDir, 'icon.ico');
    if (fs.existsSync(icoPath)) {
      res.download(icoPath, 'icon.ico');
    } else {
      res.status(404).send('Icon not found');
    }
  });

  app.get('/download/latest/icon.png', (_req: Request, res: Response) => {
    const currentDir = resolveReleasesDir(releasesDir);
    const pngPath = path.join(currentDir, 'icon.png');
    if (fs.existsSync(pngPath)) {
      res.download(pngPath, 'icon.png');
    } else {
      res.status(404).send('Icon PNG not found');
    }
  });

  // 3. One-click Windows desktop installer batch script for non-technical customer service staff
  app.get('/download/install.bat', (req: Request, res: Response) => {
    const host = req.get('host') || 'localhost:8090';
    const protocol = req.protocol || 'http';
    const serverUrl = `${protocol}://${host}`;

    const batScript = `@echo off
chcp 65001 >nul
title 小康 TUI 智能排障助手 - 一键安装程序

echo ========================================================================
echo           🤖 正在为客服电脑安装【小康 TUI 智能排障助手】...
echo ========================================================================
echo.

set "TARGET_DIR=%LOCALAPPDATA%\\xkang-tui"
set "EXE_PATH=%TARGET_DIR%\\xhang.exe"
set "ICO_PATH=%TARGET_DIR%\\icon.ico"
set "DOWNLOAD_URL=${serverUrl}/download/latest/xhang.exe"
set "ICO_URL=${serverUrl}/download/latest/icon.ico"

if not exist "%TARGET_DIR%" (
    mkdir "%TARGET_DIR%"
)

echo [1/3] 正在从公司服务端高速下载排障程序与官方 Logo 图标 ...
curl -s -L "%DOWNLOAD_URL%" -o "%EXE_PATH%"
curl -s -L "%ICO_URL%" -o "%ICO_PATH%"
if errorlevel 1 (
    echo.
    echo [错误] 下载客户端失败，请检查网络是否能连接公司服务: ${serverUrl}
    pause
    exit /b 1
)

echo [2/3] 正在生成带有小康 TUI 图标的桌面快捷方式...
set "VBS_SCRIPT=%TEMP%\\create_skt_shortcut.vbs"
(
echo Set oWS = WScript.CreateObject^("WScript.Shell"^)
echo sLinkFile = oWS.SpecialFolders^("Desktop"^) ^& "\\🤖 小康TUI-智能排障助手.lnk"
echo Set oLink = oWS.CreateShortcut^(sLinkFile^)
echo oLink.TargetPath = "%EXE_PATH%"
echo oLink.WorkingDirectory = "%USERPROFILE%"
echo oLink.Description = "小康TUI客服与技术支持代码业务智能排障终端"
echo oLink.IconLocation = "%ICO_PATH%,0"
echo oLink.Save
) > "%VBS_SCRIPT%"

cscript //nologo "%VBS_SCRIPT%"
del "%VBS_SCRIPT%" >nul 2>&1

echo [3/3] 配置全局环境变量路径...
setx PATH "%PATH%;%TARGET_DIR%" >nul 2>&1

echo.
echo ========================================================================
echo  🎉 安装成功！桌面已生成【🤖 小康TUI-智能排障助手】快捷方式，双击即可直接使用！
echo ========================================================================
echo.
pause
`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="install.bat"');
    res.send(batScript);
  });
}
