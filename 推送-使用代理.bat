@echo off
chcp 65001 >nul
title 使用代理推送到GitHub
color 0B

echo.
echo ═══════════════════════════════════════════════════════
echo     使用SOCKS5代理推送到GitHub
echo ═══════════════════════════════════════════════════════
echo.

cd /d "%~dp0"

echo [1/3] 配置Git代理
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

REM 尝试7897端口
git config --global http.proxy socks5://127.0.0.1:7897
git config --global https.proxy socks5://127.0.0.1:7897
echo ✅ 代理已设置为 socks5://127.0.0.1:7897
echo.

echo [2/3] 提交本地修改
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

git add .
git commit -m "更新代码" 2>nul
if errorlevel 1 (
    echo ℹ️ 没有新的修改需要提交
) else (
    echo ✅ 修改已提交
)
echo.

echo [3/3] 推送到GitHub
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

git push -u origin main

if errorlevel 1 (
    echo.
    echo ❌ 推送失败！尝试使用10808端口...
    echo.

    git config --global http.proxy socks5://127.0.0.1:10808
    git config --global https.proxy socks5://127.0.0.1:10808
    echo ✅ 代理已切换为 socks5://127.0.0.1:10808
    echo.

    git push -u origin main

    if errorlevel 1 (
        echo.
        echo ❌ 推送仍然失败！
        echo.
        echo 💡 可能的原因:
        echo 1. 代理未运行
        echo 2. 网络连接问题
        echo 3. GitHub认证失败
        echo.
        pause
        exit /b 1
    )
)

echo.
echo ═══════════════════════════════════════════════════════
echo              ✅ 推送成功！
echo ═══════════════════════════════════════════════════════
echo.
echo 📍 代码已推送到: https://github.com/luckyf1oat/proxyip-worker
echo.
echo 💡 提示: Git代理配置已保存，下次推送会自动使用
echo.
pause
