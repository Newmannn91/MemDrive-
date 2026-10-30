@echo off
REM MemDrive setup launcher (Windows).
REM Thin shell only: all logic lives in the Node wizard
REM Run the Node wizard with node dist\index.js setup, by double-clicking this file,
REM or from a command prompt:  setup.bat
REM
REM This file MUST use CRLF line endings. cmd.exe does not parse
REM LF-only batch files reliably: an LF-only copy fails at once
REM with "install was unexpected at this time" before running
REM anything. Do not save this file with Unix line endings.
REM
REM Style note: goto labels instead of parenthesized if-blocks.
REM Parenthesized blocks plus quoted parentheses or an inline
REM node -e check break cmd.exe parsing. Keep this file free of
REM parenthesized blocks and of parentheses inside quoted text.
setlocal
cd /d "%~dp0"

REM 1. Node.js must be installed. MemDrive needs Node 18 or newer.
where node >nul 2>nul
if errorlevel 1 goto :missing_node
node -v
for /f "tokens=1 delims=v." %%a in ('node -v') do set "NODEMAJOR=%%a"
if not defined NODEMAJOR goto :old_node
if %NODEMAJOR% LSS 18 goto :old_node

REM 2. Install dependencies and build. Failures are shown plainly
REM and stop the script; nothing is written to any app config yet.
echo.
echo Installing dependencies...
call npm.cmd install
if errorlevel 1 goto :install_failed
echo.
echo Building...
call npm.cmd run build
if errorlevel 1 goto :build_failed

REM 3. Run the wizard.
echo.
node "%~dp0dist\index.js" setup
if errorlevel 1 exit /b 1
exit /b 0

:missing_node
echo.
echo Node.js is not installed on this computer.
echo MemDrive needs Node.js 18 or newer. Download it from the
echo official site, a free download, install it, then run setup.bat again.
echo.
set /p OPENBROWSER=Open https://nodejs.org in your browser now? Y/N:
if /i "%OPENBROWSER%"=="Y" start "" "https://nodejs.org"
echo Setup stopped. Nothing was changed.
exit /b 1

:old_node
echo.
echo Node.js 18 or newer is required. Please update Node.js, then run setup.bat again.
echo Setup stopped. Nothing was changed.
exit /b 1

:install_failed
echo.
echo npm install failed. Check the error above and try again.
echo Setup stopped. Nothing was changed.
exit /b 1

:build_failed
echo.
echo npm run build failed. Check the error above and try again.
echo Setup stopped. Nothing was changed.
exit /b 1
