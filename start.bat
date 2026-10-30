@echo off
setlocal
title LiteForeFlow
cd /d "%~dp0"

rem ---- 1. Node.js: use the one on this computer, else our private copy in "runtime", else offer to download it ----
set "LOCALNODE=%~dp0runtime\node"
call :nodeok
if not errorlevel 1 goto nodeready
if exist "%LOCALNODE%\node.exe" set "PATH=%LOCALNODE%;%PATH%"
call :nodeok
if not errorlevel 1 goto nodeready

echo.
echo   LiteForeFlow needs Node.js ^(the free engine it runs on^). It is missing or too old on this computer.
echo.
echo   It can download its own private copy ^(about 30 MB, one time^) into the "runtime" folder here.
echo   No administrator rights needed and nothing else on your computer is changed.
echo.
choice /c YN /n /m "  Download it now? [Y = yes, N = no] "
if errorlevel 2 (
  echo.
  echo   OK. Install the LTS version from https://nodejs.org yourself, then double-click start.bat again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get-node.ps1" -Dest "%~dp0runtime"
if errorlevel 1 (
  pause
  exit /b 1
)
set "PATH=%LOCALNODE%;%PATH%"
call :nodeok
if errorlevel 1 (
  echo.
  echo   The downloaded Node.js does not work on this computer. Install the LTS from https://nodejs.org instead.
  pause
  exit /b 1
)

:nodeready
rem ---- 2. LiteForeFlow's own packages: installed the first time, repaired when something is missing ----
node scripts\preflight.cjs --deps
if errorlevel 1 (
  echo.
  echo   First start: installing LiteForeFlow. This takes about a minute, needs internet,
  echo   and only happens once.
  echo.
  call npm install --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    echo.
    echo   The install did not finish. Check your internet connection and double-click start.bat again.
    pause
    exit /b 1
  )
)

rem ---- 3. Start ----
if not defined LITEFOREFLOW_OPEN set LITEFOREFLOW_OPEN=1
node --max-semi-space-size=2 --max-old-space-size=192 server\src\index.js
echo.
echo   LiteForeFlow has stopped. You can close this window.
pause
exit /b 0

:nodeok
where node >nul 2>nul || exit /b 1
where npm >nul 2>nul || exit /b 1
node scripts\preflight.cjs >nul 2>nul
exit /b %errorlevel%
