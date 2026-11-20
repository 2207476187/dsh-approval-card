@echo off
rem Restore the patched desktop shell loader and relaunch DeepSeek Harness.
rem Runs restore-loader.ps1 next to this file; keep this file ASCII-only.
setlocal
set PS1=%~dp0restore-loader.ps1
if not exist "%PS1%" (
  echo [restore-loader] missing: %PS1%
  pause
  exit /b 2
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
echo.
echo exit code: %ERRORLEVEL%
pause
