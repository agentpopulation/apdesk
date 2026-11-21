@echo off
rem Removes AP Desk for this Windows user: stops it, removes its shortcuts and its entry in Settings, Apps, then its
rem program files. Your data and backups are kept unless you choose to delete them. Nothing outside this folder is removed.
setlocal EnableExtensions
cd /d "%~dp0"
title Uninstall AP Desk
if not exist "%~dp0app\server.js" goto :notapp
set "PATH=%~dp0runtime\node;%PATH%;%ProgramFiles%\nodejs"
node "%~dp0setup\check.mjs" node >nul 2>nul
if errorlevel 1 goto :nonode
echo Stopping AP Desk ...
node "%~dp0setup\check.mjs" stop >nul 2>nul
node "%~dp0setup\uninstall.mjs"
if errorlevel 1 goto :failed
rem Node.js has stopped, so its own folder can go now. This file goes last, with the folder if it is empty.
if exist "%~dp0runtime" rmdir /s /q "%~dp0runtime"
echo AP Desk is removed.
pause
cd /d "%~dp0.."
(goto) 2>nul & del "%~f0" & rmdir "%~dp0" 2>nul

:notapp
echo This folder does not look like AP Desk (there is no app\server.js). Nothing was removed.
pause
exit /b 1

:nonode
echo Node.js is missing from this folder, so the uninstaller cannot run. Nothing was removed.
echo You can remove AP Desk by hand: delete its shortcuts, then this folder.
pause
exit /b 1

:failed
echo.
echo Nothing more was removed. The lines above say why.
pause
exit /b 1
