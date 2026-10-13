' Stops the background context meter started by start-injector.vbs.
' Matches on the command line so it never touches unrelated node processes.
' NOTE: keep this file ASCII-only -- Windows Script Host reads .vbs as ANSI.
Option Explicit

Dim wmi, procs, p, killed
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'")

killed = 0
On Error Resume Next
For Each p In procs
  If InStr(p.CommandLine, "inject.js") > 0 Then
    p.Terminate()
    killed = killed + 1
  End If
Next
On Error Goto 0

If killed = 0 Then
  WScript.Echo "No running injector found."
Else
  WScript.Echo "Stopped " & killed & " injector process(es)."
  WScript.Echo "The panel may still be visible in Antigravity; press Ctrl+R there to clear it."
End If
