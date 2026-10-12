<#
  Restart the Exocortex gateway (and the memory node, or any other mishmash node) so new code or new
  settings in secrets\device-test.env actually take effect.

  Run from an ADMINISTRATOR PowerShell (the processes were started by the S4U scheduled task, so a normal
  shell gets "Access is denied"):

      powershell -ExecutionPolicy Bypass -File .\ops\restart-exocortex.ps1
      powershell -ExecutionPolicy Bypass -File .\ops\restart-exocortex.ps1 -Ports 8788,8789,39400,39401

  Why it is not just Stop/Start-ScheduledTask: stopping the task does not stop its children, and the
  restarted supervisor reports "up" as soon as the OLD nodes still holding the ports answer a ping,
  so a plain restart silently keeps the old code and the old environment.

  By default it replaces the gateway (8788) and the memory node (39400). It never touches the Pieces proxy
  (8787), Ollama (11434) or the databank (on Lubuntu).
#>
param(
  [int[]]$Ports = @(8788, 39400)
)

$ErrorActionPreference = "Continue"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Run this from an ADMINISTRATOR PowerShell." -ForegroundColor Red
  exit 1
}

Write-Host "Stopping the scheduled task..."
Stop-ScheduledTask -TaskName ExocortexDaemon -ErrorAction SilentlyContinue

$targets = @{}
foreach ($port in $Ports) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $targets[[int]$_.OwningProcess] = "listening on :$port"
  }
}
# Old supervisors (the node process running mishmash-up) that would otherwise pile up.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'mishmash-up\.ts' } | ForEach-Object {
  $targets[[int]$_.ProcessId] = "mishmash supervisor"
}
$targets.Remove([int]$PID) | Out-Null

if ($targets.Count -eq 0) { Write-Host "No old processes found." }
foreach ($id in $targets.Keys) {
  Write-Host ("Stopping PID {0} ({1})" -f $id, $targets[$id])
  taskkill /F /T /PID $id | Out-Null
}

Start-Sleep -Seconds 3
foreach ($port in $Ports) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Port $port is still in use; something else is holding it." -ForegroundColor Yellow
  }
}

Write-Host "Starting the scheduled task (the gateway starts about 25 s after the nodes)..."
Start-ScheduledTask -TaskName ExocortexDaemon
Start-Sleep -Seconds 50

foreach ($port in $Ports) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) {
    $started = (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).StartTime
    Write-Host ("OK   :{0} -> PID {1}, started {2}" -f $port, $c.OwningProcess, $started) -ForegroundColor Green
  } else {
    Write-Host "WAIT :$port is not listening yet (give it another 30 s)" -ForegroundColor Yellow
  }
}
