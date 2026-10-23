<#
.SYNOPSIS
  Run a command inside the logged-in interactive desktop session.

.DESCRIPTION
  Processes started from an SSH session live in session 0 and cannot see or
  draw on the user's desktop. This script registers a one-shot scheduled task
  with an Interactive logon principal, which Windows starts in the active
  console session, then waits for it and prints its captured output.

.EXAMPLE
  ./tools/win/run-in-desktop.ps1 -Command 'python spike.py' -WorkDir C:\repo -TimeoutSec 60
  ./tools/win/run-in-desktop.ps1 -Command 'npm run desktop' -NoWait
#>
param(
  [Parameter(Mandatory = $true)][string]$Command,
  [string]$WorkDir = (Get-Location).Path,
  [int]$TimeoutSec = 120,
  [switch]$NoWait,
  [string]$TaskName = 'sth-desktop-run'
)
$ErrorActionPreference = 'Stop'

$user = (Get-CimInstance Win32_ComputerSystem).UserName
if (-not $user) { throw 'No interactive user is logged in on the console.' }

$logDir = Join-Path $env:TEMP 'sth-desktop-run'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$log = Join-Path $logDir "$TaskName-$stamp.log"
$done = "$log.done"

# cmd.exe wrapper: run in WorkDir, capture stdout+stderr, then write the exit code marker.
$inner = "cd /d `"$WorkDir`" && ($Command) > `"$log`" 2>&1 & echo %ERRORLEVEL% > `"$done`""
# conhost --headless keeps the console window off the desktop (and out of screenshots).
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless cmd.exe /c $inner"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 72)
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

if ($NoWait) {
  Write-Output "started in desktop session; log: $log"
  return
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while (-not (Test-Path $done) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
if (Test-Path $log) { Get-Content $log -Encoding UTF8 }
if (Test-Path $done) {
  $code = (Get-Content $done | Select-Object -First 1).Trim()
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "[exit $code]"
} else {
  Write-Output "[timeout after $TimeoutSec s; task '$TaskName' left running, log: $log]"
}
