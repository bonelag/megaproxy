@echo off
rem ---------------------------------------------------------------------------
rem  deploy.bat - overwrite the globally installed @bitkyc08/opencodex with this
rem  working tree, so plain `ocx` runs your local changes in production mode.
rem
rem  Only src\, bin\ and gui\dist\ are replaced. node_modules\ lives at the
rem  package ROOT, so the installed dependencies and the bundled Bun runtime are
rem  never touched.
rem
rem  Usage:  deploy.bat [install-dir]
rem ---------------------------------------------------------------------------
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "SRC=%CD%"
set "DEST=%~1"
if "%DEST%"=="" set "DEST=C:\DEV\node22\node_modules\@bitkyc08\opencodex"

if not exist "%DEST%\package.json" (
  echo [deploy] ERROR: no package.json at "%DEST%".
  echo [deploy] That does not look like an installed opencodex. Pass the path explicitly.
  exit /b 1
)
echo [deploy] source: %SRC%
echo [deploy] target: %DEST%

rem --- The GUI is served from gui\dist as prebuilt static files; the proxy does not
rem     compile it at runtime. Skipping this step ships stale UI with fresh backend.
echo [deploy] building gui...
pushd gui
call bun run build || (echo [deploy] ERROR: gui build failed & popd & exit /b 1)
popd

rem --- Stop anything running from the install. Replacing files under a live proxy
rem     leaves it serving a half-old tree until restart.
echo [deploy] stopping any running proxy...
call ocx stop >nul 2>&1

rem --- /MIR so files deleted in the repo also disappear from the install; a plain copy
rem     would leave orphans that still resolve at import time.
echo [deploy] copying src...
robocopy "%SRC%\src" "%DEST%\src" /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo [deploy] ERROR: robocopy src failed & exit /b 1)

echo [deploy] copying bin...
robocopy "%SRC%\bin" "%DEST%\bin" /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo [deploy] ERROR: robocopy bin failed & exit /b 1)

echo [deploy] copying gui\dist...
robocopy "%SRC%\gui\dist" "%DEST%\gui\dist" /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (echo [deploy] ERROR: robocopy gui dist failed & exit /b 1)

rem --- package.json last: it carries the version and the bin map. Copied on its own so a
rem     failed src copy never leaves a version claiming code that was not installed.
copy /y "%SRC%\package.json" "%DEST%\package.json" >nul
if errorlevel 1 (echo [deploy] ERROR: could not copy package.json & exit /b 1)

echo.
echo [deploy] done. Verify with:
echo [deploy]   ocx --version
echo [deploy]   ocx start
echo [deploy]   ocx claude desktop apply
endlocal
