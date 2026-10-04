@echo off
chcp 65001 >nul
title GolosUZI - key generator
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Node.js не найден. Установите его с https://nodejs.org
    echo.
    pause
    exit /b 1
)
node tools\keygen.mjs wizard
echo.
pause
