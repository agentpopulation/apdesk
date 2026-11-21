@echo off
rem Opens AP Desk in its own window: an Edge app window when Edge is installed, else the default browser.
rem   open.bat desk       the desk itself, at http://127.0.0.1:<port>/
rem   open.bat starting   the start page, which waits for the desk and closes itself once the desk is open
rem The port comes from APD_PORT (start.bat sets it), else from setup\check.mjs.
setlocal EnableExtensions
set "PATH=%~dp0..\runtime\node;%PATH%;%ProgramFiles%\nodejs"
if not defined APD_PORT for /f %%p in ('node "%~dp0check.mjs" port') do set "APD_PORT=%%p"
set "URL=http://127.0.0.1:%APD_PORT%/"
set "SIZE=--start-maximized"
if /i not "%~1"=="starting" goto :edge
set "PAGE=%~dp0assets\starting.html"
set "URL=file:///%PAGE:\=/%?port=%APD_PORT%"
set "SIZE=--window-size=560,640"
:edge
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" goto :default
start "" "%EDGE%" --app="%URL%" %SIZE%
exit /b 0

:default
start "" "%URL%"
exit /b 0
