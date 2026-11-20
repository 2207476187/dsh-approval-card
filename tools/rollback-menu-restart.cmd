
@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0port-menu-restart.ps1" -Rollback %*
