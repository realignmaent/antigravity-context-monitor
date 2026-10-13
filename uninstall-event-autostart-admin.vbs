' Double-click launcher that self-elevates and runs uninstall-event-autostart.ps1,
' removing the WMI process-event subscriptions and stopping the meter.
' ASCII only -- Windows Script Host reads .vbs as ANSI.
Option Explicit

Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

dir = fso.GetParentFolderName(WScript.ScriptFullName)

If Not fso.FileExists(dir & "\uninstall-event-autostart.ps1") Then
  MsgBox "uninstall-event-autostart.ps1 not found in:" & vbCrLf & dir, 16, "Antigravity Context Monitor"
  WScript.Quit 1
End If

On Error Resume Next
sh.ShellExecute "powershell.exe", _
  "-NoProfile -ExecutionPolicy Bypass -NoExit -File """ & dir & "\uninstall-event-autostart.ps1""", _
  dir, "runas", 1
If Err.Number <> 0 Then
  MsgBox "Elevation was cancelled or failed." & vbCrLf & Err.Description, 16, "Antigravity Context Monitor"
End If
