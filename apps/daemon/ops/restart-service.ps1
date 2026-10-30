<#
.SYNOPSIS
  Restarts a single workstation service (daemon, proxy, piecesos, or worldmodel).

.DESCRIPTION
  This script implements service-level restarts for the Sovereign Exocortex Workstation Node.
  Each service has an isolated restart workflow logging to apps/daemon/logs/restart-<service>.log.

.PARAMETER Service
  The service to restart: daemon, proxy, piecesos, or worldmodel.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\restart-service.ps1 -Service daemon -WhatIf
  powershell -ExecutionPolicy Bypass -File .\restart-service.ps1 -Service proxy
#>

[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("daemon", "proxy", "piecesos", "worldmodel")]
  [string]$Service
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$logDir = [System.IO.Path]::GetFullPath((Join-Path $scriptDir "..\logs"))
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$logFile = Join-Path $logDir "restart-$Service.log"

function Write-Log {
  param([string]$Message, [string]$Level = "INFO")
  $timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffK")
  $entry = "[$timestamp] [$Level] $Message"
  Write-Host $entry
  Add-Content -Path $logFile -Value $entry -ErrorAction SilentlyContinue
}

function Show-FailureAndExit {
  param([string]$Reason)
  Write-Log "Restart failed: $Reason" -Level "ERROR"
  Write-Host "`n--- Last 20 lines of $logFile ---" -ForegroundColor Red
  if (Test-Path $logFile) {
    Get-Content $logFile -Tail 20 | ForEach-Object { Write-Host $_ -ForegroundColor Red }
  }
  exit 1
}

# Check Admin privileges unless running with -WhatIf
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $WhatIfPreference) {
  Show-FailureAndExit "Must run from an elevated (Administrator) PowerShell session."
}

Write-Log "Starting restart sequence for service: $Service"

try {
  switch ($Service) {
    "daemon" {
      # Follow restart-exocortex.ps1: stop scheduled task, kill port 8788 listener and supervisor, wait, restart
      if ($PSCmdlet.ShouldProcess("ExocortexDaemon", "Stop scheduled task")) {
        Write-Log "Stopping scheduled task ExocortexDaemon..."
        Stop-ScheduledTask -TaskName ExocortexDaemon -ErrorAction SilentlyContinue
      }

      if ($PSCmdlet.ShouldProcess("port 8788 and mishmash supervisors", "Kill processes")) {
        Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
          $pidToKill = [int]$_.OwningProcess
          if ($pidToKill -gt 0 -and $pidToKill -ne $PID) {
            Write-Log "Killing process $pidToKill listening on 8788"
            taskkill /F /T /PID $pidToKill 2>$null | Out-Null
          }
        }
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -match 'mishmash-up\.ts' } | ForEach-Object {
            Write-Log "Killing supervisor process $($_.ProcessId)"
            taskkill /F /T /PID $_.ProcessId 2>$null | Out-Null
          }
      }

      if ($PSCmdlet.ShouldProcess("port 8788", "Wait for port release")) {
        $waited = 0
        while ((Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue) -and ($waited -lt 10)) {
          Start-Sleep -Seconds 1
          $waited++
        }
        if (Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue) {
          Show-FailureAndExit "Port 8788 did not release after 10s."
        }
      }

      if ($PSCmdlet.ShouldProcess("ExocortexDaemon", "Start scheduled task")) {
        Write-Log "Starting scheduled task ExocortexDaemon..."
        Start-ScheduledTask -TaskName ExocortexDaemon
      }

      if ($PSCmdlet.ShouldProcess("http://127.0.0.1:8788/mobile/health", "Poll health up to 60s")) {
        Write-Log "Polling daemon health on 8788..."
        $healthy = $false
        for ($i = 0; $i -lt 60; $i++) {
          Start-Sleep -Seconds 1
          try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8788/mobile/health" -TimeoutSec 2 -ErrorAction Stop
            if ($resp.ok -eq $true) {
              $healthy = $true
              break
            }
          } catch {
            # Expected while daemon is booting
          }
        }
        if (-not $healthy) {
          Show-FailureAndExit "Daemon did not become healthy within 60s."
        }
        Write-Log "Daemon is healthy on :8788."
      }
    }

    "proxy" {
      if ($PSCmdlet.ShouldProcess("PiecesAndroidProxy", "Stop scheduled task")) {
        Write-Log "Stopping scheduled task PiecesAndroidProxy..."
        Stop-ScheduledTask -TaskName PiecesAndroidProxy -ErrorAction SilentlyContinue
      }

      if ($PSCmdlet.ShouldProcess("port 8787", "Kill remaining listeners")) {
        Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
          $pidToKill = [int]$_.OwningProcess
          if ($pidToKill -gt 0 -and $pidToKill -ne $PID) {
            Write-Log "Killing lingering proxy process $pidToKill on 8787"
            taskkill /F /T /PID $pidToKill 2>$null | Out-Null
          }
        }
      }

      if ($PSCmdlet.ShouldProcess("port 8787", "Wait for port release")) {
        $waited = 0
        while ((Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) -and ($waited -lt 10)) {
          Start-Sleep -Seconds 1
          $waited++
        }
      }

      if ($PSCmdlet.ShouldProcess("PiecesAndroidProxy", "Start scheduled task")) {
        Write-Log "Starting scheduled task PiecesAndroidProxy..."
        Start-ScheduledTask -TaskName PiecesAndroidProxy
      }

      if ($PSCmdlet.ShouldProcess("http://127.0.0.1:8787/mobile/health", "Poll health up to 30s")) {
        Write-Log "Polling proxy health on 8787..."
        $healthy = $false
        for ($i = 0; $i -lt 30; $i++) {
          Start-Sleep -Seconds 1
          try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8787/mobile/health" -TimeoutSec 2 -ErrorAction Stop
            if ($resp.ok -eq $true) {
              $healthy = $true
              break
            }
          } catch {
            # Booting
          }
        }
        if (-not $healthy) {
          Show-FailureAndExit "Proxy did not become healthy within 30s."
        }
        Write-Log "Proxy is healthy on :8787."
      }
    }

    "piecesos" {
      if ($PSCmdlet.ShouldProcess("os_server", "Gracefully stop process")) {
        Write-Log "Stopping PiecesOS os_server gracefully..."
        $procs = Get-Process -Name "os_server" -ErrorAction SilentlyContinue
        if ($procs) {
          $procs | Stop-Process -ErrorAction SilentlyContinue
          $waited = 0
          while ((Get-Process -Name "os_server" -ErrorAction SilentlyContinue) -and ($waited -lt 10)) {
            Start-Sleep -Seconds 1
            $waited++
          }
          # Force only if graceful stop did not exit after 10s
          Get-Process -Name "os_server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        }
      }

      if ($PSCmdlet.ShouldProcess("PiecesOSInteractiveLauncher", "Start scheduled task")) {
        Write-Log "Starting scheduled task PiecesOSInteractiveLauncher..."
        Start-ScheduledTask -TaskName PiecesOSInteractiveLauncher
      }

      if ($PSCmdlet.ShouldProcess("http://127.0.0.1:39300/.well-known/health", "Poll health up to 120s")) {
        Write-Log "Polling PiecesOS health on 39300 (up to 120s)..."
        $healthy = $false
        for ($i = 0; $i -lt 120; $i++) {
          Start-Sleep -Seconds 1
          try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:39300/.well-known/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) {
              $healthy = $true
              break
            }
          } catch {
            # Booting
          }
        }
        if (-not $healthy) {
          Show-FailureAndExit "PiecesOS did not become healthy within 120s."
        }
        Write-Log "PiecesOS is healthy on :39300."
      }
    }

    "worldmodel" {
      Write-Log "World Model Store restart is managed in-process by the Exocortex daemon."
    }
  }

  Write-Log "Restart sequence completed successfully for service: $Service"
  exit 0
} catch {
  Show-FailureAndExit $_.Exception.Message
}
