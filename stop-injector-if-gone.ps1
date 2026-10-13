# Stops the injector, but ONLY once the Antigravity UI is really gone.
#
# Two traps this guards against:
#
# 1. Antigravity runs several processes named Antigravity.exe (main + gpu +
#    renderers), so Win32_ProcessStopTrace fires on each one. A naive "any
#    Antigravity.exe?" check would tear the meter down while the app is still up.
#
# 2. One of those processes is the sidecar host (`--import ... register_loader.js
#    main.mjs`) and it NEVER exits -- it survived a full app restart (seen live:
#    started 12:02, still running at 19:09 while the window was relaunched at
#    19:07). Counting it means the meter would never be stopped at all. So the
#    sidecar is excluded, and "gone" means no non-sidecar Antigravity.exe remains.

$ErrorActionPreference = 'SilentlyContinue'

$running = Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe'" |
  Where-Object { -not $_.CommandLine -or $_.CommandLine -notmatch 'register_loader\.js' }

if ($running) { exit 0 }   # the app is still up - leave the injector alone

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*inject.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
