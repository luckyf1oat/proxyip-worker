@echo off
chcp 65001 >nul
title 修复推送问题
color 0E

echo.
echo ═══════════════════════════════════════════════════════
echo     修复Git推送问题
echo ═══════════════════════════════════════════════════════
echo.

cd /d "%~dp0"

echo [1/3] 提交代码到本地仓库
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

git add .
git commit -m "添加GitHub Actions自动检测"

if errorlevel 1 (
    echo ❌ 提交失败
    pause
    exit /b 1
)

echo ✅ 代码已提交
echo.

echo [2/3] 设置远程仓库
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

set /p GITHUB_USER="请输入GitHub用户名: "
set /p REPO_NAME="请输入仓库名 (默认: proxyip-worker): "
if "%REPO_NAME%"=="" set REPO_NAME=proxyip-worker

git remote remove origin 2>nul
git remote add origin https://github.com/%GITHUB_USER%/%REPO_NAME%.git

echo ✅ 远程仓库已设置
echo.

echo [3/3] 推送到GitHub
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

git branch -M main
git push -u origin main --force

if errorlevel 1 (
    echo.
    echo ❌ 推送失败！
    echo.
    echo 可能的原因:
    echo 1. 仓库地址错误
    echo 2. 没有推送权限
    echo 3. 网络问题
    echo.
    echo 请检查:
    echo - 仓库地址: https://github.com/%GITHUB_USER%/%REPO_NAME%
    echo - 是否已登录GitHub
    echo.
    pause
    exit /b 1
)

echo.
echo ═══════════════════════════════════════════════════════
echo              ✅ 推送成功！
echo ═══════════════════════════════════════════════════════
echo.
echo 📍 下一步:
echo 1. 访问: https://github.com/%GITHUB_USER%/%REPO_NAME%/settings/secrets/actions
echo 2. 添加3个Secrets (参考 secrets-config.txt)
echo 3. 访问: https://github.com/%GITHUB_USER%/%REPO_NAME%/actions
echo 4. 手动触发运行测试
echo.
pause
