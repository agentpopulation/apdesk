@echo off
rem Puts AP Desk's own copy of Node.js in runtime\node, inside the AP Desk folder. Nothing is installed for the whole PC.
rem The download is checked against the SHA-256 that nodejs.org publishes for this version before it is unpacked.
rem Uses only tools that ship with Windows 10 and 11: curl, certutil and tar.
setlocal EnableExtensions
set "VER=22.23.5"
set "SUM_X64=4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3"
set "SUM_ARM64=c1856817f611738c77534efbff8a5a17990593eab24046bc8d2c23a77a160d13"
set "RT=%~dp0..\runtime"
if exist "%RT%\node\node.exe" exit /b 0

rem The PC's own processor type. A 32-bit or x64 window on an ARM64 PC reports the emulated type in
rem PROCESSOR_ARCHITECTURE, so two more values are read: PROCESSOR_ARCHITEW6432 (set in 32-bit windows to the
rem real type) and PROCESSOR_IDENTIFIER (the same in every window; it starts with "ARM" on an ARM64 PC).
set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_IDENTIFIER:~0,3%"=="ARM" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" if not defined PROCESSOR_ARCHITEW6432 goto :x86
set "SUM=%SUM_X64%"
if "%ARCH%"=="arm64" set "SUM=%SUM_ARM64%"
set "NAME=node-v%VER%-win-%ARCH%"
set "ZIP=%RT%\%NAME%.zip"

echo Getting Node.js %VER% for this PC (%ARCH%) from nodejs.org. About 30 MB, only once ...
if not exist "%RT%" mkdir "%RT%"
curl -fL --retry 2 -o "%ZIP%" "https://nodejs.org/dist/v%VER%/%NAME%.zip"
if errorlevel 1 goto :nodownload
certutil -hashfile "%ZIP%" SHA256 | findstr /i "%SUM%" >nul
if errorlevel 1 goto :badsum
if exist "%RT%\%NAME%" rmdir /s /q "%RT%\%NAME%"
tar -xf "%ZIP%" -C "%RT%"
if errorlevel 1 goto :nounpack
del "%ZIP%"
if exist "%RT%\node" rmdir /s /q "%RT%\node"
ren "%RT%\%NAME%" node
if not exist "%RT%\node\node.exe" goto :nounpack
echo Node.js %VER% is ready in the runtime folder.
exit /b 0

:nodownload
if exist "%ZIP%" del "%ZIP%"
echo Could not download Node.js. Check your internet connection and try again.
exit /b 1

:badsum
del "%ZIP%"
echo The Node.js download does not match its published checksum, so it was deleted and not used.
echo Try again later. If it keeps happening, your connection may be changing downloads.
exit /b 1

:nounpack
echo Could not unpack Node.js into the runtime folder. Check that the disk has space and try again.
exit /b 1

:x86
echo This PC runs 32-bit Windows. AP Desk needs 64-bit Windows 10 or 11.
exit /b 1
