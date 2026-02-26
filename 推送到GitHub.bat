@echo off
chcp 65001 >nul
title 推送到GitHub
color 0B

echo.
echo ═══════════════════════════════════════════════════════
echo     推送代码到GitHub
echo ═══════════════════════════════════════════════════════
echo.

cd /d "%~dp0"

echo ✅ 代码已经提交到本地
echo.
echo 现在推送到GitHub...
echo.

git remote set-url origin https://github.com/luckyf1oat/proxyip-worker.git
git push -u origin main

if errorlevel 1 (
    echo.
    echo ❌ 推送失败！
    echo.
    echo 💡 解决方法:
    echo.
    echo 方法1: 使用GitHub Desktop (推荐)
    echo   1. 打开GitHub Desktop
    echo   2. File ^> Add Local Repository
    echo   3. 选择: c:\Users\Administrator\Desktop\proxyip-worker
    echo   4. 点击 Publish repository
    echo.
    echo 方法2: 使用Personal Access Token
    echo   1. 访问: https://github.com/settings/tokens
    echo   2. Generate new token (classic)
    echo   3. 勾选 repo 权限
    echo   4. 复制token
    echo   5. 推送时用token作为密码
    echo.
    pause
    exit /b 1
)

echo.
echo ═══════════════════════════════════════════════════════
echo              ✅ 推送成功！
echo ═══════════════════════════════════════════════════════
echo.
echo 📍 下一步: 配置GitHub Secrets
echo.
echo 1. 访问: https://github.com/luckyf1oat/proxyip-worker/settings/secrets/actions
echo 2. 点击 "New repository secret"
echo 3. 添加3个Secrets:
echo.
echo    Name: CF_ACCOUNT_ID
echo    Value: (你的Account ID)
echo.
echo    Name: CF_KV_NAMESPACE_ID
echo    Value: (你的KV Namespace ID)
echo.
echo    Name: CF_API_TOKEN
echo    Value: (你的API Token)
echo.
echo 4. 配置完成后访问: https://github.com/luckyf1oat/proxyip-worker/actions
echo 5. 点击 "ProxyIP检测" ^> "Run workflow" 测试运行
echo.
pause
