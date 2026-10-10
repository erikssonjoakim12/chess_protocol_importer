@echo off
rem Double-click to open the app. Close this window to stop it.
cd /d "%~dp0"
".venv\Scripts\python.exe" run.py %*
pause
