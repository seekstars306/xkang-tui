@echo off
chcp 65001 >nul
title 小康 TUI 智能排障助手 - 极简一键安装程序

echo ========================================================================
echo        🤖 正在为客服电脑一键配置【小康 TUI 智能排障助手】...
echo ========================================================================
echo.

set "TARGET_DIR=%LOCALAPPDATA%\xkang-tui"
set "EXE_PATH=%TARGET_DIR%\xhang.exe"
set "ICO_PATH=%TARGET_DIR%\icon.ico"
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
    if exist "%~dp0xhang.exe" (
        echo [提示] 正在从当前安装包释放本地执行程序...
        copy "%~dp0xhang.exe" "%EXE_PATH%" >nul 2>&1
    )
)
if not exist "%ICO_PATH%" (
    if exist "%~dp0assets\icon.ico" (
        copy "%~dp0assets\icon.ico" "%ICO_PATH%" >nul 2>&1
    )
)

echo [2/3] 正在客服桌面创建【🤖 小康TUI-智能排障助手】快捷方式...
set "VBS_SCRIPT=%TEMP%\create_skt_shortcut.vbs"
(
echo Set oWS = WScript.CreateObject^("WScript.Shell"^)
echo sLinkFile = oWS.SpecialFolders^("Desktop"^) ^& "\🤖 小康TUI-智能排障助手.lnk"
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
