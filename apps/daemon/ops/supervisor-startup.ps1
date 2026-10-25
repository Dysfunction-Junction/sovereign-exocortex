# Hidden-window startup launcher for the mesh process supervisor.
# Invoked by the MeshSupervisorStartup scheduled task at logon/boot.
#
# Runs `supervisor.ts start` once to bring up any of the 9 mesh services
# that aren't already listening, then exits (the supervisor itself is not
# a long-running watchdog in this pass -- see supervisor-core.ts header).

$ErrorActionPreference = 'Continue'

$DaemonDir = Split-Path -Parent $PSScriptRoot
$LogFile   = Join-Path $env:LOCALAPPDATA 'mesh-supervisor-startup.log'
$NodeExe   = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $NodeExe)) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) { $NodeExe = $nodeCmd.Source }
}
$TsxCli    = Join-Path $DaemonDir 'node_modules\tsx\dist\cli.mjs'
$Supervisor = Join-Path $DaemonDir 'ops\supervisor.ts'

# tsx deps may be hoisted to the monorepo root instead of apps/daemon/node_modules.
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

Log "=== supervisor-startup starting (pid $PID) ==="

foreach ($p in @($NodeExe, $TsxCli, $Supervisor)) {
    if (-not (Test-Path $p)) { Log "FATAL: missing $p"; exit 1 }
}

$mutex = New-Object System.Threading.Mutex($false, 'Global\MeshSupervisorOps')
if (-not $mutex.WaitOne(0)) {
    Log "another supervisor operation in progress; skipping"
    exit 0
}

try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NodeExe
    $psi.Arguments = "`"$TsxCli`" `"$Supervisor`" start"
    $psi.WorkingDirectory = $DaemonDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true

    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
    } catch {
        Log "FATAL: process launch failed: $_"
        exit 1
    }

    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()

    # Allow up to 90 seconds for mesh startup sweep
    if (-not $proc.WaitForExit(90000)) {
        & taskkill.exe /PID $proc.Id /T /F | Out-Null
        Log "FATAL: supervisor start timed out after 90s"
        exit 1
    }

    [void][System.Threading.Tasks.Task]::WaitAll(@($outTask, $errTask), 5000)
    $stdout = if ($outTask.IsCompleted) { $outTask.Result } else { '' }
    $stderr = if ($errTask.IsCompleted) { $errTask.Result } else { '' }

    if ($stdout) { $stdout | Out-File -FilePath $LogFile -Append -Encoding utf8 }
    if ($stderr) { $stderr | Out-File -FilePath $LogFile -Append -Encoding utf8 }

    Log "=== supervisor start exited with code $($proc.ExitCode) ==="
    exit $proc.ExitCode
} finally {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
}
