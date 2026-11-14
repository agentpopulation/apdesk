@echo off
rem Opens the desk in its own full window (Edge app window when Edge is installed, else the default browser).
set "URL=http://127.0.0.1:3960"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL% --start-maximized
) else (
  start "" %URL%
)
