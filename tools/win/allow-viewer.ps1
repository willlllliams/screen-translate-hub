<#
.SYNOPSIS
  Allow phones on the local network to reach the LAN viewer (run once, as administrator).

.DESCRIPTION
  Adds an inbound Windows Firewall rule for the viewer's TCP port on private networks
  only, instead of allowing node.exe as a whole. Remove it with -Remove.

.EXAMPLE
  ./tools/win/allow-viewer.ps1            # port 8848
  ./tools/win/allow-viewer.ps1 -Port 9000
  ./tools/win/allow-viewer.ps1 -Remove
#>
param(
  [int]$Port = 8848,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$name = 'screen-translate-hub LAN viewer'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this from an administrator PowerShell.' }
Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) { "removed '$name'"; return }
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
"allowed TCP $Port on private networks ('$name')"
$public = Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Public'
if ($public) { "note: these networks are marked Public, where the rule does not apply: $($public.Name -join ', ') (Settings > Network > Properties > Private)" }
