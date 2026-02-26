@echo off
chcp 65001 >nul
echo.
echo ╔════════════════════════════════════════════════════════╗
echo ║     ProxyIP GitHub Actions 一键部署脚本                ║
echo ║     Workers地址: fxpip.5671234.xyz                     ║
echo ╚════════════════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

REM 检查文件
if not exist "check-script.js" (
    echo ❌ 错误: 找不到 check-script.js
    pause
    exit /b 1
)

if not exist ".github\workflows\check-proxy.yml" (
    echo ❌ 错误: 找不到 .github\workflows\check-proxy.yml
    pause
    exit /b 1
)

echo ✅ 文件检查通过
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo 第1步: 获取Cloudflare凭证
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.
echo 请按照以下步骤获取3个密钥:
echo.
echo 【密钥1: Account ID】
echo 1. 打开浏览器访问: https://dash.cloudflare.com
echo 2. 点击任意域名进入
echo 3. 右侧找到 "Account ID"，点击复制
echo.
set /p ACCOUNT_ID="请粘贴 Account ID: "

if "%ACCOUNT_ID%"=="" (
    echo ❌ Account ID不能为空
    pause
    exit /b 1
)

echo.
echo 【密钥2: KV Namespace ID】
echo 1. 打开浏览器访问: https://dash.cloudflare.com
echo 2. 左侧菜单: Workers ^& Pages ^> KV
echo 3. 找到你的KV命名空间，点击进入
echo 4. 右侧找到 "Namespace ID"，复制
echo.
set /p KV_ID="请粘贴 KV Namespace ID: "

if "%KV_ID%"=="" (
    echo ❌ KV Namespace ID不能为空
    pause
    exit /b 1
)

echo.
echo 【密钥3: API Token】
echo 1. 打开浏览器访问: https://dash.cloudflare.com/profile/api-tokens
echo 2. 点击 "Create Token"
echo 3. 点击 "Create Custom Token"
echo 4. 配置权限:
echo    - Account ^> Workers KV Storage ^> Edit
echo    - Zone ^> DNS ^> Edit
echo 5. 点击 "Continue to summary" ^> "Create Token"
echo 6. 立即复制Token (只显示一次!)
echo.
set /p API_TOKEN="请粘贴 API Token: "

if "%API_TOKEN%"=="" (
    echo ❌ API Token不能为空
    pause
    exit /b 1
)

echo.
echo ✅ 凭证收集完成
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo 第2步: 保存配置信息
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

REM 保存到文件
(
echo # GitHub Actions Secrets 配置
echo # 请将以下内容添加到GitHub仓库的Secrets中
echo.
echo CF_ACCOUNT_ID=%ACCOUNT_ID%
echo CF_KV_NAMESPACE_ID=%KV_ID%
echo CF_API_TOKEN=%API_TOKEN%
) > secrets.txt

echo ✅ 配置已保存到 secrets.txt
echo.
echo 📋 请在GitHub配置以下Secrets:
echo.
echo ┌─────────────────────────────────────────────────────┐
echo │ Secret Name: CF_ACCOUNT_ID                          │
echo │ Value: %ACCOUNT_ID%
echo └─────────────────────────────────────────────────────┘
echo.
echo ┌─────────────────────────────────────────────────────┐
echo │ Secret Name: CF_KV_NAMESPACE_ID                     │
echo │ Value: %KV_ID%
echo └─────────────────────────────────────────────────────┘
echo.
echo ┌─────────────────────────────────────────────────────┐
echo │ Secret Name: CF_API_TOKEN                           │
echo │ Value: %API_TOKEN%
echo └─────────────────────────────────────────────────────┘
echo.
pause
echo.

echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo 第3步: 推送代码到GitHub
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

set /p REPO_URL="请输入GitHub仓库地址 (例: https://github.com/username/repo.git): "

if "%REPO_URL%"=="" (
    echo ❌ 仓库地址不能为空
    pause
    exit /b 1
)

echo.
echo 🔄 正在初始化Git仓库...

REM 检查是否已经是git仓库
if not exist ".git" (
    git init
    if errorlevel 1 (
        echo ❌ Git初始化失败，请确保已安装Git
        pause
        exit /b 1
    )
    echo ✅ Git仓库已初始化
) else (
    echo ℹ️ Git仓库已存在
)

echo.
echo 🔄 正在添加文件...
git add .
if errorlevel 1 (
    echo ❌ 添加文件失败
    pause
    exit /b 1
)
echo ✅ 文件已添加

echo.
echo 🔄 正在提交...
git commit -m "添加GitHub Actions自动检测" 2>nul
if errorlevel 1 (
    echo ℹ️ 没有新的更改需要提交
) else (
    echo ✅ 提交成功
)

echo.
echo 🔄 正在设置远程仓库...
git remote remove origin 2>nul
git remote add origin "%REPO_URL%"
if errorlevel 1 (
    echo ❌ 设置远程仓库失败
    pause
    exit /b 1
)
echo ✅ 远程仓库已设置

echo.
echo 🔄 正在推送到GitHub...
git branch -M main
git push -u origin main

if errorlevel 1 (
    echo.
    echo ❌ 推送失败，可能的原因:
    echo    1. 仓库地址错误
    echo    2. 没有推送权限
    echo    3. 网络连接问题
    echo    4. 需要先在GitHub创建空仓库
    echo.
    echo 💡 解决方法:
    echo    1. 确认仓库地址正确
    echo    2. 在GitHub创建空仓库 (不要初始化README)
    echo    3. 使用 git push -u origin main --force (如果确定要覆盖)
    echo.
    pause
    exit /b 1
)

echo.
echo ✅ 代码已成功推送到GitHub!
echo.

echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo 第4步: 配置GitHub Secrets
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.
echo 📍 下一步操作:
echo.
echo 1. 打开你的GitHub仓库页面
echo 2. 点击 Settings (设置)
echo 3. 左侧菜单: Secrets and variables ^> Actions
echo 4. 点击 "New repository secret"
echo 5. 添加上面显示的3个Secrets (已保存在 secrets.txt)
echo.
echo 配置完成后:
echo 6. 点击 Actions 标签页
echo 7. 点击 "ProxyIP检测" 工作流
echo 8. 点击 "Run workflow" 手动触发测试
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ✅ 部署完成!
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.
echo 📊 系统将会:
echo    ✅ 每4小时自动检测IP
echo    ✅ 更新 fxpip.5671234.xyz 的数据
echo    ✅ 自动解析最优IP到DNS
echo    ✅ 发送Telegram通知 (如果配置了)
echo.
echo 📚 相关文档:
echo    - secrets.txt (Secrets配置)
echo    - 部署步骤-简化版.md (详细说明)
echo    - 系统架构说明.md (架构图解)
echo.
echo ⚠️ 安全提示: 请妥善保管 secrets.txt，不要泄露给他人
echo.
pause
