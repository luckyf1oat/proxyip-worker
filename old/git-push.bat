@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ======================================
echo   Git Push with Proxy
echo ======================================
echo.

echo [1] Setting proxy...
git config --global http.proxy socks5://127.0.0.1:7897
git config --global https.proxy socks5://127.0.0.1:7897
echo Done: socks5://127.0.0.1:7897
echo.

echo [2] Committing changes...
git add .
git commit -m "Update" 2>nul
echo.

echo [3] Pushing to GitHub...
git push -u origin main
echo.

if errorlevel 1 (
    echo Trying port 10808...
    git config --global http.proxy socks5://127.0.0.1:10808
    git config --global https.proxy socks5://127.0.0.1:10808
    git push -u origin main
)

echo.
echo Done!
echo.
pause
