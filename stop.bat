@echo off
rem AP Desk: stops the desk cleanly, also when it runs in the background. Your data stays in the data folder.
setlocal EnableExtensions
cd /d "%~dp0"
set "PATH=%~dp0runtime\node;%PATH%;%ProgramFiles%\nodejs"
echo Stopping AP Desk ...
node "%~dp0setup\check.mjs" stop
if errorlevel 1 goto :notrunning
echo AP Desk has stopped.
timeout /t 3 >nul
exit /b 0

:notrunning
echo AP Desk was not running.
timeout /t 3 >nul
exit /b 0
