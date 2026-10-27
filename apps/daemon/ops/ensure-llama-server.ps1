# Ensure local telemetry inference is available. Called by both startup and watchdog tasks.
$LlamaDir = 'C:\Users\micha\AppData\Local\llama.cpp'
$LlamaServerExe = 'C:\Users\micha\AppData\Local\llama.cpp\llama-server.exe'
$LlamaModelPath = 'C:\Users\micha\AppData\Local\llama.cpp\models\qwen3-1.7b.gguf'
$LlamaPort = 8080
$LlamaKeepaliveLog = Join-Path $LlamaDir 'keepalive.log'
$LlamaStdoutFile = Join-Path $LlamaDir 'server.stdout.log'
$LlamaStderrFile = Join-Path $LlamaDir 'server.stderr.log'

function Write-LlamaKeepaliveLog([string]$Message) {
    try { "$(Get-Date -Format o)  $Message" | Out-File -FilePath $LlamaKeepaliveLog -Append -Encoding utf8 } catch {}
}

function Ensure-LlamaServer {
    $ErrorActionPreference = 'Continue'
    $mutex = New-Object System.Threading.Mutex($false, 'Global\LlamaCppKeepAlive')
    if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); return $true }
    try {
    foreach ($path in @($LlamaServerExe, $LlamaModelPath)) {
        if (-not (Test-Path -LiteralPath $path)) {
            Write-LlamaKeepaliveLog "cannot start llama-server: missing $path"
            return $false
        }
    }

    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$LlamaPort/health" -TimeoutSec 5
        if ($health.status -eq 'ok') { return $true }
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 503) {
            Write-LlamaKeepaliveLog "llama-server is actively loading model; leaving PID intact"
            return $true
        }
    }

    $managed = @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $LlamaServerExe })
    foreach ($process in $managed) {
        Write-LlamaKeepaliveLog "llama-server PID $($process.ProcessId) is unhealthy; stopping it"
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($managed.Count -gt 0) { Start-Sleep -Seconds 2 }

    $listener = Get-NetTCPConnection -LocalPort $LlamaPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        Write-LlamaKeepaliveLog "cannot start llama-server: port $LlamaPort is held by PID $($listener.OwningProcess)"
        return $false
    }

    foreach ($path in @($LlamaStdoutFile, $LlamaStderrFile)) {
        if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 10MB) {
            Move-Item -LiteralPath $path -Destination "$path.old" -Force -ErrorAction SilentlyContinue
        }
    }

    $arguments = "-m `"$LlamaModelPath`" --alias qwen3:1.7b --host 127.0.0.1 --port $LlamaPort --ctx-size 2048 --threads 8 --gpu-layers 0 --log-file `"$LlamaStdoutFile`""
    try {
        $process = Start-Process -FilePath $LlamaServerExe -ArgumentList $arguments -WorkingDirectory $LlamaDir `
            -WindowStyle Hidden -PassThru
        Write-LlamaKeepaliveLog "started llama-server PID $($process.Id) on 127.0.0.1:$LlamaPort using qwen3:1.7b"
        return $true
    } catch {
        Write-LlamaKeepaliveLog "llama-server launch failed: $_"
        return $false
    }
    } finally {
        try { $mutex.ReleaseMutex() } catch {}
        $mutex.Dispose()
    }
}
