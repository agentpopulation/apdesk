@echo off
rem AP Desk: double-click to start. Answers only on this PC at http://127.0.0.1:3960
setlocal EnableExtensions
cd /d "%~dp0"
title AP Desk
set "PATH=%PATH%;%ProgramFiles%\nodejs"

rem 1. Node 22.13 or newer and the installed packages. Setup fixes whatever is missing.
node "%~dp0setup\check.mjs" >nul 2>nul
if errorlevel 1 (
  call "%~dp0setup\setup.bat"
  if errorlevel 1 goto :fail
)

rem 2. Already running? Just open it.
node "%~dp0setup\check.mjs" running >nul 2>nul
if not errorlevel 1 (
  call :open
  exit /b 0
)

rem 3. Open the browser once the desk answers, then run the desk in this window.
start "" /min cmd /c "node "%~dp0setup\check.mjs" wait && call "%~dp0setup\open.bat""
:run
node --no-warnings "%~dp0app\server.js"
if "%errorlevel%"=="75" goto :run
if "%errorlevel%"=="2" call :open
exit /b %errorlevel%

:open
call "%~dp0setup\open.bat"
exit /b 0

:fail
echo.
echo AP Desk could not start. Read the lines above, or run setup\setup.bat yourself.
pause
exit /b 1
