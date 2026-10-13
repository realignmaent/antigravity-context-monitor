' Double-click launcher that self-elevates and runs install-event-autostart.ps1.
' Windows shows the UAC prompt; accept it to install the event subscriptions.
' ASCII only -- Windows Script Host reads .vbs as ANSI.
Option Explicit

Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

dir = fso.GetParentFolderName(WScript.ScriptFullName)

If Not fso.FileExists(dir & "\install-event-autostart.ps1") Then
  MsgBox "install-event-autostart.ps1 not found in:" & vbCrLf & dir, 16, "Antigravity Context Meter"
  WScript.Quit 1
End If

' -NoExit keeps the window open so the result stays readable.
On Error Resume Next
sh.ShellExecute "powershell.exe", _
  "-NoProfile -ExecutionPolicy Bypass -NoExit -File """ & dir & "\install-event-autostart.ps1""", _
  dir, "runas", 1
If Err.Number <> 0 Then
  MsgBox "Elevation was cancelled or failed." & vbCrLf & Err.Description, 16, "Antigravity Context Meter"
End If
