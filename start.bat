@echo off
setlocal
cd /d "%~dp0"
title DAIFUGO server

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Node.js was not found.
  echo      Please install Node.js LTS from https://nodejs.org/ and run start.bat again.
  echo.
  start "" "https://nodejs.org/"
  pause
  exit /b 1
)

node "%~dp0server\server.js"
echo.
echo  Server stopped.
pause
