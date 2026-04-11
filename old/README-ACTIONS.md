# GitHub Actions部署指南

## 与Python版本的区别

### 相同点
- ✅ 检测逻辑完全一致 (10秒超时, 1次重试)
- ✅ 使用相同的检测API: `https://cf.090227.xyz/check?proxyip=`
- ✅ 失效IP二次重测机制
- ✅ 支持批量并发检测
- ✅ 自动解析到Cloudflare DNS
- ✅ Telegram通知

### 不同点
- ❌ **不需要本地SOCKS5代理** (GitHub Actions直接访问)
- ❌ 不查询IP详细信息 (ipapi.is) - 只做存活检测
- ✅ 数据存储在Cloudflare KV (而非本地CSV)
- ✅ 自动化运行 (无需手动执行)

## 配置步骤

### 1. 获取Cloudflare凭证

#### 获取Account ID
1. 登录Cloudflare Dashboard
2. 在右侧找到你的Account ID (或在URL中查看)

#### 获取KV Namespace ID
```bash
wrangler kv namespace list
```
找到你的KV命名空间ID

#### 创建API Token
1. 访问 https://dash.cloudflare.com/profile/api-tokens
2. 点击"Create Token"
3. 选择"Create Custom Token"
4. 配置权限:
   - Account > Workers KV Storage > Edit
   - Zone > DNS > Edit (如果需要解析到Cloudflare DNS)
5. 复制生成的Token

### 2. 配置GitHub Secrets

在你的GitHub仓库中:
1. 进入 Settings > Secrets and variables > Actions
2. 添加以下Secrets:
   - `CF_ACCOUNT_ID`: 你的Cloudflare Account ID
   - `CF_KV_NAMESPACE_ID`: 你的KV Namespace ID
   - `CF_API_TOKEN`: 刚才创建的API Token

### 3. 上传文件到GitHub

```bash
cd c:\Users\Administrator\Desktop\proxyip-worker

# 初始化git仓库(如果还没有)
git init

# 添加文件
git add check-script.js .github/workflows/check-proxy.yml

# 提交
git commit -m "添加GitHub Actions检测脚本"

# 关联远程仓库并推送
git remote add origin https://github.com/你的用户名/你的仓库名.git
git branch -M main
git push -u origin main
```

### 4. 验证运行

1. 进入GitHub仓库的 Actions 标签页
2. 可以看到"ProxyIP检测"工作流
3. 点击"Run workflow"手动触发测试
4. 查看运行日志确认是否成功

## 运行时间说明

- 默认每4小时运行一次(UTC时间)
- 可以在 `.github/workflows/check-proxy.yml` 中修改 cron 表达式
- 也可以随时手动触发运行

## 时区转换参考

GitHub Actions使用UTC时间,如果你想在北京时间特定时间运行:
- 北京时间 00:00 = UTC 16:00 (前一天)
- 北京时间 06:00 = UTC 22:00 (前一天)
- 北京时间 12:00 = UTC 04:00
- 北京时间 18:00 = UTC 10:00

例如,每天北京时间 0点、6点、12点、18点运行:
```yaml
- cron: '0 16,22,4,10 * * *'
```

## 注意事项

1. GitHub Actions免费版每月有2000分钟限制
2. 每次检测大约需要5-10分钟(取决于IP数量)
3. 确保Cloudflare Workers中的数据已经初始化(分组、IP等)
4. 检测结果会写回KV存储,Web界面可以查看
