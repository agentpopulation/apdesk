@echo off
rem AP Desk: double-click to start. It answers only on this PC, at http://127.0.0.1 on its own port (3445 unless taken).
rem   start.bat                       runs the desk in this window; closing the window stops it
rem   start.bat background            runs the desk with no window; its lines go to data\desk.log
rem   start.bat background nowindow   the same, without opening the desk
rem The shortcuts run setup\background.mjs with Node.js directly, so they leave no console window behind.
setlocal EnableExtensions
cd /d "%~dp0"
title AP Desk
rem AP Desk's own Node.js copy comes first; a system Node.js is the fallback.
set "PATH=%~dp0runtime\node;%PATH%;%ProgramFiles%\nodejs"
set "MODE=window"
if /i "%~1"=="background" set "MODE=background"
set "OPEN=yes"
if /i "%~2"=="nowindow" set "OPEN=no"

rem 1. Node.js 22.13 or newer and the packages. A missing Node.js copy is fetched; setup fixes what else is missing.
if not exist "%~dp0runtime\node\node.exe" call "%~dp0setup\get-node.bat"
node "%~dp0setup\check.mjs" >nul 2>nul
if errorlevel 1 call "%~dp0setup\setup.bat"
if errorlevel 1 goto :fail

rem 2. The port: the remembered one, else 3445, else the next free one when another program holds it.
for /f %%p in ('node "%~dp0setup\check.mjs" port') do set "APD_PORT=%%p"
if not defined APD_PORT goto :fail

rem 3. Already running? Just open it.
node "%~dp0setup\check.mjs" running >nul 2>nul
if errorlevel 1 goto :start
if "%OPEN%"=="yes" call "%~dp0setup\open.bat" desk
exit /b 0

:start
if "%MODE%"=="background" goto :background
rem The start page reads data\start-state.js, so it can say when the desk stopped instead of waiting on.
node "%~dp0setup\background.mjs" mark starting
if "%OPEN%"=="yes" call "%~dp0setup\open.bat" starting

rem 4. In this window: open the desk once it answers, and run the desk here. 75 means it asked to be started again.
if "%OPEN%"=="yes" start "" /min cmd /c "node "%~dp0setup\check.mjs" wait && call "%~dp0setup\open.bat" desk"
echo AP Desk is starting at http://127.0.0.1:%APD_PORT%/  Closing this window stops it.
rem A proxy set for this PC in HTTPS_PROXY or HTTP_PROXY is used for the desk's own web calls (Node reads it when
rem NODE_USE_ENV_PROXY is 1). This PC itself never goes through the proxy.
if not defined NODE_USE_ENV_PROXY if defined HTTPS_PROXY set "NODE_USE_ENV_PROXY=1"
if not defined NODE_USE_ENV_PROXY if defined HTTP_PROXY set "NODE_USE_ENV_PROXY=1"
if "%NODE_USE_ENV_PROXY%"=="1" if defined NO_PROXY set "NO_PROXY=127.0.0.1,localhost,::1,%NO_PROXY%"
if "%NODE_USE_ENV_PROXY%"=="1" if not defined NO_PROXY set "NO_PROXY=127.0.0.1,localhost,::1"
:run
if exist "%~dp0setup\apply-update.mjs" node --no-warnings "%~dp0setup\apply-update.mjs"
node --no-warnings "%~dp0app\server.js"
set "RC=%errorlevel%"
if "%RC%"=="75" goto :run
if "%RC%"=="2" if "%OPEN%"=="yes" call "%~dp0setup\open.bat" desk
rem 0 is a clean stop, -1073741510 is Ctrl+C in this window. Anything else: the start page and this window say so.
if "%RC%"=="0" exit /b 0
if "%RC%"=="-1073741510" exit /b %RC%
node "%~dp0setup\background.mjs" mark stopped %RC%
if "%RC%"=="2" exit /b %RC%
echo.
echo AP Desk stopped because of an error. The lines above say why.
echo Start it again with start.bat. If it stops again, run setup\setup.bat, then start.bat.
pause
exit /b %RC%

:background
rem 4. In the background: setup\background.mjs shows the start page, runs the desk with no window (data\desk.log)
rem and opens the desk once it answers. It returns at once; this file does not wait for it.
set "BG=open"
if "%OPEN%"=="no" set "BG=open nowindow"
node "%~dp0setup\background.mjs" %BG%
if errorlevel 1 goto :fail
if "%OPEN%"=="yes" echo AP Desk is starting in the background and opens in its own window in a moment.
exit /b 0

:fail
echo.
echo AP Desk could not start. Read the lines above, or run setup\setup.bat yourself.
pause
exit /b 1
