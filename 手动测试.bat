@echo off
chcp 65001 >nul
title 手动测试GitHub Actions
color 0D

echo.
echo ═══════════════════════════════════════════════════════
echo     手动测试 GitHub Actions 检测功能
echo ═══════════════════════════════════════════════════════
echo.

cd /d "%~dp0"

echo 📋 测试前检查:
echo.

REM 检查必要文件
if not exist "check-script.js" (
    echo ❌ 找不到 check-script.js
    pause
    exit /b 1
)

if not exist ".github\workflows\check-proxy.yml" (
    echo ❌ 找不到 .github\workflows\check-proxy.yml
    pause
    exit /b 1
)

echo ✅ 文件检查通过
echo.

echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo 本地测试 (模拟GitHub Actions环境)
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

set /p ACCOUNT_ID="请输入 CF_ACCOUNT_ID: "
set /p KV_ID="请输入 CF_KV_NAMESPACE_ID: "
set /p API_TOKEN="请输入 CF_API_TOKEN: "

if "%ACCOUNT_ID%"=="" (
    echo ❌ Account ID不能为空
    pause
    exit /b 1
)

if "%KV_ID%"=="" (
    echo ❌ KV Namespace ID不能为空
    pause
    exit /b 1
)

if "%API_TOKEN%"=="" (
    echo ❌ API Token不能为空
    pause
    exit /b 1
)

echo.
echo 🔄 正在运行检测脚本...
echo.

REM 设置环境变量并运行
set CF_ACCOUNT_ID=%ACCOUNT_ID%
set CF_KV_NAMESPACE_ID=%KV_ID%
set CF_API_TOKEN=%API_TOKEN%

node check-script.js

if errorlevel 1 (
    echo.
    echo ❌ 检测失败！
    echo.
    echo 可能的原因:
    echo 1. 凭证错误
    echo 2. KV数据库为空
    echo 3. 网络问题
    echo.
    pause
    exit /b 1
)

echo.
echo ═══════════════════════════════════════════════════════
echo              ✅ 测试完成！
echo ═══════════════════════════════════════════════════════
echo.
echo 📊 如果看到检测日志，说明配置正确
echo.
echo 📍 下一步:
echo 1. 确认Secrets已在GitHub配置
echo 2. 访问: https://github.com/luckyf1oat/proxyip-worker/actions
echo 3. 手动触发 "Run workflow" 测试
echo.
pause
