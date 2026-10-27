# Runs every 2 minutes (MeshSupervisorWatchdog scheduled task).
# Keeps local llama.cpp inference healthy, then polls the 9-service local mesh
# via `supervisor.ts status` and restarts anything reported DOWN via
# `supervisor.ts restart <id>`. Mirrors the
# pattern in pieces-android-shizuku-fix/apps/proxy/scripts/health-watchdog.ps1
# (probe twice before acting, log every decision, never touch healthy nodes).

$ErrorActionPreference = 'Continue'

$DaemonDir = Split-Path -Parent $PSScriptRoot
$LogFile   = Join-Path $env:LOCALAPPDATA 'mesh-supervisor-watchdog.log'
$NodeExe   = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $NodeExe)) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) { $NodeExe = $nodeCmd.Source }
}
$TsxCli    = Join-Path $DaemonDir 'node_modules\tsx\dist\cli.mjs'
$Supervisor = Join-Path $DaemonDir 'ops\supervisor.ts'

if (-not (Test-Path $TsxCli)) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $DaemonDir)
    $TsxCli = Join-Path $RepoRoot 'node_modules\tsx\dist\cli.mjs'
}

function Log($msg) {
    try { "$(Get-Date -Format o)  $msg" | Out-File -FilePath $LogFile -Append -Encoding utf8 } catch {}
}

# Rotate log file if > 1MB
if (Test-Path $LogFile) {
    try {
        if ((Get-Item $LogFile).Length -gt 1MB) {
            Move-Item -Path $LogFile -Destination "$LogFile.old" -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

function Invoke-Supervisor([string[]]$SupervisorArgs, [int]$TimeoutSec = 60) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NodeExe
    $psi.Arguments = "`"$TsxCli`" `"$Supervisor`" " + (($SupervisorArgs | ForEach-Object { "`"$_`"" }) -join ' ')
    $psi.WorkingDirectory = $DaemonDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true

    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
    } catch {
        return [PSCustomObject]@{ ExitCode = -2; StdOut = ''; StdErr = "start failed: $_" }
    }

    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()

    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        & taskkill.exe /PID $proc.Id /T /F | Out-Null
        return [PSCustomObject]@{ ExitCode = -1; StdOut = ''; StdErr = "timeout after ${TimeoutSec}s" }
    }

    [void][System.Threading.Tasks.Task]::WaitAll(@($outTask, $errTask), 5000)
    [PSCustomObject]@{
        ExitCode = $proc.ExitCode
        StdOut   = if ($outTask.IsCompleted) { $outTask.Result } else { '' }
        StdErr   = if ($errTask.IsCompleted) { $errTask.Result } else { '' }
    }
}

foreach ($p in @($NodeExe, $TsxCli, $Supervisor)) {
    if (-not (Test-Path $p)) { Log "FATAL: missing $p"; exit 1 }
}

. (Join-Path $PSScriptRoot 'ensure-llama-server.ps1')
if (-not (Ensure-LlamaServer)) { Log "llama-server ensure failed; will retry on next watchdog pass" }

$mutex = New-Object System.Threading.Mutex($false, 'Global\MeshSupervisorOps')
if (-not $mutex.WaitOne(0)) {
    Log "another supervisor operation in progress; skipping"
    exit 0
}

try {
    $result = Invoke-Supervisor @('status') -TimeoutSec 30
    if ($result.ExitCode -ne 0) {
        Log "status check failed (exit $($result.ExitCode)): $($result.StdErr)"
        exit 1
    }

    # Parse status table: "| <id> | <port> | (UP|DOWN) | ... |"
    $rows = 0
    $downIds = @()
    foreach ($line in ($result.StdOut -split "\r?\n")) {
        if ($line -match '^\|\s*([A-Za-z0-9_.-]+)\s*\|\s*\d+\s*\|\s*(UP|DOWN)\b') {
            $rows++
            if ($Matches[2] -eq 'DOWN') {
                $downIds += $Matches[1]
            }
        }
    }

    if ($rows -lt 9) {
        Log "WARNING: status output parsed only $rows rows (expected 9). Raw output:`n$($result.StdOut)"
    }

    if ($downIds.Count -eq 0) {
        exit 0
    }

    Log "detected DOWN: $($downIds -join ', ') -- confirming before restart"

    # Brief delay to guard against transient port checks
    Start-Sleep -Seconds 5
    $confirm = Invoke-Supervisor @('status') -TimeoutSec 30
    $stillDown = @()
    foreach ($line in ($confirm.StdOut -split "\r?\n")) {
        if ($line -match '^\|\s*([A-Za-z0-9_.-]+)\s*\|\s*\d+\s*\|\s*DOWN\b') {
            if ($downIds -contains $Matches[1]) {
                $stillDown += $Matches[1]
            }
        }
    }

    $failedCount = 0
    foreach ($id in $stillDown) {
        Log "restarting $id"
        $r = Invoke-Supervisor @('restart', $id) -TimeoutSec 45
        if ($r.ExitCode -eq 0) {
            Log "restart of $id succeeded"
        } else {
            Log "restart of $id FAILED (exit $($r.ExitCode)): $($r.StdErr)"
            $failedCount++
        }
    }

    if ($failedCount -gt 0) {
        exit 1
    }

    exit 0
} finally {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
