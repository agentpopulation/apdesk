@echo off
rem AP Desk setup: makes sure Node.js 22.13+ and the packages are in place. Safe to run again.
rem Node.js is AP Desk's own copy in runtime\node (setup\get-node.bat). A system Node.js 22.13 or newer also works.
setlocal EnableExtensions
cd /d "%~dp0.."
set "PATH=%~dp0..\runtime\node;%PATH%;%ProgramFiles%\nodejs"
echo Checking Node.js ...
if not exist "%~dp0..\runtime\node\node.exe" call "%~dp0get-node.bat"
node "%~dp0check.mjs" node
if errorlevel 1 goto :nonode
node "%~dp0check.mjs" packages >nul 2>nul
if not errorlevel 1 goto :done
echo Installing packages. This needs the internet once ...
call :install
if errorlevel 1 goto :nopackages
node "%~dp0check.mjs" packages >nul 2>nul
if errorlevel 1 goto :stillmissing
:done
echo Setup is complete.
exit /b 0

:nonode
echo AP Desk needs Node.js 22.13 or newer and could not get its own copy.
echo Check your internet connection and run start.bat again.
echo If you prefer one Node.js for the whole PC, install Node.js 22 LTS from https://nodejs.org
echo or with: winget install -e --id OpenJS.NodeJS.LTS   and then run start.bat again.
exit /b 1

:nopackages
echo The packages could not be installed. Check your internet connection and run start.bat again.
exit /b 1

:stillmissing
echo The packages are still missing. Run setup\reinstall.bat, then start.bat again.
exit /b 1

:install
rem A repository checkout has package.json beside start.bat; the unzipped app keeps it in setup\.
if not exist "%~dp0..\package.json" goto :install_zip
pushd "%~dp0.."
call npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
set "RC=%errorlevel%"
popd
exit /b %RC%

:install_zip
pushd "%~dp0"
call npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
set "RC=%errorlevel%"
popd
if not "%RC%"=="0" exit /b %RC%
if exist "%~dp0..\node_modules" rmdir /s /q "%~dp0..\node_modules"
move "%~dp0node_modules" "%~dp0..\node_modules" >nul
exit /b 0
