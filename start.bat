@echo off
rem Double-click to start the app. It opens in your browser; close this window to stop it.
cd /d "%~dp0"
".venv\Scripts\python.exe" run.py %*
pause
