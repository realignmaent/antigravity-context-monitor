' Registers a logon scheduled task that keeps the context meter attached to
' Antigravity. Runs without administrator rights.
'
' Two non-obvious requirements, both verified on this machine:
'  1. The LogonTrigger AND the Principal must carry an explicit <UserId>;
'     without it the task is treated as "any user" and creation is denied.
'  2. PowerShell's Register-ScheduledTask is denied at this privilege level
'     even though schtasks /Create succeeds, so this goes through schtasks.
'
' Why a logon task rather than "run when Antigravity.exe starts": subscribing to
' process start/stop events (Win32_Process*Trace, Security 4688) requires
' elevation, so it is unavailable here. The task starts the injector at logon
' and the injector itself follows Antigravity's lifetime.
'
' ASCII only -- Windows Script Host reads .vbs as ANSI.
Option Explicit

Dim sh, fso, dir, uid, xmlPath, xml, tmp, rc, quiet, msg
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

quiet = WScript.Arguments.Named.Exists("quiet")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
uid = sh.ExpandEnvironmentStrings("%USERDOMAIN%") & "\" & sh.ExpandEnvironmentStrings("%USERNAME%")

If Not fso.FileExists(dir & "\inject.js") Then
  MsgBox "inject.js not found in:" & vbCrLf & dir, 16, "Antigravity Context Meter"
  WScript.Quit 1
End If

xml = "<?xml version=""1.0"" encoding=""UTF-16""?>" & vbCrLf & _
"<Task version=""1.2"" xmlns=""http://schemas.microsoft.com/windows/2004/02/mit/task"">" & vbCrLf & _
"  <RegistrationInfo><Description>Keeps the Antigravity context meter attached to Antigravity.</Description></RegistrationInfo>" & vbCrLf & _
"  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>" & uid & "</UserId></LogonTrigger></Triggers>" & vbCrLf & _
"  <Principals><Principal id=""Author""><UserId>" & uid & "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>" & vbCrLf & _
"  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>" & _
"<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>" & _
"<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>" & _
"<StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit>" & _
"<Enabled>true</Enabled></Settings>" & vbCrLf & _
"  <Actions Context=""Author""><Exec><Command>wscript.exe</Command>" & _
"<Arguments>""" & dir & "\start-injector.vbs""</Arguments></Exec></Actions>" & vbCrLf & _
"</Task>" & vbCrLf

xmlPath = fso.GetSpecialFolder(2) & "\agcm-task.xml"
Dim f
Set f = fso.CreateTextFile(xmlPath, True, True)   ' True = Unicode (UTF-16LE + BOM)
f.Write xml
f.Close

rc = sh.Run("schtasks /Create /TN ""Antigravity Context Meter"" /XML """ & xmlPath & """ /F", 0, True)
fso.DeleteFile xmlPath, True

If rc = 0 Then
  msg = "Autostart installed." & vbCrLf & vbCrLf & _
        "It starts with Windows and follows Antigravity: attaches while Antigravity" & vbCrLf & _
        "is running, pauses when you close it, and exits after 30 minutes idle." & vbCrLf & vbCrLf & _
        "To undo: run uninstall-autostart.vbs"
  If Not quiet Then MsgBox msg, 64, "Antigravity Context Meter"
Else
  msg = "Could not register the scheduled task (exit code " & rc & ")." & vbCrLf & _
        "You can still start it manually with start-injector.vbs"
  If Not quiet Then MsgBox msg, 16, "Antigravity Context Meter"
  WScript.Quit 1
End If
