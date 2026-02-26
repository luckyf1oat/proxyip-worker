@echo off
chcp 65001 >nul
title 超简单配置
color 0B

echo.
echo ═══════════════════════════════════════════════════════
echo     GitHub Actions 超简单配置 (3步完成)
echo ═══════════════════════════════════════════════════════
echo.

cd /d "%~dp0"

echo 📋 需要准备的信息:
echo.
echo 1. Cloudflare Account ID
echo 2. KV Namespace ID
echo 3. API Token
echo 4. GitHub用户名
echo.
pause
echo.

REM 收集信息
set /p ACCOUNT_ID="Account ID: "
set /p KV_ID="KV Namespace ID: "
set /p API_TOKEN="API Token: "
set /p GITHUB_USER="GitHub用户名: "
set /p REPO_NAME="仓库名 (直接回车用默认 proxyip-worker): "
if "%REPO_NAME%"=="" set REPO_NAME=proxyip-worker

echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo 第1步: 推送代码到GitHub
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

if not exist ".git" git init
git add .
git commit -m "添加Actions" 2>nul
git remote remove origin 2>nul
git remote add origin https://github.com/%GITHUB_USER%/%REPO_NAME%.git
git branch -M main
git push -u origin main

if errorlevel 1 (
    echo.
    echo ⚠️ 推送失败！请先创建GitHub仓库:
    echo.
    echo 1. 访问: https://github.com/new
    echo 2. 仓库名: %REPO_NAME%
    echo 3. 选择 Public
    echo 4. 不要勾选 "Add a README file"
    echo 5. 点击 Create repository
    echo 6. 创建后按任意键继续...
    echo.
    pause
    git push -u origin main
)

echo ✅ 代码已推送
echo.

REM 生成配置说明
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo 第2步: 配置GitHub Secrets
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.
echo 请打开浏览器访问:
echo https://github.com/%GITHUB_USER%/%REPO_NAME%/settings/secrets/actions
echo.
echo 点击 "New repository secret"，添加以下3个:
echo.

REM 保存到文件并显示
(
echo ┌─────────────────────────────────────────────────────┐
echo │ Secret 1                                            │
echo ├─────────────────────────────────────────────────────┤
echo │ Name:  CF_ACCOUNT_ID                                │
echo │ Value: %ACCOUNT_ID%
echo └─────────────────────────────────────────────────────┘
echo.
echo ┌─────────────────────────────────────────────────────┐
echo │ Secret 2                                            │
echo ├─────────────────────────────────────────────────────┤
echo │ Name:  CF_KV_NAMESPACE_ID                           │
echo │ Value: %KV_ID%
echo └─────────────────────────────────────────────────────┘
echo.
echo ┌─────────────────────────────────────────────────────┐
echo │ Secret 3                                            │
echo ├─────────────────────────────────────────────────────┤
echo │ Name:  CF_API_TOKEN                                 │
echo │ Value: %API_TOKEN%
echo └─────────────────────────────────────────────────────┘
) | tee secrets-config.txt

echo.
echo ✅ 配置信息已保存到 secrets-config.txt
echo.
echo 配置完成后按任意键继续...
pause >nul
echo.

echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo 第3步: 测试运行
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.
echo 请打开浏览器访问:
echo https://github.com/%GITHUB_USER%/%REPO_NAME%/actions
echo.
echo 操作步骤:
echo 1. 点击左侧 "ProxyIP检测"
echo 2. 点击右侧 "Run workflow" 按钮
echo 3. 点击绿色 "Run workflow" 确认
echo 4. 等待运行完成，查看日志
echo.

echo ═══════════════════════════════════════════════════════
echo                  🎉 配置完成！
echo ═══════════════════════════════════════════════════════
echo.
echo 📊 系统将每4小时自动检测IP
echo 🌐 Workers网站: https://fxpip.5671234.xyz
echo 📁 配置文件: secrets-config.txt
echo.
pause
