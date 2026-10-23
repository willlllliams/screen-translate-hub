<#
.SYNOPSIS
  Build, start, stop or restart the desktop app in the interactive desktop session (for SSH development).

.EXAMPLE
  ./tools/win/desktop.ps1 restart            # rebuild and start with the dev control port
  ./tools/win/desktop.ps1 restart -Capturable # overlays not excluded from capture (debug screenshots)
  ./tools/win/desktop.ps1 stop
#>
param(
  [ValidateSet('start', 'stop', 'restart', 'build')][string]$Action = 'restart',
  [switch]$Capturable
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$node = 'C:\Program Files\nodejs\node.exe'

function Stop-App {
  foreach ($p in @(Get-Process electron -ErrorAction SilentlyContinue)) {
    try { & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null } catch { }
  }
  Unregister-ScheduledTask -TaskName 'sth-desktop' -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $env:APPDATA 'screen-translate-hub\dev-control.json') -ErrorAction SilentlyContinue
  # a new instance started before the old one is gone loses the single-instance lock and quits
  for ($i = 0; $i -lt 40 -and @(Get-Process electron -ErrorAction SilentlyContinue).Count -gt 0; $i++) { Start-Sleep -Milliseconds 250 }
}

function Build-App {
  & $node (Join-Path $root 'apps\desktop\build.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
}

function Start-App {
  $flags = '--dev-control'
  if ($Capturable) { $flags += ' --debug-capturable' }
  if ($env:STH_FLAGS) { $flags += " $env:STH_FLAGS" }
  & (Join-Path $PSScriptRoot 'run-in-desktop.ps1') -Command "node_modules\electron\dist\electron.exe apps\desktop $flags" -WorkDir $root -NoWait -TaskName 'sth-desktop'
  $cfg = Join-Path $env:APPDATA 'screen-translate-hub\dev-control.json'
  for ($i = 0; $i -lt 60 -and -not (Test-Path $cfg); $i++) { Start-Sleep -Milliseconds 500 }
  if (Test-Path $cfg) { "dev control: $(Get-Content $cfg)" } else { 'dev control did not start; see the run log' }
}

switch ($Action) {
  'stop' { Stop-App }
  'build' { Build-App }
  'start' { Start-App }
  'restart' { Stop-App; Build-App; Start-App }
}
