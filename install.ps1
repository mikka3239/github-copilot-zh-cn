# 安装：检查环境 + 建桌面快捷方式
# powershell -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cmd  = Join-Path $root 'app\启动汉化Copilot.cmd'
if (-not (Test-Path $cmd)) { Write-Host "缺少 app\启动汉化Copilot.cmd，请确认仓库完整。" -ForegroundColor Red; exit 1 }

# Node.js 22+
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-Host "未检测到 Node.js。请先安装 22 或更高版本：https://nodejs.org" -ForegroundColor Red
    exit 1
}
$ver = (& $node --version) -replace 'v', ''
if ([int]($ver.Split('.')[0]) -lt 22) {
    Write-Host "当前 Node.js 版本 $ver，需要 22 或更高。" -ForegroundColor Yellow
}

# 找 github.exe（用于快捷方式图标）
$exe = $env:COPILOT_EXE
if (-not ($exe -and (Test-Path $exe))) {
    $exe = $null
    foreach ($r in @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )) {
        $item = Get-ItemProperty $r -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -like '*GitHub Copilot*' -and $_.InstallLocation } |
                Select-Object -First 1
        if ($item) {
            $loc = ([string]$item.InstallLocation).Trim().Trim('"').Trim()
            if ($loc) {
                try {
                    $cand = Join-Path $loc 'github.exe'
                    if (Test-Path $cand) { $exe = $cand; break }
                } catch { }
            }
        }
    }
}
if ($exe) { Write-Host "已找到 Copilot：$exe" -ForegroundColor Green }
else { Write-Host "未找到 Copilot，启动时请设置环境变量 COPILOT_EXE。" -ForegroundColor Yellow }

# 桌面快捷方式
$icon = if ($exe) { Join-Path (Split-Path $exe) 'icons\icon.ico' } else { '' }
if ($icon -and -not (Test-Path $icon)) { $icon = $exe }

$lnkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'GitHub Copilot 中文版.lnk'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = $cmd
$lnk.WorkingDirectory = Join-Path $root 'app'
if ($icon) { $lnk.IconLocation = $icon }
$lnk.WindowStyle = 7
$lnk.Description = 'GitHub Copilot 简体中文（运行时注入）'
$lnk.Save()

Write-Host "已创建快捷方式：$lnkPath" -ForegroundColor Green
Write-Host "双击它即可启动中文版；想恢复英文，直接用官方图标启动。"
