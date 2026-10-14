<#
  Unlock (or lock) the databank vault on Lubuntu from this PC.

  Prompts for the LUKS passphrase with hidden input, pipes it over SSH straight into
  `sudo databank-unlock --stdin`, and discards it. Nothing is written to disk, saved in the
  Windows credential store, or placed on a command line.

    unlock-databank.ps1           unlock and start the service
    unlock-databank.ps1 -Lock     stop the service, unmount and close the vault
    unlock-databank.ps1 -Status   show lock state and service health (no passphrase needed)
#>
param(
  [switch]$Lock,
  [switch]$Status,
  [switch]$NoPause,
  [string]$Target = "michael@100.69.94.119"
)

$ErrorActionPreference = "Stop"
$sshArgs = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=10", $Target)

function Invoke-Remote([string]$remoteCommand, [byte[]]$stdin) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "ssh"
  # Plain string: ArgumentList does not exist in Windows PowerShell 5.1.
  $psi.Arguments = ($sshArgs -join " ") + ' "' + $remoteCommand.Replace('"', '\"') + '"'
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  if ($stdin) { $p.StandardInput.BaseStream.Write($stdin, 0, $stdin.Length); $p.StandardInput.BaseStream.Flush() }
  $p.StandardInput.Close()
  $out = $p.StandardOutput.ReadToEnd() + $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  return [pscustomobject]@{ ExitCode = $p.ExitCode; Output = $out.Trim() }
}

try {
  if ($Status) {
    $r = Invoke-Remote "test -e /dev/mapper/databank && echo 'vault: UNLOCKED' || echo 'vault: LOCKED'; systemctl is-active databank.service | sed 's/^/service: /'" $null
    Write-Host $r.Output
  }
  elseif ($Lock) {
    $r = Invoke-Remote "sudo databank-lock" $null
    Write-Host $r.Output
    if ($r.ExitCode -ne 0) { Write-Host "Lock failed (exit $($r.ExitCode))." -ForegroundColor Red }
  }
  else {
    $state = Invoke-Remote "test -e /dev/mapper/databank && echo open || echo locked" $null
    if ($state.ExitCode -ne 0) { throw "Cannot reach $Target over SSH: $($state.Output)" }

    $secure = $null
    $bytes = $null
    try {
      if ($state.Output -eq "open") {
        Write-Host "Vault is already open; making sure it is mounted and the service is running."
        $r = Invoke-Remote "sudo databank-unlock --stdin" ([byte[]]@())
      }
      else {
        $secure = Read-Host "Databank passphrase" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        $bytes = $utf8.GetBytes($plain + "`n")
        $plain = $null
        $r = Invoke-Remote "sudo databank-unlock --stdin" $bytes
      }
    }
    finally {
      if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
      if ($secure) { $secure.Dispose() }
    }

    if ($r.ExitCode -eq 0) { Write-Host $r.Output -ForegroundColor Green }
    else { Write-Host "Unlock failed: $($r.Output)" -ForegroundColor Red }
  }
}
catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
}
if (-not $NoPause) { Read-Host "Press Enter to close" }
