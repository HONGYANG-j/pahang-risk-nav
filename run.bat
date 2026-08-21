@echo off
REM Double-click this file to run the app. No typing required.
REM It starts the local server and opens the app in your browser automatically.
REM To stop it later, close the black window this opens.

cd /d "%~dp0"

echo Starting the Risk-Aware Navigation server...
echo (Leave this window open while you use the app. Close it to stop.)
echo.

start "" cmd /c "timeout /t 2 >nul && start http://localhost:8080"

python serve.py 8080
if errorlevel 1 (
    echo.
    echo Could not start with "python". Trying "py" instead...
    py serve.py 8080
)

if errorlevel 1 (
    echo.
    echo ============================================================
    echo  Could not start the server. Likely cause: Python isn't
    echo  installed, or isn't set up on PATH.
    echo  Install it from https://www.python.org/downloads/ and make
    echo  sure to tick "Add python.exe to PATH" during setup, then
    echo  double-click this file again.
    echo ============================================================
    pause
)
