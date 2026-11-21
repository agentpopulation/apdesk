@echo off
rem Starts AP Desk when you sign in to Windows, or stops doing so. Only your own Startup folder is changed.
rem   setup\autostart.bat on
rem   setup\autostart.bat off
setlocal EnableExtensions
cd /d "%~dp0.."
set "PATH=%~dp0..\runtime\node;%PATH%;%ProgramFiles%\nodejs"
if /i "%~1"=="on" goto :go
if /i "%~1"=="off" goto :go
echo Use: setup\autostart.bat on   or   setup\autostart.bat off
exit /b 1
:go
node "%~dp0install.mjs" --autostart %1
exit /b %errorlevel%
