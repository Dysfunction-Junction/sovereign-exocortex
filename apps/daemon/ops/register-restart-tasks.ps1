<#
.SYNOPSIS
  Registers the scheduled tasks required for Exocortex workstation node service restarts.

.DESCRIPTION
  This script registers four scheduled tasks:
    - ExocortexRestart-daemon
    - ExocortexRestart-proxy
    - ExocortexRestart-piecesos
    - ExocortexRestart-worldmodel

  Each task executes apps/daemon/ops/restart-service.ps1 with Highest privileges and S4U logon,
  creating a controlled privilege boundary so that non-elevated processes (such as the desktop UI
  or daemon loopback API) can invoke `schtasks /run /tn ExocortexRestart-<id>` safely.

.NOTES
  IMPORTANT: This script MUST be run ONCE by the user from an ELEVATED (Administrator) PowerShell session:
    powershell -ExecutionPolicy Bypass -File .\apps\daemon\ops\register-restart-tasks.ps1

  To dry-run without making changes:
    powershell -ExecutionPolicy Bypass -File .\apps\daemon\ops\register-restart-tasks.ps1 -WhatIf
#>

[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = "Stop"

# Administrator check
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $WhatIfPreference) {
  Write-Host "ERROR: Must run from an ELEVATED (Administrator) PowerShell session." -ForegroundColor Red
  exit 1
}

$scriptDir = $PSScriptRoot
$restartScript = [System.IO.Path]::GetFullPath((Join-Path $scriptDir "restart-service.ps1"))
if (-not (Test-Path $restartScript)) {
  Write-Host "ERROR: Could not find restart-service.ps1 at $restartScript" -ForegroundColor Red
  exit 1
}

$services = @("daemon", "proxy", "piecesos", "worldmodel")
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

Write-Host "Registering Exocortex restart scheduled tasks for user '$currentUser'..." -ForegroundColor Cyan

foreach ($svc in $services) {
  $taskName = "ExocortexRestart-$svc"
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$restartScript`" -Service $svc"

  if ($PSCmdlet.ShouldProcess($taskName, "Register scheduled task")) {
    try {
      # Unregister any existing task with the same name first
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

      $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
      $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType S4U -RunLevel Highest
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

      Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Description "Exocortex privilege boundary task for restarting $svc service" | Out-Null
      Write-Host "  [OK] Registered $taskName" -ForegroundColor Green
    } catch {
      Write-Host "  [FAILED] Failed to register ${taskName}: $_" -ForegroundColor Red
      throw $_
    }
  }
}

Write-Host "`nAll restart tasks registered successfully." -ForegroundColor Green
Write-Host "Non-elevated processes can now invoke restarts via: schtasks /run /tn ExocortexRestart-<service>"
