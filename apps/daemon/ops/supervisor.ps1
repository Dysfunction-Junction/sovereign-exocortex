<#
.SYNOPSIS
  PowerShell wrapper for the Sovereign Exocortex 9-service mesh supervisor.

.DESCRIPTION
  Launches the TypeScript supervisor via tsx to manage the 9-service local mesh:
  hermes-api, autonomous-triad, pieces-for-all, agent-mesh-mcp, pattern-analyzer,
  registry-app, gut-instinct, tool-registry-heartbeat, and sovereign-exocortex daemon.

.EXAMPLE
  .\ops\supervisor.ps1 status
  .\ops\supervisor.ps1 start
  .\ops\supervisor.ps1 stop
  .\ops\supervisor.ps1 restart daemon
#>
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$SupervisorArgs
)

$ErrorActionPreference = "Stop"
$daemonDir = Split-Path -Parent $PSScriptRoot
Set-Location $daemonDir

if (-not $SupervisorArgs -or $SupervisorArgs.Count -eq 0) {
  $SupervisorArgs = @("status")
}

npx tsx ops/supervisor.ts @SupervisorArgs
