@echo off
setlocal
pushd "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Node.js 22.13 or newer is required.
  pause
  popd
  exit /b 1
)
node "%~dp0bin\coop-service.mjs" start
if errorlevel 1 (
  pause
  popd
  exit /b 1
)
popd
endlocal
