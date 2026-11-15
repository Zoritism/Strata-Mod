@echo off
setlocal
if "%~1"=="" goto usage
set "STRATA_OVERLAY_NODE=%~f1\node\node.exe"
if not exist "%STRATA_OVERLAY_NODE%" set "STRATA_OVERLAY_NODE=%~f1\app\node\node.exe"
if not exist "%STRATA_OVERLAY_NODE%" (
  echo Cannot find the Node runtime shipped with the selected Strata directory.
  exit /b 1
)
"%STRATA_OVERLAY_NODE%" "%~dp0scripts\overlay-install.mjs" %*
exit /b %errorlevel%
:usage
echo Usage: install.cmd "^<Strata directory^>" [--data-root "^<extension data directory^>"] [--dry-run]
echo Rollback: install.cmd "^<Strata directory^>" --rollback "^<backup directory^>" [--dry-run]
exit /b 1
