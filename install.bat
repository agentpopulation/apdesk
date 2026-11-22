@echo off
rem AP Desk installer for this Windows user. Double-click it in the unpacked download. Safe to run again.
rem It needs no administrator rights: it writes only to the folder you choose, your own Start menu and Desktop,
rem and your own list of apps. The steps are in setup\install.mjs.
rem   install.bat            the installer page opens in your browser; this window stays open until the install ends
rem   install.bat /console   the same questions here in this window instead
setlocal EnableExtensions
cd /d "%~dp0"
title AP Desk setup
if not exist "%~dp0app\server.js" goto :notapp
set "PATH=%~dp0runtime\node;%PATH%;%ProgramFiles%\nodejs"
if not exist "%~dp0runtime\node\node.exe" call "%~dp0setup\get-node.bat"
node "%~dp0setup\check.mjs" node >nul 2>nul
if errorlevel 1 goto :nonode
node "%~dp0setup\install.mjs" %*
if errorlevel 1 goto :failed
exit /b 0

:notapp
echo This folder does not hold AP Desk (there is no app\server.js). Unpack the whole download and try again.
pause
exit /b 1

:nonode
echo AP Desk could not get Node.js. Check your internet connection and run install.bat again.
pause
exit /b 1

:failed
echo.
echo The install did not finish. The installer page or the lines above say why.
pause
exit /b 1
