@echo off
rem AP Desk reinstall: removes the installed packages and installs them again.
rem Your data folder and your backups are not touched.
setlocal EnableExtensions
cd /d "%~dp0.."
call "%~dp0..\stop.bat" >nul 2>nul
echo Removing installed packages ...
if exist "%~dp0..\node_modules" rmdir /s /q "%~dp0..\node_modules"
call "%~dp0setup.bat"
if errorlevel 1 ( pause & exit /b 1 )
echo Reinstall is complete. Start the desk with start.bat.
pause
