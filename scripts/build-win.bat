@echo off
setlocal enabledelayedexpansion

pushd "%~dp0\.."

if exist package-lock.json (
    call npm ci
) else (
    call npm install
)
if !errorlevel! neq 0 (
    echo npm install failed >&2
    exit /b 1
)

call npm run check
if !errorlevel! neq 0 (
    echo Syntax check failed >&2
    exit /b 1
)

call npm run dist:win
if !errorlevel! neq 0 (
    echo Build failed >&2
    exit /b 1
)

echo.
echo Windows app artifact:
dir /b dist\BisQue-iRODS-Uploader-win-x64.exe

popd
