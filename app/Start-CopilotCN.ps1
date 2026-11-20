# GitHub Copilot 简体中文启动器
# 双击运行：先退出正在运行的 Copilot，再带调试端口启动官方程序并注入中文界面。
param([switch]$Dump)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log  = Join-Path $here 'reports\launcher.log'
New-Item -ItemType Directory -Force -Path (Join-Path $here 'reports') | Out-Null

function Write-Log($msg) {
    $ts = Get-Date -Format 'HH:mm:ss'
    try { Add-Content -Path $log -Value "[$ts] $msg" -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
}

function Fail($msg) {
    Write-Host $msg -ForegroundColor Red
    Write-Log $msg
    Start-Sleep -Seconds 6
    exit 1
}

# node 解析（优先 PATH，其次常见安装位置）
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if (Test-Path $p) { $node = $p; break }
    }
}
if (-not $node) { Fail '没有找到 node.exe，请先安装 Node.js 22 或更高版本：https://nodejs.org' }

# 官方程序路径：环境变量 > 注册表卸载项 > 常见安装位置
$exe = $env:COPILOT_EXE
if ($exe -and -not (Test-Path $exe)) { $exe = $null }
if (-not $exe) {
    $roots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($r in $roots) {
        $item = Get-ItemProperty $r -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -like '*GitHub Copilot*' -and $_.InstallLocation } |
                Select-Object -First 1
        if ($item) {
            # 注册表里的 InstallLocation 有时带引号，先洗掉
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
if (-not $exe) {
    foreach ($p in @('D:\GitHub Copilot\github.exe', "$env:LOCALAPPDATA\Programs\GitHub Copilot\github.exe")) {
        if (Test-Path $p) { $exe = $p; break }
    }
}
if (-not $exe) { Fail '找不到 GitHub Copilot。请把安装目录下的 github.exe 路径设进环境变量 COPILOT_EXE 后重试。' }

# 已有实例会占用用户数据目录且不带调试端口，必须先退出
$procs = Get-Process github -ErrorAction SilentlyContinue
if ($procs) {
    Write-Log '退出正在运行的 Copilot'
    $procs | Stop-Process -Force
    Start-Sleep -Seconds 3
}

$env:COPILOT_EXE = $exe
$args = @((Join-Path $here 'launcher.mjs'))
if ($Dump) { $args += '--dump' }

Write-Log "启动汉化启动器：$exe"
Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $here -WindowStyle Hidden