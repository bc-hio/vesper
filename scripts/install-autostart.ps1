# ------------------------------------------------------------------
# NOCTURNE / install the frameless Electron widget into Startup
# No administrator rights required.
# ------------------------------------------------------------------

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ElectronExe = Join-Path $ProjectRoot "node_modules\electron\dist\electron.exe"
$DesktopEntry = Join-Path $ProjectRoot "desktop"
$Launcher = Join-Path $PSScriptRoot "start-widget.vbs"
$WscriptExe = Join-Path $env:WINDIR "System32\wscript.exe"
$IconPath = Join-Path $ProjectRoot "assets\nocturne.ico"
$StartupFolder = [Environment]::GetFolderPath("Startup")
$ProgramsFolder = [Environment]::GetFolderPath("Programs")
$ShortcutPath = Join-Path $StartupFolder "NOCTURNE Widget.lnk"
$StartMenuShortcut = Join-Path $ProgramsFolder "NOCTURNE Widget.lnk"

if (-not (Test-Path -LiteralPath $ElectronExe)) {
    throw "Electron runtime not found. Run: npm install"
}
if (-not (Test-Path -LiteralPath (Join-Path $DesktopEntry "main.cjs"))) {
    throw "Desktop entry point not found: $DesktopEntry"
}
if (-not (Test-Path -LiteralPath $Launcher)) {
    throw "Launcher not found: $Launcher"
}
if (-not (Test-Path -LiteralPath $WscriptExe)) {
    throw "wscript.exe not found: $WscriptExe"
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    $fallback = Join-Path $env:ProgramFiles "nodejs\node.exe"
    if (-not (Test-Path -LiteralPath $fallback)) {
        throw "Node.js was not found. Install Node.js or make node.exe available on PATH."
    }
}
if (-not (Test-Path -LiteralPath $StartupFolder)) {
    New-Item -ItemType Directory -Force -Path $StartupFolder | Out-Null
}

$shell = New-Object -ComObject WScript.Shell

# Remove the previous Edge-based startup shortcut if upgrading.
if (Test-Path -LiteralPath $ShortcutPath) {
    Remove-Item -LiteralPath $ShortcutPath -Force
}

$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $WscriptExe
$shortcut.Arguments = '"{0}"' -f $Launcher
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.WindowStyle = 7
$shortcut.Description = "NOCTURNE desktop widget — start with Windows"
if (Test-Path -LiteralPath $IconPath) {
    $shortcut.IconLocation = "$IconPath,0"
}
$shortcut.Save()

# A searchable Start Menu entry gives users a way back in after closing the widget.
$menuShortcut = $shell.CreateShortcut($StartMenuShortcut)
$menuShortcut.TargetPath = $WscriptExe
$menuShortcut.Arguments = '"{0}"' -f $Launcher
$menuShortcut.WorkingDirectory = $ProjectRoot
$menuShortcut.WindowStyle = 7
$menuShortcut.Description = "NOCTURNE desktop widget"
if (Test-Path -LiteralPath $IconPath) {
    $menuShortcut.IconLocation = "$IconPath,0"
}
$menuShortcut.Save()

Write-Host ""
Write-Host "  NOCTURNE autostart installed." -ForegroundColor DarkYellow
Write-Host "  Startup : $ShortcutPath"
Write-Host "  Start menu: $StartMenuShortcut"
Write-Host "  The desktop widget will open automatically at your next Windows login."
Write-Host ""
Write-Host "  Launch it now with:" -ForegroundColor DarkGray
Write-Host "    npm run widget" -ForegroundColor DarkGray
Write-Host ""
