<#
.SYNOPSIS
  Bring a process's main window to the front and move it to a fixed rectangle (run inside the desktop session).
.EXAMPLE
  ./tools/win/run-in-desktop.ps1 -Command 'powershell -File tools\win\place-window.ps1 -Process notepad -X 100 -Y 60 -W 900 -H 560'
#>
param([string]$Process = 'notepad', [int]$X = 100, [int]$Y = 60, [int]$W = 900, [int]$H = 560)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
$p = Get-Process $Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "no window for $Process"; exit 1 }
$h = $p.MainWindowHandle
[Win]::ShowWindow($h, 9) | Out-Null                               # SW_RESTORE
[Win]::SetWindowPos($h, [IntPtr](-1), $X, $Y, $W, $H, 0x40) | Out-Null # HWND_TOPMOST, SWP_SHOWWINDOW
[Win]::SetWindowPos($h, [IntPtr](-2), $X, $Y, $W, $H, 0x40) | Out-Null # HWND_NOTOPMOST keeps it in front
[Win]::SetForegroundWindow($h) | Out-Null
Write-Output "placed $Process window $h at $X,$Y ${W}x$H"
