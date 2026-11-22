@echo off
rem Puts AP Desk's own copy of Node.js in runtime\node, inside the AP Desk folder. Nothing is installed for the whole PC.
rem The download is checked against the SHA-256 that nodejs.org publishes for this version before it is unpacked.
rem Uses only tools that ship with Windows 10 and 11: curl, certutil, tar, reg and findstr.
rem A proxy: curl uses HTTPS_PROXY by itself when it is set. Else the proxy set for this user in Windows (Settings,
rem Network, Proxy, "Use a proxy server") is read with reg and given to curl, with this user's own Windows sign-in
rem for a proxy that asks for one. A proxy that Windows finds by itself or through a setup script (PAC) cannot be
rem read with these tools; the message after a failed download says to set HTTPS_PROXY then.
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
set "PROXY="
if not defined HTTPS_PROXY call :winproxy
if defined PROXY goto :viaproxy
curl -fL --retry 2 -o "%ZIP%" "https://nodejs.org/dist/v%VER%/%NAME%.zip"
goto :fetched
:viaproxy
echo Going through the proxy that is set in Windows for you.
curl -fL --retry 2 --proxy "%PROXY%" --proxy-anyauth --proxy-user : -o "%ZIP%" "https://nodejs.org/dist/v%VER%/%NAME%.zip"
:fetched
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
echo If this PC reaches the internet through a proxy, set HTTPS_PROXY for your account to the proxy's
echo address (ask whoever looks after this PC for it), then try again.
exit /b 1

:winproxy
rem The proxy set in Windows for this user, when "Use a proxy server" is on. ProxyServer is "host:port" for every
rem kind of address, or a list such as "http=host:port;https=host:port": the https one is used, else the http one.
set "PXON="
set "PXSRV="
for /f "tokens=3" %%a in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable 2^>nul ^| findstr /i "ProxyEnable"') do set "PXON=%%a"
if not "%PXON%"=="0x1" exit /b 0
for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer 2^>nul ^| findstr /i "ProxyServer"') do set "PXSRV=%%b"
if not defined PXSRV exit /b 0
set "PROXY=%PXSRV%"
echo %PXSRV%| findstr "=" >nul || exit /b 0
set "PROXY="
set "PXHTTP="
for %%e in ("%PXSRV:;=" "%") do call :proxypart %%e
if not defined PROXY set "PROXY=%PXHTTP%"
exit /b 0

:proxypart
set "PART=%~1"
if /i "%PART:~0,6%"=="https=" set "PROXY=%PART:~6%"
if /i "%PART:~0,5%"=="http=" set "PXHTTP=%PART:~5%"
exit /b 0

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
