# ------------------------------------------------------------------
# NOCTURNE / remove the widget from Windows startup
# ------------------------------------------------------------------

$ErrorActionPreference = "Stop"
$StartupFolder = [Environment]::GetFolderPath("Startup")
$ProgramsFolder = [Environment]::GetFolderPath("Programs")
$StartupShortcut = Join-Path $StartupFolder "NOCTURNE Widget.lnk"
$MenuShortcut = Join-Path $ProgramsFolder "NOCTURNE Widget.lnk"

foreach ($shortcut in @($StartupShortcut, $MenuShortcut)) {
    if (Test-Path -LiteralPath $shortcut) {
        Remove-Item -LiteralPath $shortcut -Force
        Write-Host "Removed $shortcut" -ForegroundColor DarkYellow
    }
}
Write-Host "NOCTURNE autostart removed." -ForegroundColor DarkYellow
