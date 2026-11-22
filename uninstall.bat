@echo off
rem Removes AP Desk for this Windows user: asks once, stops it, removes its shortcuts and its entry in Settings, Apps,
rem then its program files. Your data and backups are kept unless you choose to delete them. Nothing outside this folder is removed.
setlocal EnableExtensions
cd /d "%~dp0"
title Uninstall AP Desk
if not exist "%~dp0app\server.js" goto :notapp
set "PATH=%~dp0runtime\node;%PATH%;%ProgramFiles%\nodejs"
node "%~dp0setup\check.mjs" node >nul 2>nul
if errorlevel 1 goto :nonode
rem One question before anything is stopped or removed. Enter alone keeps AP Desk.
echo.
echo This removes AP Desk from this PC:
rem the folder goes through a for variable: cmd does not read it again, so a & or ) in a folder name stays text
for %%d in ("%~dp0.") do echo   - the program in %%~fd
echo   - its Start menu and Desktop shortcuts, and its entry in Settings, Apps
echo Your chats, files, settings and backups stay in its data and backups folders,
echo unless you choose to delete them in the next question.
echo.
set "SURE="
set /p "SURE=Remove AP Desk? Type Y and press Enter. Press Enter alone to keep it: "
if /i "%SURE%"=="y" goto :remove
if /i "%SURE%"=="yes" goto :remove
echo.
echo AP Desk was not removed. Nothing was changed.
pause
exit /b 0

:remove
echo Stopping AP Desk ...
node "%~dp0setup\check.mjs" stop >nul 2>nul
rem 2: the desk still answers. Nothing is removed from under a running desk.
if errorlevel 2 goto :stillrunning
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

:stillrunning
echo.
echo AP Desk is still running and did not stop, so nothing was removed.
echo Restart the PC, then run Uninstall AP Desk again.
pause
exit /b 1

:failed
echo.
echo Nothing more was removed. The lines above say why.
pause
exit /b 1
