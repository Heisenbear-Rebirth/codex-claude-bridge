@echo off
setlocal
pushd "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  pause
  popd
  exit /b 1
)
node "%~dp0bin\coop-service.mjs" stop
if errorlevel 1 (
  pause
  popd
  exit /b 1
)
popd
endlocal
