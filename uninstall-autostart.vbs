' Removes the logon task created by install-autostart.vbs and stops any
' injector that is currently running.
' ASCII only -- Windows Script Host reads .vbs as ANSI.
Option Explicit

Dim sh, fso, dir, taskName, wmi, procs, p, killed
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
taskName = "Antigravity Context Meter"

sh.Run "schtasks /Delete /TN """ & taskName & """ /F", 0, True

killed = 0
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name = 'node.exe'")
On Error Resume Next
For Each p In procs
  If InStr(p.CommandLine, "inject.js") > 0 Then
    p.Terminate()
    killed = killed + 1
  End If
Next
On Error Goto 0

MsgBox "Autostart removed." & vbCrLf & _
       "Stopped " & killed & " injector process(es)." & vbCrLf & vbCrLf & _
       "The panel may still be visible in Antigravity; press Ctrl+R there to clear it.", 64, taskName
