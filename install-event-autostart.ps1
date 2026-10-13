# Registers permanent WMI event subscriptions so the context meter starts and
# stops exactly with Antigravity. RUN AS ADMINISTRATOR.
#
#   Antigravity.exe starts -> schtasks /Run "AGCM-Injector"  (runs as YOU)
#   Antigravity.exe stops  -> stop-injector-if-gone.ps1
#
# Why the extra "AGCM-Injector" task instead of having the WMI consumer launch
# node directly: a CommandLineEventConsumer runs as SYSTEM, which would leave the
# meter owned by SYSTEM -- you could not stop it yourself, and it would read your
# profile as the wrong account. The consumer therefore only pokes a per-user task.
#
# Why WMI subscriptions and not a scheduled task trigger: subscribing to process
# events needs elevation either way, and the Task Scheduler route additionally
# requires the "Audit Process Creation" policy and floods the Security log.
#
# Run with Windows PowerShell 5.1 (powershell.exe), NOT PowerShell 7 -- this uses
# the WMI cmdlets, which pwsh does not ship.

#requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -ge 7) {
  throw '请用 Windows PowerShell 5.1 运行本脚本（它使用 WMI cmdlet，PowerShell 7 不提供）。开始菜单搜索 "Windows PowerShell" → 右键以管理员身份运行。'
}

$ns       = 'root\subscription'
$taskName = 'AGCM-Injector'   # no spaces: Start-Process does not quote array args

$dir      = $PSScriptRoot
$userHome = if ($env:AGCM_TARGET_HOME) { $env:AGCM_TARGET_HOME } else { $env:USERPROFILE }

# In an elevated session $env:USERNAME can come through empty, which produced an
# invalid "DOMAIN\" and made schtasks fail with "参数错误". Derive the account a
# different way, and prove it resolves to a SID before using it.
$candidates = @(
  [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
  $(if ($env:USERNAME) { "$env:USERDOMAIN\$env:USERNAME" }),
  "$env:COMPUTERNAME\$(Split-Path $userHome -Leaf)"
)
$uid = $null
foreach ($candidate in $candidates) {
  if (-not $candidate -or $candidate -match '(^|\\)$') { continue }
  try {
    $null = ([System.Security.Principal.NTAccount]::new($candidate)).Translate(
              [System.Security.Principal.SecurityIdentifier])
    $uid = $candidate
    break
  } catch { }
}
if (-not $uid) { throw '无法确定当前账号，请设置 $env:AGCM_TARGET_HOME 后重试。' }

$ps       = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$schtasks = Join-Path $env:SystemRoot 'System32\schtasks.exe'

Write-Host "目标账号     : $uid"
Write-Host "目标用户目录 : $userHome"
Write-Host ''

foreach ($f in 'stop-injector-if-gone.ps1', 'start-injector.vbs', 'inject.js') {
  if (-not (Test-Path (Join-Path $dir $f))) { throw "缺少文件：$f" }
}

# --- 1. per-user, on-demand task that actually launches the meter -------------

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Launches the Antigravity context meter in your session.</Description></RegistrationInfo>
  <Principals><Principal id="Author"><UserId>$uid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>$dir\start-injector.vbs</Arguments></Exec></Actions>
</Task>
"@

$xmlPath = Join-Path $env:TEMP 'agcm-injector-task.xml'
Set-Content -Path $xmlPath -Value $xml -Encoding Unicode
$rc = (Start-Process -FilePath $schtasks -ArgumentList @('/Create', '/TN', $taskName, '/XML', $xmlPath, '/F') -Wait -PassThru -NoNewWindow).ExitCode
Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
if ($rc -ne 0) { throw "注册任务 $taskName 失败（退出码 $rc）" }
Write-Host "  [ok] 已注册按需任务 $taskName（以你的身份运行）"

# --- 2. WMI event subscriptions ----------------------------------------------
#
# NOTE: only set properties that actually exist on the class. Passing an unknown
# one makes Set-WmiInstance fail with a bare "找不到" -- CommandLineEventConsumer
# has no Description property, which is what broke the first attempt.

function Remove-Existing {
  Get-WmiObject -Namespace $ns -Class __FilterToConsumerBinding -ErrorAction SilentlyContinue |
    Where-Object { $_.Filter -like '*AGCM_*' -or $_.Consumer -like '*AGCM_*' } |
    Remove-WmiObject -ErrorAction SilentlyContinue
  Get-WmiObject -Namespace $ns -Class __EventFilter -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'AGCM_*' } |
    Remove-WmiObject -ErrorAction SilentlyContinue
  Get-WmiObject -Namespace $ns -Class CommandLineEventConsumer -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'AGCM_*' } |
    Remove-WmiObject -ErrorAction SilentlyContinue
}

function New-Watcher {
  param([string]$Tag, [string]$Query, [string]$Command)

  $filter = Set-WmiInstance -Namespace $ns -Class __EventFilter -Arguments @{
    Name           = "AGCM_${Tag}_Filter"
    EventNamespace = 'root\cimv2'
    QueryLanguage  = 'WQL'
    Query          = $Query
  }
  $consumer = Set-WmiInstance -Namespace $ns -Class CommandLineEventConsumer -Arguments @{
    Name                = "AGCM_${Tag}_Consumer"
    CommandLineTemplate = $Command
  }
  $null = Set-WmiInstance -Namespace $ns -Class __FilterToConsumerBinding -Arguments @{
    Filter   = $filter
    Consumer = $consumer
  }
  Write-Host "  [ok] 事件订阅 $Tag"
}

Write-Host '注册进程事件订阅…'
Remove-Existing

New-Watcher -Tag 'Start' `
  -Query "SELECT * FROM Win32_ProcessStartTrace WHERE ProcessName='Antigravity.exe'" `
  -Command "`"$schtasks`" /Run /TN `"$taskName`""

New-Watcher -Tag 'Stop' `
  -Query "SELECT * FROM Win32_ProcessStopTrace WHERE ProcessName='Antigravity.exe'" `
  -Command "`"$ps`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dir\stop-injector-if-gone.ps1`""

# --- 3. drop the redundant logon task ----------------------------------------

if (Get-ScheduledTask -TaskName 'Antigravity Context Meter' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName 'Antigravity Context Meter' -Confirm:$false
  Write-Host '  [ok] 已移除登录自启任务（事件订阅已取代它）'
}

Write-Host ''
Write-Host '完成。Antigravity 一启动面板就挂上，完全退出后自动撤掉。'
Write-Host ''
Write-Host '验证：关掉 Antigravity 再打开，面板应在几秒内自己出现。'
Write-Host '卸载：以管理员身份运行 uninstall-event-autostart.ps1'
