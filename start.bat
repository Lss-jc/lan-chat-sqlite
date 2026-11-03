@echo off
rem ===================================================================
rem  LAN Chat - one click launcher (Windows)
rem  Double click this file to start the server.
rem  Requirements: Node.js 22 or newer (node:sqlite is built in).
rem ===================================================================
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 22+ first.
  echo         https://nodejs.org
  pause
  exit /b 1
)

echo Starting chat server ... (press Ctrl+C to stop)
node server.js
pause
