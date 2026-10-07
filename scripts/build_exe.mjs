import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

console.log('========================================================================');
console.log('🚀 开始打包构建【小康TUI-智能排障助手】免安装单文件 EXE 与服务端分发包...');
console.log('========================================================================\n');

const ROOT_DIR = process.cwd();
const RELEASES_DIR = path.join(ROOT_DIR, 'server', 'data', 'releases');
const VERSION_JSON_PATH = path.join(RELEASES_DIR, 'version.json');

if (!fs.existsSync(RELEASES_DIR)) {
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
}

// 0. Calculate target release version (auto-increment patch or manual override)
const manualVersionArg = process.argv[2]?.trim();
let currentBaseVersion = '1.1.0';

if (fs.existsSync(VERSION_JSON_PATH)) {
  try {
    const vj = JSON.parse(fs.readFileSync(VERSION_JSON_PATH, 'utf-8'));
    if (vj.version) currentBaseVersion = vj.version;
  } catch {}
} else {
  const clientUpdaterPath = path.join(ROOT_DIR, 'src', 'updater', 'index.ts');
  if (fs.existsSync(clientUpdaterPath)) {
    const src = fs.readFileSync(clientUpdaterPath, 'utf-8');
    const m = src.match(/CURRENT_CLIENT_VERSION = ['"]([^'"]+)['"]/);
    if (m) currentBaseVersion = m[1];
  }
}

function incrementPatch(ver) {
  const parts = ver.replace(/^v/i, '').split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join('.');
}

const targetVersion = manualVersionArg && /^\d+\.\d+\.\d+/.test(manualVersionArg)
  ? manualVersionArg.replace(/^v/i, '')
  : incrementPatch(currentBaseVersion);

console.log(`[0/3] 计算发布版本号: 上一版本 [v${currentBaseVersion}] ➔ 当前打包版本 [v${targetVersion}]`);

// Sync version into client updater source so the new exe knows its own version
const clientUpdaterPath = path.join(ROOT_DIR, 'src', 'updater', 'index.ts');
let clientUpdaterSrc = fs.readFileSync(clientUpdaterPath, 'utf-8');
clientUpdaterSrc = clientUpdaterSrc.replace(
  /export const CURRENT_CLIENT_VERSION = ['"][^'"]+['"]/,
  `export const CURRENT_CLIENT_VERSION = '${targetVersion}'`,
);
fs.writeFileSync(clientUpdaterPath, clientUpdaterSrc, 'utf-8');
console.log(`   ✅ 客户端源码内嵌版本号已写入: ${targetVersion}`);

// 1. TypeScript Build
console.log('[1/3] 编译 TypeScript 源代码 (Client & Server)...');
execSync('npm run build && npm run --prefix server build', { stdio: 'inherit' });
console.log('   ✅ TypeScript 编译成功！');

// 2. Package Standalone Binary via caxa with native custom Icon Stub
console.log('\n[2/3] 正在封装打包为独立免安装可执行程序 (xhang.exe)...');
const targetExePath = path.join(ROOT_DIR, 'xhang.exe');
const releaseExePath = path.join(RELEASES_DIR, 'xhang.exe');
const rceditExePath = path.join(ROOT_DIR, 'tools', 'rcedit.exe');
const icoPath = path.join(ROOT_DIR, 'assets', 'icon.ico');

// Clean up any existing local exe to prevent recursive embedding
if (fs.existsSync(targetExePath)) {
  try {
    fs.unlinkSync(targetExePath);
  } catch {
    try {
      execSync('taskkill /F /IM xhang.exe', { stdio: 'ignore' });
      fs.unlinkSync(targetExePath);
    } catch {}
  }
}

execSync(
  `npx --yes caxa --input "." --output "xhang.exe" --exclude "server" ".git" "scripts" "src" "tools" "*.exe" "*.log" ".env*" ".env" "node_modules/typescript" "node_modules/@types" "test_*" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/dist/cli.js"`,
  { stdio: 'inherit' }
);

// 2.1 Native Windows PE Icon & Metadata Injection without corrupting payload overlay
if (fs.existsSync(targetExePath) && fs.existsSync(rceditExePath) && fs.existsSync(icoPath)) {
  console.log('   🎨 正在为 xhang.exe 注入小康 TUI 官方透明 Logo 图标及版本元数据...');
  try {
    const rawExeBuffer = fs.readFileSync(targetExePath);
    const sep = Buffer.from('\nCAXACAXACAXA\n');
    const sepIndex = rawExeBuffer.indexOf(sep);

    if (sepIndex !== -1) {
      const payloadAndFooter = rawExeBuffer.slice(sepIndex);
      const stubOnlyBuffer = rawExeBuffer.slice(0, sepIndex);

      // Write pure PE stub temporarily
      const tempStubPath = path.join(ROOT_DIR, 'tools', 'temp_stub_for_icon.exe');
      fs.writeFileSync(tempStubPath, stubOnlyBuffer);

      // Patch PE resource section with official icon and metadata
      execSync(
        `"${rceditExePath}" "${tempStubPath}" --set-icon "${icoPath}" --set-product-version "${targetVersion}" --set-file-version "${targetVersion}.0" --set-version-string "FileDescription" "小康TUI客服智能排障终端" --set-version-string "ProductName" "小康TUI智能排障助手" --set-version-string "CompanyName" "小康科技"`,
        { stdio: 'ignore' }
      );

      // Read back patched PE and re-append payloadAndFooter seamlessly
      const patchedStubBuffer = fs.readFileSync(tempStubPath);
      const finalExeBuffer = Buffer.concat([patchedStubBuffer, payloadAndFooter]);
      fs.writeFileSync(targetExePath, finalExeBuffer);

      try { fs.unlinkSync(tempStubPath); } catch {}
      console.log('   ✅ 官方透明 Logo 图标已成功内嵌至 xhang.exe Windows PE 资源段！');
    }
  } catch (iconErr) {
    console.log('   ⚠ 图标内嵌出现微小异常，保留标准二进制:', iconErr.message);
  }
}

if (fs.existsSync(targetExePath)) {
  fs.copyFileSync(targetExePath, releaseExePath);
  const sizeBytes = fs.statSync(targetExePath).size;
  const sizeMb = (sizeBytes / 1024 / 1024).toFixed(1);
  console.log(`   ✅ 独立可执行程序构建成功: ${targetExePath} (体积: ${sizeMb} MB)`);
  console.log(`   ✅ 服务端发布分发镜像已同步: ${releaseExePath}`);

  // Copy icon files to release directory
  const icoSource = path.join(ROOT_DIR, 'assets', 'icon.ico');
  const pngSource = path.join(ROOT_DIR, 'assets', 'icon.png');
  if (fs.existsSync(icoSource)) {
    fs.copyFileSync(icoSource, path.join(RELEASES_DIR, 'icon.ico'));
    console.log(`   ✅ 官方透明 ICO 图标已就绪: ${path.join(RELEASES_DIR, 'icon.ico')}`);
  }
  if (fs.existsSync(pngSource)) {
    fs.copyFileSync(pngSource, path.join(RELEASES_DIR, 'icon.png'));
  }

  // Write dynamic version.json for server /download/latest/version endpoint
  const versionPayload = {
    version: targetVersion,
    releaseDate: new Date().toISOString().slice(0, 10),
    releaseNotes: [
      `v${targetVersion} 生产发布更新`,
      '全新小康 TUI 官方透明矢量图标与桌面品牌集成',
      '全量 128k 上下文原生支持，取消代码搜索与探索历史过早截断',
      'search_code / read_file_lines / git_inspect 全面迁移至服务端安全沙箱执行',
      'PowerShell 本地执行策略切换为黑名单安全管控模式',
      '优化长任务多步排障自动续推与完整三段式排障报告输出',
    ],
    mandatory: false,
    downloadUrl: '/download/latest/xhang.exe',
    fileSize: sizeBytes,
  };
  fs.writeFileSync(VERSION_JSON_PATH, JSON.stringify(versionPayload, null, 2), 'utf-8');
  console.log(`   ✅ 服务端版本发布元数据已就绪: ${VERSION_JSON_PATH} (v${targetVersion})`);
}

// 3. Generate One-click Desktop Installer BAT for customer service staff
console.log('\n[3/3] 生成客服电脑【一键部署到桌面】批处理安装脚本...');
const installerBatContent = `@echo off
chcp 65001 >nul
title 小康 TUI 智能排障助手 - 极简一键安装程序

echo ========================================================================
echo        🤖 正在为客服电脑一键配置【小康 TUI 智能排障助手】...
echo ========================================================================
echo.

set "TARGET_DIR=%LOCALAPPDATA%\\xkang-tui"
set "EXE_PATH=%TARGET_DIR%\\xhang.exe"
set "ICO_PATH=%TARGET_DIR%\\icon.ico"
set "SERVER_URL=http://10.197.15.89:8600"
set "DOWNLOAD_URL=%SERVER_URL%/download/latest/xhang.exe"
set "ICO_URL=%SERVER_URL%/download/latest/icon.ico"

if not exist "%TARGET_DIR%" (
    mkdir "%TARGET_DIR%"
)

echo [1/3] 正在从公司统一服务端拉取最新排障程序与官方 Logo 图标...
curl -s -L "%DOWNLOAD_URL%" -o "%EXE_PATH%"
curl -s -L "%ICO_URL%" -o "%ICO_PATH%"
if not exist "%EXE_PATH%" (
    if exist "%~dp0xhang.exe" (\n        echo [提示] 正在从当前安装包释放本地执行程序...
        copy "%~dp0xhang.exe" "%EXE_PATH%" >nul 2>&1
    )
)
if not exist "%ICO_PATH%" (
    if exist "%~dp0assets\\icon.ico" (\n        copy "%~dp0assets\\icon.ico" "%ICO_PATH%" >nul 2>&1
    )
)

echo [2/3] 正在客服桌面创建【🤖 小康TUI-智能排障助手】快捷方式...
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

cscript //nologo "%VBS_SCRIPT%" >nul 2>&1
del "%VBS_SCRIPT%" >nul 2>&1

echo [3/3] 配置系统全局启动路径...
setx PATH "%PATH%;%TARGET_DIR%" >nul 2>&1

echo.
echo ========================================================================
echo  🎉 配置完毕！桌面上已出现带有小康 TUI 图标的【🤖 小康TUI-智能排障助手】图标，双击即可直接使用！
echo ========================================================================
echo.
pause
`;

const localInstallerPath = path.join(ROOT_DIR, 'install_for_customer_service.bat');
fs.writeFileSync(localInstallerPath, installerBatContent, 'utf-8');
console.log(`   ✅ 已生成本地一键部署脚本: ${localInstallerPath}`);

console.log('\n========================================================================');
console.log('🎉 免安装 EXE 与分发程序全部打包就绪！');
console.log('========================================================================\n');
