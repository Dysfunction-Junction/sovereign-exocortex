# Creates Desktop shortcuts: "Unlock Databank", "Lock Databank", "Databank Status".
$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "unlock-databank.ps1"
$desktop = [Environment]::GetFolderPath("Desktop")
$ws = New-Object -ComObject WScript.Shell

foreach ($s in @(
    @{ Name = "Unlock Databank"; Args = ""; Icon = "shell32.dll,47" },
    @{ Name = "Lock Databank"; Args = " -Lock"; Icon = "shell32.dll,48" },
    @{ Name = "Databank Status"; Args = " -Status"; Icon = "shell32.dll,23" }
  )) {
  $lnk = $ws.CreateShortcut((Join-Path $desktop ($s.Name + ".lnk")))
  $lnk.TargetPath = "powershell.exe"
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$script`"$($s.Args)"
  $lnk.WorkingDirectory = $PSScriptRoot
  $lnk.IconLocation = $s.Icon
  $lnk.Save()
  Write-Host "created $($s.Name)"
}
