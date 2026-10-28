# One-time copy of Ollama-pulled models into llama.cpp's models folder, so llama-server owns them and
# removing a model from Ollama can no longer break triage, embeddings or vision.
#
# Read-only on Ollama: it reads manifests and copies blobs; nothing in Ollama's store is changed.
# Re-running is safe: a destination that already has the same size is skipped.
#
#   powershell -ExecutionPolicy Bypass -File apps\daemon\ops\export-ollama-models.ps1
param(
    [string]$ModelsDir = 'C:\Users\micha\AppData\Local\llama.cpp\models',
    [string]$OllamaModels = $(if ($env:OLLAMA_MODELS) { $env:OLLAMA_MODELS } else { Join-Path $env:USERPROFILE '.ollama\models' })
)

$ErrorActionPreference = 'Stop'

# Ollama manifest (library/<name>/<tag>) -> file names ensure-llama-server.ps1 expects.
$Exports = @(
    @{ Manifest = 'qwen3\1.7b';               Model = 'qwen3-1.7b.gguf';       Projector = $null },
    @{ Manifest = 'nomic-embed-text\latest';  Model = 'nomic-embed-text.gguf'; Projector = $null },
    @{ Manifest = 'llava\latest';             Model = 'llava.gguf';            Projector = 'llava-mmproj.gguf' }
)

$ManifestRoot = Join-Path $OllamaModels 'manifests\registry.ollama.ai\library'
$BlobRoot = Join-Path $OllamaModels 'blobs'

function Get-BlobPath([object]$Layer) {
    # digest "sha256:<hex>" is stored on disk as "sha256-<hex>"
    Join-Path $BlobRoot ($Layer.digest -replace ':', '-')
}

function Test-Gguf([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $magic = New-Object byte[] 4
        [void]$stream.Read($magic, 0, 4)
        return ([System.Text.Encoding]::ASCII.GetString($magic) -eq 'GGUF')
    } finally { $stream.Dispose() }
}

function Copy-Layer([object]$Layer, [string]$Name) {
    $source = Get-BlobPath $Layer
    $dest = Join-Path $ModelsDir $Name
    if (-not (Test-Path -LiteralPath $source)) { return "missing blob $source" }
    if (-not (Test-Gguf $source)) { return "blob for $Name is not a GGUF file; download a llama.cpp build of it instead" }
    if ((Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).Length -eq (Get-Item -LiteralPath $source).Length) {
        return "already present ($dest)"
    }
    Copy-Item -LiteralPath $source -Destination $dest -Force
    return "copied to $dest ($([math]::Round((Get-Item -LiteralPath $dest).Length / 1MB)) MB)"
}

New-Item -ItemType Directory -Path $ModelsDir -Force | Out-Null

foreach ($export in $Exports) {
    $manifestPath = Join-Path $ManifestRoot $export.Manifest
    $label = $export.Manifest -replace '\\', ':'
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        Write-Output "$label : not pulled in Ollama (no manifest at $manifestPath) - skipped"
        continue
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $modelLayer = $manifest.layers | Where-Object { $_.mediaType -eq 'application/vnd.ollama.image.model' } | Select-Object -First 1
    if (-not $modelLayer) {
        Write-Output "$label : manifest has no model layer - skipped"
        continue
    }
    Write-Output "$label : model $(Copy-Layer $modelLayer $export.Model)"
    if ($export.Projector) {
        $projLayer = $manifest.layers | Where-Object { $_.mediaType -eq 'application/vnd.ollama.image.projector' } | Select-Object -First 1
        if ($projLayer) {
            Write-Output "$label : projector $(Copy-Layer $projLayer $export.Projector)"
        } else {
            Write-Output "$label : manifest has no projector layer; vision needs a separate mmproj file"
        }
    }
}
