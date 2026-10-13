' Starts the Antigravity context meter in the background (no console window).
' Double-click to run. Use stop-injector.vbs to stop it.
' NOTE: keep this file ASCII-only -- Windows Script Host reads .vbs as ANSI,
' so non-ASCII text written as UTF-8 breaks the string literals.
Option Explicit

Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

If Not fso.FileExists(dir & "\inject.js") Then
  MsgBox "inject.js not found in:" & vbCrLf & dir, 16, "Antigravity Context Meter"
  WScript.Quit 1
End If

' Idempotent: the event trigger can fire more than once per launch (Antigravity
' runs several processes with the same image name), so never start a second one.
Dim wmi, procs, p
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name = 'node.exe'")
On Error Resume Next
For Each p In procs
  If InStr(p.CommandLine, "inject.js") > 0 Then WScript.Quit 0
Next
On Error Goto 0

On Error Resume Next
sh.Run "node.exe """ & dir & "\inject.js""", 0, False
If Err.Number <> 0 Then
  MsgBox "Failed to start. Is Node.js installed and on PATH?" & vbCrLf & Err.Description, 16, "Antigravity Context Meter"
  WScript.Quit 1
End If
On Error Goto 0
