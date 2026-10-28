# Ensure local inference servers are up. Called by both startup and watchdog tasks (dot-sourced,
# so every script-level name here is llama-prefixed to avoid clobbering the caller's Log/$LogFile).
#
# One llama-server.exe per role, told apart by --port (they share one executable path):
#   triage  :8080  Qwen3 1.7B chat          required  (telemetry triage)
#   embed   :8081  nomic-embed-text         optional  (memory search; falls back to keyword overlap)
#   vision  :8082  LLaVA + mmproj           optional  (test-screenshot classification)
# A missing model file for an optional role is logged and skipped, never fatal.
$LlamaDir = 'C:\Users\micha\AppData\Local\llama.cpp'
$LlamaServerExe = Join-Path $LlamaDir 'llama-server.exe'
$LlamaModelsDir = Join-Path $LlamaDir 'models'
$LlamaKeepaliveLog = Join-Path $LlamaDir 'keepalive.log'

$LlamaInstances = @(
    @{
        Role = 'triage'; Port = 8080; Required = $true; Alias = 'qwen3:1.7b'
        Model = (Join-Path $LlamaModelsDir 'qwen3-1.7b.gguf'); Projector = $null
        Extra = '--ctx-size 2048 --threads 8'
        Mutex = 'Global\LlamaCppKeepAlive'; LogFile = (Join-Path $LlamaDir 'server.stdout.log')
    },
    @{
        Role = 'embed'; Port = 8081; Required = $false; Alias = 'nomic-embed-text'
        Model = (Join-Path $LlamaModelsDir 'nomic-embed-text.gguf'); Projector = $null
        Extra = '--embeddings --pooling mean --ctx-size 2048 --batch-size 2048 --ubatch-size 2048 --threads 4'
        Mutex = 'Global\LlamaCppKeepAlive-embed'; LogFile = (Join-Path $LlamaDir 'embed.stdout.log')
    },
    @{
        Role = 'vision'; Port = 8082; Required = $false; Alias = 'llava:latest'
        Model = (Join-Path $LlamaModelsDir 'llava.gguf'); Projector = (Join-Path $LlamaModelsDir 'llava-mmproj.gguf')
        Extra = '--ctx-size 4096 --threads 4'
        Mutex = 'Global\LlamaCppKeepAlive-vision'; LogFile = (Join-Path $LlamaDir 'vision.stdout.log')
    }
)

function Write-LlamaKeepaliveLog([string]$Message) {
    try { "$(Get-Date -Format o)  $Message" | Out-File -FilePath $LlamaKeepaliveLog -Append -Encoding utf8 } catch {}
}

# Processes of OUR exe serving this port. Matching on the port keeps one role's restart from killing another.
function Get-LlamaInstanceProcesses([int]$Port) {
    @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $LlamaServerExe -and $_.CommandLine -match "--port\s+$Port(\s|$)" })
}

function Ensure-LlamaInstance([hashtable]$Spec) {
    $ErrorActionPreference = 'Continue'
    $role = $Spec.Role
    $port = $Spec.Port
    $mutex = New-Object System.Threading.Mutex($false, $Spec.Mutex)
    if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); return $true }
    try {
        $needed = @($LlamaServerExe, $Spec.Model)
        if ($Spec.Projector) { $needed += $Spec.Projector }
        # The watchdog runs every 2 minutes: note a missing optional model once, not 720 times a day.
        $missingMarker = Join-Path $LlamaDir ".missing-$role"
        foreach ($path in $needed) {
            if (-not (Test-Path -LiteralPath $path)) {
                if ($Spec.Required -or -not (Test-Path -LiteralPath $missingMarker)) {
                    Write-LlamaKeepaliveLog "[$role] not started: missing $path"
                    if (-not $Spec.Required) { New-Item -ItemType File -Path $missingMarker -Force | Out-Null }
                }
                return (-not $Spec.Required)
            }
        }
        Remove-Item -LiteralPath $missingMarker -Force -ErrorAction SilentlyContinue

        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5
            if ($health.status -eq 'ok') { return $true }
        } catch {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 503) {
                Write-LlamaKeepaliveLog "[$role] llama-server is loading its model; leaving it alone"
                return $true
            }
        }

        $managed = Get-LlamaInstanceProcesses $port
        foreach ($process in $managed) {
            Write-LlamaKeepaliveLog "[$role] llama-server PID $($process.ProcessId) on :$port is unhealthy; stopping it"
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
        if ($managed.Count -gt 0) { Start-Sleep -Seconds 2 }

        $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener) {
            Write-LlamaKeepaliveLog "[$role] cannot start: port $port is held by PID $($listener.OwningProcess)"
            return (-not $Spec.Required)
        }

        foreach ($path in @($Spec.LogFile)) {
            if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 10MB) {
                Move-Item -LiteralPath $path -Destination "$path.old" -Force -ErrorAction SilentlyContinue
            }
        }

        $arguments = "-m `"$($Spec.Model)`" --alias $($Spec.Alias) --host 127.0.0.1 --port $port --gpu-layers 0 $($Spec.Extra) --log-file `"$($Spec.LogFile)`""
        if ($Spec.Projector) { $arguments = "$arguments --mmproj `"$($Spec.Projector)`"" }
        try {
            $process = Start-Process -FilePath $LlamaServerExe -ArgumentList $arguments -WorkingDirectory $LlamaDir `
                -WindowStyle Hidden -PassThru
            try {
                $priority = if ($role -in @('embed', 'vision')) { [System.Diagnostics.ProcessPriorityClass]::BelowNormal } else { [System.Diagnostics.ProcessPriorityClass]::Normal }
                $process.PriorityClass = $priority
            } catch {
                Write-LlamaKeepaliveLog "[$role] failed to set priority: $_"
            }
            Write-LlamaKeepaliveLog "[$role] started llama-server PID $($process.Id) on 127.0.0.1:$port using $($Spec.Alias) (Priority: $($process.PriorityClass))"
            return $true
        } catch {
            Write-LlamaKeepaliveLog "[$role] llama-server launch failed: $_"
            return (-not $Spec.Required)
        }
    } finally {
        try { $mutex.ReleaseMutex() } catch {}
        $mutex.Dispose()
    }
}

# Keeps its old name and contract for supervisor-startup/-watchdog: $true unless a REQUIRED role failed.
function Ensure-LlamaServer {
    $llamaAllOk = $true
    foreach ($spec in $LlamaInstances) {
        if (-not (Ensure-LlamaInstance $spec)) { $llamaAllOk = $false }
    }
    return $llamaAllOk
}
