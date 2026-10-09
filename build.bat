@echo off
setlocal

cd /d "%~dp0"

echo ============================================
echo    XBTerminal One-click Build
echo ============================================
echo.

echo [1/4] Closing running XBTerminal...
taskkill /f /im XBTerminal.exe >nul 2>&1

echo [2/4] Cleaning old dist...
if exist "dist" rmdir /s /q "dist"

if not exist "node_modules" (
    echo [dep] Installing dependencies...
    call npm install --registry=https://registry.npmmirror.com
    if errorlevel 1 (
        echo [FAILED] npm install error.
        pause
        exit /b 1
    )
)

echo [3/4] Building (first run downloads Electron, please wait)...
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
call npm run dist

if errorlevel 1 (
    echo.
    echo [FAILED] Build error, see log above.
    echo.
    pause
    exit /b 1
)

echo [4/4] Cleaning temp files...
if exist "dist\*.nsis.7z" del /q "dist\*.nsis.7z" >nul 2>&1
if exist "dist\*.__uninstaller.exe" del /q "dist\*.__uninstaller.exe" >nul 2>&1
if exist "dist\builder-debug.yml" del /q "dist\builder-debug.yml" >nul 2>&1

echo.
echo ============================================
echo    Build complete! Artifacts:
echo ============================================
dir /b "dist\*.exe"
echo.
echo Done. Press any key to exit...
pause >nul
