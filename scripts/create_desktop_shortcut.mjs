import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const home = os.homedir();
const desktop = path.join(home, 'Desktop');
const targetDir = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'xkang-tui');
const exePath = path.join(targetDir, 'xhang.exe');
const icoPath = path.join(targetDir, 'icon.ico');

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(path.resolve('xhang.exe'), exePath);
fs.copyFileSync(path.resolve('assets/icon.ico'), icoPath);

// Create shortcut using powershell with raw unicode path
const psScript = `
$wsh = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop '小康TUI-智能排障助手.lnk'
$s = $wsh.CreateShortcut($lnk)
$s.TargetPath = '${exePath}'
$s.WorkingDirectory = '${home}'
$s.IconLocation = '${icoPath},0'
$s.Description = '小康TUI客服智能排障终端'
$s.Save()
`;

const psPath = path.join(os.tmpdir(), 'create_skt_lnk.ps1');
// Write with UTF-8 BOM so PowerShell parses Chinese properly
const BOM = '\uFEFF';
fs.writeFileSync(psPath, BOM + psScript, 'utf-8');
execSync(`powershell.exe -ExecutionPolicy Bypass -File "${psPath}"`);
try { fs.unlinkSync(psPath); } catch {}

console.log('🎉 桌面中文快捷方式已成功生成！');
console.log('   位置: ' + path.join(desktop, '小康TUI-智能排障助手.lnk'));
console.log('   绑定透明图标:', icoPath);
