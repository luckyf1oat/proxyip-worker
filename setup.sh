#!/bin/bash
# GitHub Actions 快速配置脚本

echo "=== GitHub Actions 配置助手 ==="
echo ""

# 检查是否在正确的目录
if [ ! -f "worker.js" ]; then
    echo "❌ 错误: 请在 proxyip-worker 目录下运行此脚本"
    exit 1
fi

echo "📋 第一步: 获取Cloudflare凭证"
echo ""

# 获取Account ID
echo "1️⃣ 获取Account ID:"
echo "   方法1: 访问 https://dash.cloudflare.com"
echo "   方法2: 运行 'wrangler whoami'"
echo ""
read -p "请输入你的Account ID: " ACCOUNT_ID

# 获取KV Namespace ID
echo ""
echo "2️⃣ 获取KV Namespace ID:"
echo "   方法1: 查看 wrangler.toml 文件"
echo "   方法2: 运行 'wrangler kv namespace list'"
echo ""
read -p "请输入你的KV Namespace ID: " KV_ID

# 获取API Token
echo ""
echo "3️⃣ 创建API Token:"
echo "   访问: https://dash.cloudflare.com/profile/api-tokens"
echo "   权限: Workers KV Storage (Edit) + DNS (Edit)"
echo ""
read -p "请输入你的API Token: " API_TOKEN

# 验证输入
if [ -z "$ACCOUNT_ID" ] || [ -z "$KV_ID" ] || [ -z "$API_TOKEN" ]; then
    echo ""
    echo "❌ 错误: 所有字段都必须填写"
    exit 1
fi

echo ""
echo "✅ 凭证已收集"
echo ""

# 显示配置信息
echo "📝 请在GitHub仓库配置以下Secrets:"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Secret Name: CF_ACCOUNT_ID"
echo "Value: $ACCOUNT_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Secret Name: CF_KV_NAMESPACE_ID"
echo "Value: $KV_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Secret Name: CF_API_TOKEN"
echo "Value: $API_TOKEN"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 保存到临时文件
cat > .env.github << EOF
# GitHub Actions Secrets配置
# 请将以下内容添加到GitHub仓库的Secrets中

CF_ACCOUNT_ID=$ACCOUNT_ID
CF_KV_NAMESPACE_ID=$KV_ID
CF_API_TOKEN=$API_TOKEN
EOF

echo "✅ 配置已保存到 .env.github 文件"
echo ""

# 询问是否推送到GitHub
echo "📤 第二步: 推送代码到GitHub"
echo ""
read -p "是否现在推送到GitHub? (y/n): " PUSH_NOW

if [ "$PUSH_NOW" = "y" ] || [ "$PUSH_NOW" = "Y" ]; then
    echo ""
    read -p "请输入GitHub仓库地址 (例: https://github.com/username/repo.git): " REPO_URL

    if [ -z "$REPO_URL" ]; then
        echo "❌ 未输入仓库地址，跳过推送"
    else
        echo ""
        echo "🔄 正在推送..."

        # 初始化git (如果需要)
        if [ ! -d ".git" ]; then
            git init
            echo "✅ Git仓库已初始化"
        fi

        # 添加文件
        git add .
        git commit -m "添加GitHub Actions自动检测" 2>/dev/null || echo "ℹ️ 没有新的更改需要提交"

        # 设置远程仓库
        git remote remove origin 2>/dev/null
        git remote add origin "$REPO_URL"

        # 推送
        git branch -M main
        git push -u origin main

        if [ $? -eq 0 ]; then
            echo ""
            echo "✅ 代码已成功推送到GitHub!"
            echo ""
            echo "📍 下一步:"
            echo "   1. 访问你的GitHub仓库"
            echo "   2. 进入 Settings > Secrets and variables > Actions"
            echo "   3. 添加上面显示的3个Secrets"
            echo "   4. 进入 Actions 标签页手动触发测试"
        else
            echo ""
            echo "❌ 推送失败，请检查:"
            echo "   - 仓库地址是否正确"
            echo "   - 是否有推送权限"
            echo "   - 网络连接是否正常"
        fi
    fi
else
    echo ""
    echo "ℹ️ 跳过推送，你可以稍后手动推送:"
    echo ""
    echo "git init"
    echo "git add ."
    echo "git commit -m \"添加GitHub Actions自动检测\""
    echo "git remote add origin https://github.com/你的用户名/仓库名.git"
    echo "git branch -M main"
    echo "git push -u origin main"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ 配置完成!"
echo ""
echo "📚 详细文档: 配置指南.md"
echo "🔍 对比说明: 检测方式对比.md"
echo ""
echo "⚠️ 安全提示: 请删除 .env.github 文件，避免泄露凭证"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
