; ------------------------------------------------------------------
; NOCTURNE / per-user startup integration
; The app is installed by an assisted NSIS installer and can be placed
; anywhere the user chooses. Register that exact path so login startup
; always points at the installed executable.
; ------------------------------------------------------------------

; The directory page can select a path that does not exist yet. Creating it
; here happens before the installer copies its first file, which avoids the
; "cannot open file to write" failure on fresh custom directories.
Function .onVerifyInstDir
  IfFileExists "$INSTDIR\*.*" 0 create
    Goto done
  create:
  CreateDirectory "$INSTDIR"
  IfErrors 0 done
    MessageBox MB_ICONSTOP|MB_OK "NOCTURNE could not create this installation folder.$\r$\nChoose another folder or allow the installer through your security software."
  done:
FunctionEnd

!macro customInstall
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "NOCTURNE" '"$INSTDIR\NOCTURNE.exe" --no-sandbox --disable-gpu'
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "NOCTURNE"
!macroend
