# Removes the WMI process-event subscriptions installed by
# install-event-autostart.ps1, and stops any injector that is running.
# RUN AS ADMINISTRATOR. Use Windows PowerShell (powershell.exe), not pwsh.

#requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'
$ns = 'root\subscription'

Get-WmiObject -Namespace $ns -Class __FilterToConsumerBinding -ErrorAction SilentlyContinue |
  Where-Object { $_.Filter -like '*AGCM_*' -or $_.Consumer -like '*AGCM_*' } |
  Remove-WmiObject -ErrorAction SilentlyContinue

Get-WmiObject -Namespace $ns -Class __EventFilter -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'AGCM_*' } |
  Remove-WmiObject -ErrorAction SilentlyContinue

Get-WmiObject -Namespace $ns -Class CommandLineEventConsumer -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like 'AGCM_*' } |
  Remove-WmiObject -ErrorAction SilentlyContinue

if (Get-ScheduledTask -TaskName 'AGCM-Injector' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName 'AGCM-Injector' -Confirm:$false
  Write-Host '已移除按需任务 AGCM-Injector。'
}

$killed = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*inject.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }

Write-Host "已移除事件订阅，停止 $killed 个注入器进程。"
Write-Host "Antigravity 里可能还留着面板方块，按 Ctrl+R 刷新即可清除。"
