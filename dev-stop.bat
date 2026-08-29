@echo off
setlocal
cd /d "%~dp0"

if not exist dev.pid (
  echo [dev-stop] dev.pid not found - nothing to stop.
  exit /b 0
)

set /p PID=<dev.pid

tasklist /FI "PID eq %PID%" 2>NUL | find "%PID%" >NUL
if errorlevel 1 (
  echo [dev-stop] PID %PID% not running - cleaning up stale dev.pid.
  del dev.pid
  exit /b 0
)

taskkill /PID %PID% /T /F >NUL 2>&1
del dev.pid
echo [dev-stop] Stopped ^(PID %PID% and its child processes^).

endlocal
