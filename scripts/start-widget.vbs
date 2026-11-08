Option Explicit

' NOCTURNE / silent desktop widget launcher.
' Clears Electron's Node compatibility switch so a clean Chromium process
' is always started, even if the shortcut is launched from a managed shell.

Dim fso, shell, projectDir, electron, desktop, logDir, logFile, logStream, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

projectDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
electron = fso.BuildPath(projectDir, "node_modules\electron\dist\electron.exe")
desktop = fso.BuildPath(projectDir, "desktop")
logDir = fso.BuildPath(projectDir, ".data\logs")
logFile = fso.BuildPath(logDir, "vbs-launch.log")

If Not fso.FileExists(electron) Then
  shell.Popup "NOCTURNE could not find its Electron runtime." & vbCrLf & _
    "Open the project and run: npm install", 10, "NOCTURNE", 16
  WScript.Quit 1
End If

If Not fso.FolderExists(projectDir & "\.data") Then fso.CreateFolder projectDir & "\.data"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir

Set logStream = fso.OpenTextFile(logFile, 8, True)
logStream.WriteLine "----- " & Now & " -----"
logStream.WriteLine "electron=" & electron
logStream.WriteLine "ELECTRON_RUN_AS_NODE before=[" & shell.Environment("PROCESS").Item("ELECTRON_RUN_AS_NODE") & "]"

On Error Resume Next
shell.Environment("PROCESS").Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0

logStream.WriteLine "ELECTRON_RUN_AS_NODE after =[" & shell.Environment("PROCESS").Item("ELECTRON_RUN_AS_NODE") & "]"
logStream.Close

shell.CurrentDirectory = projectDir
command = "cmd.exe /c """"" & electron & """ """ & desktop & """ --no-sandbox --disable-gpu >> """ & logFile & """ 2>&1"""
shell.Run command, 0, False
