# 生产启动：xkang 服务端（8600）与飞书通道。
# 用法：pwsh scripts/start_production.ps1 [-ServerOnly] [-ChannelOnly] [-Force]
#
# 三条固定约定，改前先读注释：
#   1. 服务端必须以 server/ 为工作目录启动。主库按 cwd 解析，从仓库根启动会连到
#      <repo>/data/xkang.db —— 那是另一份库（模型是 deepseek、没有线上会话）。
#   2. REVIEW_MODE=off 是 2026-10-29 撤掉内容复核后的生产约定，放在这里而不是
#      server/.env：测试进程也读 .env，写进去会让服务级测试按线上模式跑。
#   3. 不开推理（DEEPSEEK_REASONING_EFFORT=max）时，线上只查两分多钟就把已查实的
#      原因写成“尚未定位”；上下文阈值同对照实验一致用 1048576。
param([switch]$ServerOnly, [switch]$ChannelOnly, [switch]$Force)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$serverDir = Join-Path $root 'server'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force -Path logs-archive | Out-Null

# 重启前检查飞书上是否有正在进行的排查：某个编号最后一次“开始排查”晚于它最后一次
# 结束回复（final/failed）就说明还在跑。2026-10-30 曾只看了“上一轮已回复”就重启，
# 打断了同事刚发起的“继续”。
function Get-InFlightIssues {
  if (-not (Test-Path feishu-channel.log)) { return @() }
  $since = (Get-Date).ToUniversalTime().AddMinutes(-90)
  $last = @{}
  foreach ($line in (Get-Content feishu-channel.log -Encoding UTF8 -Tail 3000)) {
    $m = [regex]::Match($line, '^\[(?<t>[^\]]+)\] (?:(?<start>开始排查) (?<id>[0-9a-f]{8})|已回复 (?<id2>[0-9a-f]{8})（(?<kind>final|failed)）)')
    if (-not $m.Success) { continue }
    $t = [datetime]::Parse($m.Groups['t'].Value).ToUniversalTime()
    if ($m.Groups['start'].Success) { $last[$m.Groups['id'].Value] = @{ t = $t; running = $true } }
    else { $last[$m.Groups['id2'].Value] = @{ t = $t; running = $false } }
  }
  return @($last.GetEnumerator() | Where-Object { $_.Value.running -and $_.Value.t -gt $since } | ForEach-Object { $_.Key + '（' + $_.Value.t.ToLocalTime().ToString('HH:mm:ss') + ' 开始）' })
}
$busy = Get-InFlightIssues
if ($busy.Count -gt 0 -and -not $Force) {
  Write-Output ('有正在进行的排查，未重启：' + ($busy -join '、') + '。等它们回复结束后再重启，或确认可以打断后加 -Force。')
  exit 2
}

$env:NODE_TLS_REJECT_UNAUTHORIZED = '0'
$env:REVIEW_MODE = 'off'
$env:DEEPSEEK_REASONING_EFFORT = 'max'
$env:CONTEXT_TOKENS = '1048576'
# ANSWER_GUIDE 对照无改进（成因正确度 0.58→0.50），保持关闭，不设置。

function Archive([string[]]$files) {
  foreach ($f in $files) { if (Test-Path $f) { Copy-Item $f (Join-Path 'logs-archive' ($stamp + '-' + $f)) } }
}

if (-not $ChannelOnly) {
  Archive @('server-feishu.log', 'server-feishu.err.log')
  $p = (Get-NetTCPConnection -State Listen -LocalPort 8600 -ErrorAction SilentlyContinue).OwningProcess
  if ($p) { Stop-Process -Id $p -Force; Start-Sleep -Seconds 3 }
  Start-Process -FilePath node -ArgumentList '--import','tsx','src/index.ts' -WorkingDirectory $serverDir -RedirectStandardOutput (Join-Path $root 'server-feishu.log') -RedirectStandardError (Join-Path $root 'server-feishu.err.log') -WindowStyle Hidden
  Start-Sleep -Seconds 20
  $banner = Select-String -Path (Join-Path $root 'server-feishu.log') -Pattern 'REVIEW_MODE' | Select-Object -Last 1
  if (-not $banner) { throw '启动自检失败：日志里没有 REVIEW_MODE，服务端可能没起来。' }
  $banner.Line.Trim()
  if ($banner.Line -notmatch 'REVIEW_MODE: off') { throw ('启动自检失败：复核模式不是 off → ' + $banner.Line.Trim()) }
  $modelLine = Select-String -Path (Join-Path $root 'server-feishu.log') -Pattern '当前活跃模型' | Select-Object -Last 1
  $dbModel = (& node (Join-Path $root 'scripts/read_active_model.mjs') (Join-Path $serverDir 'data/xkang.db')).Trim()
  if (-not $dbModel) { throw '启动自检失败：读不到主库 active_model，可能库路径不对。' }
  if ($modelLine -and $modelLine.Line -notmatch [regex]::Escape($dbModel)) {
    throw ('服务端连到了错误的库：' + $modelLine.Line.Trim() + '（主库期望 ' + $dbModel + '）。请确认工作目录是 server/。')
  }
  Write-Output ('启动自检通过：复核模式 off，模型 ' + $dbModel)
}
if (-not $ServerOnly) {
  Archive @('feishu-channel.log', 'feishu-channel.err.log')
  Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'server/src/feishu/main.ts' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 3
  $env:XKANG_BASE_URL = 'http://127.0.0.1:8600'
  Start-Process -FilePath node -ArgumentList '--import','tsx','server/src/feishu/main.ts' -WorkingDirectory $root -RedirectStandardOutput (Join-Path $root 'feishu-channel.log') -RedirectStandardError (Join-Path $root 'feishu-channel.err.log') -WindowStyle Hidden
  Start-Sleep -Seconds 15
  Get-Content (Join-Path $root 'feishu-channel.log') -Encoding UTF8 -Tail 1
}