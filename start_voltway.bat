@echo off
title Voltway - Flask Backend

echo.
echo =====================================
echo       VOLTWAY BACKEND STARTUP
echo =====================================
echo.

cd /d C:\Voltway

if not exist "venv\Scripts\activate.bat" (
    echo ERROR: Virtual environment not found.
    echo Please check your Voltway folder.
    pause
    exit /b 1
)

call venv\Scripts\activate.bat

cd /d C:\Voltway\backend

echo Starting Voltway Flask backend...
echo.
echo Keep this window open while using Voltway.
echo.

python app.py

echo.
echo Voltway backend has stopped.
pause
