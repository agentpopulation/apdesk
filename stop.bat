@echo off
rem AP Desk: stops the desk cleanly. Your data stays in the data folder.
setlocal EnableExtensions
cd /d "%~dp0"
set "PATH=%PATH%;%ProgramFiles%\nodejs"
node "%~dp0setup\check.mjs" stop
if errorlevel 1 (
  echo The desk was not running.
) else (
  echo AP Desk has stopped.
)
timeout /t 2 >nul
