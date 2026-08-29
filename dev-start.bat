@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

if exist dev.pid (
  set /p OLD_PID=<dev.pid
  tasklist /FI "PID eq !OLD_PID!" 2>NUL | find "!OLD_PID!" >NUL
  if not errorlevel 1 (
    echo [dev-start] Already running ^(PID !OLD_PID!^). Run dev-stop.bat first.
    exit /b 1
  )
  del dev.pid >NUL 2>&1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','npm run dev > dev.log 2>&1' -WorkingDirectory '%~dp0' -WindowStyle Hidden -PassThru; Set-Content -Path 'dev.pid' -Value $p.Id -NoNewline"

REM small settle delay - Set-Content above can lag slightly behind this script
ping -n 2 127.0.0.1 >NUL

set "NEW_PID="
if exist dev.pid set /p NEW_PID=<dev.pid

if defined NEW_PID (
  echo [dev-start] Started "npm run dev" ^(tsc --watch^) in the background. PID %NEW_PID%.
  echo [dev-start] Log: dev.log
) else (
  echo [dev-start] Failed to start - check dev.log
  exit /b 1
)

endlocal
