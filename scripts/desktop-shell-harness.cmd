@echo off
rem ---------------------------------------------------------------------------
rem dsh-overleaf desktop shell harness launcher.
rem
rem Runs scripts\desktop-shell-harness.mjs under Node; the harness then locates a
rem STOCK Electron runtime itself and re-execs there. That indirection exists
rem because:
rem   * the DeepSeek Harness desktop exe is a PACKAGED Electron app: it ignores an
rem     external script argument, starts its own app.asar and (single-instance
rem     lock) exits 0 - a silent false success. It is NOT a usable runtime;
rem   * this DSH session exports ELECTRON_RUN_AS_NODE=1, which turns any Electron
rem     binary into plain Node. Electron tests the variable's PRESENCE, so it must
rem     be deleted, not blanked. The pre-clearing value is forwarded to the report
rem     key environment.electronRunAsNodeBeforeClearing.
rem
rem Runtime resolution (done by the harness):
rem   %DSH_ELECTRON_EXE%  ->  <worktree|parent>\node_modules\electron\dist\electron.exe
rem   ->  %LOCALAPPDATA%\electron\Cache  ->  bounded scan (depth 3, 15 s budget)
rem
rem Usage:
rem   scripts\desktop-shell-harness.cmd
rem   scripts\desktop-shell-harness.cmd --negative-control
rem   scripts\desktop-shell-harness.cmd --timeout 60 --settle 25 --report <path>
rem   set DSH_ELECTRON_EXE=<stock electron.exe>   (explicit runtime override)
rem
rem Verdict: process exit code (0 pass, 1 assertion failed, 2 precondition,
rem 3 internal). Evidence: the JSON report, whose absolute path the harness prints
rem and stores in its own "report" key (default <worktree>\.tmp\desktop-shell-report.json).
rem ---------------------------------------------------------------------------
setlocal
set "TEMP=%~dp0..\.tmp\launcher-temp"
set "TMP=%TEMP%"
set "TMPDIR=%TEMP%"
if not exist "%TEMP%" mkdir "%TEMP%"
if defined ELECTRON_RUN_AS_NODE set "DSH_HARNESS_RUN_AS_NODE_BEFORE=%ELECTRON_RUN_AS_NODE%"
set "ELECTRON_RUN_AS_NODE="

set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "E:\software\nodejs\node.exe" set "NODE_EXE=E:\software\nodejs\node.exe"
if defined NODE_EXE goto run_node

rem No Node on PATH: the desktop exe can still play Node through ELECTRON_RUN_AS_NODE,
rem which is enough to start the harness (it re-execs into a real Electron runtime).
set "HARNESS_EXE=%DSH_DESKTOP_EXE%"
if not defined HARNESS_EXE set "HARNESS_EXE=E:\software\DeepSeek Harness\DeepSeek Harness.exe"
if not exist "%HARNESS_EXE%" (
  echo [harness] no Node runtime found and no desktop runtime at "%HARNESS_EXE%" 1>&2
  echo [harness] install Node or set DSH_DESKTOP_EXE 1>&2
  exit /b 2
)
set "ELECTRON_RUN_AS_NODE=1"
"%HARNESS_EXE%" "%~dp0desktop-shell-harness.mjs" %*
exit /b %ERRORLEVEL%

:run_node
"%NODE_EXE%" "%~dp0desktop-shell-harness.mjs" %*
exit /b %ERRORLEVEL%
