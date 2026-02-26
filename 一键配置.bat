@echo off
chcp 65001 >nul
title GitHub Actions 一键配置
color 0A

echo.
echo ╔═══════════════════════════════════════════════════════════╗
echo ║          GitHub Actions 一键配置脚本                      ║
echo ║          自动部署到GitHub并配置Secrets                    ║
echo ╚═══════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

REM 步骤1: 收集信息
echo [1/4] 收集配置信息
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

set /p ACCOUNT_ID="请输入 Cloudflare Account ID: "
if "%ACCOUNT_ID%"=="" (
    echo ❌ Account ID不能为空
    pause
    exit /b 1
)

set /p KV_ID="请输入 KV Namespace ID: "
if "%KV_ID%"=="" (
    echo ❌ KV Namespace ID不能为空
    pause
    exit /b 1
)

set /p API_TOKEN="请输入 API Token: "
if "%API_TOKEN%"=="" (
    echo ❌ API Token不能为空
    pause
    exit /b 1
)

set /p GITHUB_USER="请输入 GitHub用户名: "
if "%GITHUB_USER%"=="" (
    echo ❌ GitHub用户名不能为空
    pause
    exit /b 1
)

set /p REPO_NAME="请输入仓库名 (默认: proxyip-worker): "
if "%REPO_NAME%"=="" set REPO_NAME=proxyip-worker

echo.
echo ✅ 信息收集完成
echo.

REM 步骤2: 初始化Git
echo [2/4] 初始化Git仓库
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

if not exist ".git" (
    git init
    if errorlevel 1 (
        echo ❌ Git初始化失败
        pause
        exit /b 1
    )
    echo ✅ Git仓库已初始化
) else (
    echo ℹ️ Git仓库已存在
)

git add .
git commit -m "添加GitHub Actions自动检测" 2>nul
echo ✅ 代码已提交
echo.

REM 步骤3: 推送到GitHub
echo [3/4] 推送到GitHub
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

git remote remove origin 2>nul
git remote add origin https://github.com/%GITHUB_USER%/%REPO_NAME%.git
git branch -M main

echo 正在推送代码...
git push -u origin main 2>nul

if errorlevel 1 (
    echo.
    echo ⚠️ 推送失败，可能仓库不存在
    echo.
    echo 正在尝试创建仓库...

    REM 检查是否安装了gh CLI
    where gh >nul 2>nul
    if errorlevel 1 (
        echo.
        echo ❌ 未安装 GitHub CLI (gh)
        echo.
        echo 请手动操作:
        echo 1. 访问 https://github.com/new
        echo 2. 仓库名: %REPO_NAME%
        echo 3. 创建后运行: git push -u origin main
        echo.
        pause
        exit /b 1
    )

    gh repo create %REPO_NAME% --public --source=. --remote=origin --push
    if errorlevel 1 (
        echo ❌ 创建仓库失败
        pause
        exit /b 1
    )
    echo ✅ 仓库已创建并推送
) else (
    echo ✅ 代码已推送
)

echo.

REM 步骤4: 配置Secrets
echo [4/4] 配置GitHub Secrets
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

REM 检查是否安装了gh CLI
where gh >nul 2>nul
if errorlevel 1 (
    echo ⚠️ 未安装 GitHub CLI，需要手动配置Secrets
    echo.
    echo 请访问: https://github.com/%GITHUB_USER%/%REPO_NAME%/settings/secrets/actions
    echo.
    echo 添加以下3个Secrets:
    echo.
    echo Name: CF_ACCOUNT_ID
    echo Value: %ACCOUNT_ID%
    echo.
    echo Name: CF_KV_NAMESPACE_ID
    echo Value: %KV_ID%
    echo.
    echo Name: CF_API_TOKEN
    echo Value: %API_TOKEN%
    echo.

    REM 保存到文件
    (
    echo CF_ACCOUNT_ID=%ACCOUNT_ID%
    echo CF_KV_NAMESPACE_ID=%KV_ID%
    echo CF_API_TOKEN=%API_TOKEN%
    ) > secrets.txt

    echo ✅ Secrets已保存到 secrets.txt
    echo.
    pause
) else (
    echo 正在配置Secrets...

    echo %ACCOUNT_ID% | gh secret set CF_ACCOUNT_ID
    echo %KV_ID% | gh secret set CF_KV_NAMESPACE_ID
    echo %API_TOKEN% | gh secret set CF_API_TOKEN

    if errorlevel 1 (
        echo ❌ 配置Secrets失败
        pause
        exit /b 1
    )

    echo ✅ Secrets配置完成
    echo.
)

REM 完成
echo.
echo ╔═══════════════════════════════════════════════════════════╗
echo ║                    🎉 配置完成！                          ║
echo ╚═══════════════════════════════════════════════════════════╝
echo.
echo 📊 GitHub Actions 将会:
echo    ✅ 每4小时自动检测IP
echo    ✅ 更新KV数据库
echo    ✅ 自动解析DNS
echo.
echo 📍 查看运行状态:
echo    https://github.com/%GITHUB_USER%/%REPO_NAME%/actions
echo.
echo 🌐 Workers网站:
echo    https://fxpip.5671234.xyz
echo.
echo 💡 手动触发检测:
echo    访问Actions页面 ^> ProxyIP检测 ^> Run workflow
echo.
pause
