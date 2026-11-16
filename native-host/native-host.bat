@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo node not found > "%~dp0bat-log.txt"
  exit /b 1
)
node "%~dp0native-host.js" 2>> "%~dp0bat-log.txt"
