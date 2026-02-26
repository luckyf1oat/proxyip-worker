@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ========================================
echo   使用代理推送到GitHub
echo ========================================
echo.

echo 配置代理...
git config --global http.proxy socks5://127.0.0.1:7897
git config --global https.proxy socks5://127.0.0.1:7897
echo 代理已设置: socks5://127.0.0.1:7897
echo.

echo 提交修改...
git add .
git commit -m "更新代码" 2>nul
echo.

echo 推送到GitHub...
git push -u origin main

if errorlevel 1 (
    echo.
    echo 推送失败，尝试10808端口...
    git config --global http.proxy socks5://127.0.0.1:10808
    git config --global https.proxy socks5://127.0.0.1:10808
    git push -u origin main
)

echo.
echo 完成！
pause
