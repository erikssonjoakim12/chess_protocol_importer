@echo off
rem Double-click to open the app on this computer. Close this window to stop it.
cd /d "%~dp0"
node scripts\serve.js %*
if errorlevel 1 pause
