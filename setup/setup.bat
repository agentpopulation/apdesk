@echo off
rem AP Desk setup: makes sure Node 22.13+ and the packages are in place. Safe to run again.
setlocal EnableExtensions
cd /d "%~dp0.."
set "PATH=%PATH%;%ProgramFiles%\nodejs"
echo Checking Node.js ...
node "%~dp0check.mjs" node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is needed. Installing the current LTS with winget ...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo Could not install Node.js. Install it from https://nodejs.org and run start.bat again.
    exit /b 1
  )
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
node "%~dp0check.mjs" node
if errorlevel 1 (
  echo Node.js is installed but this window cannot see it yet. Close this window and run start.bat again.
  exit /b 1
)
node "%~dp0check.mjs" packages >nul 2>nul
if errorlevel 1 (
  echo Installing packages. This needs the internet once ...
  call :install
rem A repository checkout has package.json beside start.bat; the unzipped app keeps it in setup\.
if not exist "%~dp0..\package.json" goto :install_zip
pushd "%~dp0.."
call npm install --omit=dev --ignore-scripts --no-audit --no-fund
set "RC=%errorlevel%"
popd
exit /b %RC%

:install_zip
pushd "%~dp0"
call npm ci --omit=dev --ignore-scripts --no-audit --no-fund
set "RC=%errorlevel%"
popd
if not "%RC%"=="0" exit /b %RC%
if exist "%~dp0..\node_modules" rmdir /s /q "%~dp0..\node_modules"
move "%~dp0node_modules" "%~dp0..\node_modules" >nul
exit /b 0
