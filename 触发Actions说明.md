# Workers触发GitHub Actions功能说明

## ✅ 新增功能

现在可以在Workers Web界面直接触发GitHub Actions检测！

### 使用方法

1. **配置GitHub Token**
   - 访问: https://github.com/settings/tokens
   - 点击 "Generate new token (classic)"
   - 勾选权限: `repo` (完整权限) 或 `repo > actions` (write)
   - 生成并复制Token

2. **在Workers配置**
   - 登录 https://fxpip.5671234.xyz
   - 进入"设置"页面
   - 填写:
     - GitHub Token: `ghp_xxxxx`
     - 仓库: `luckyf1oat/proxyip-worker`
   - 点击"保存设置"

3. **触发检测**
   - 进入"概览"页面
   - 点击 "🚀 GitHub Actions检测 (推荐)" 按钮
   - 等待几秒，GitHub Actions开始运行

4. **查看结果**
   - 访问: https://github.com/luckyf1oat/proxyip-worker/actions
   - 或等待检测完成后刷新Workers页面

---

## 🎯 两种检测方式对比

### Workers检测 (快速)
- ⚡ 立即执行
- ⏱️ 30秒CPU限制
- 📊 适合快速测试少量IP
- 🔧 点击 "🔍 Workers检测 (快速)" 按钮

### GitHub Actions检测 (推荐)
- 🚀 无时间限制
- 🤖 自动每4小时运行
- 📊 适合大批量IP
- 🔧 点击 "🚀 GitHub Actions检测 (推荐)" 按钮

---

## 📋 关于502错误

你的测试结果显示:
```json
{
  "total": 66,
  "valid": 56,
  "invalid": 10,
  "failReasons": {
    "http_502": 10
  }
}
```

### 502错误原因

1. **检测API临时故障**
   - `https://cf.090227.xyz/check` 可能暂时不可用
   - 或者该API对某些IP返回502

2. **IP本身问题**
   - 代理IP可能已失效
   - 或者代理服务器返回502

### 解决方法

**方法1: 重新检测**
- 502可能是临时的
- 再次运行检测，看是否仍然502

**方法2: 检查检测API**
```bash
curl "https://cf.090227.xyz/check?proxyip=失效的IP:端口"
```

**方法3: 增加重试次数**
编辑 `check-script.js`:
```javascript
const RETRY = 2;  // 从1改为2，共3次尝试
```

**方法4: 添加502重试逻辑**
修改 `fetchCheck` 函数，对502错误特殊处理。

---

## 🔧 完整配置步骤

### 1. 创建GitHub Token

访问: https://github.com/settings/tokens/new

配置:
- Note: `ProxyIP Workers Trigger`
- Expiration: `No expiration` 或自定义
- 权限: 勾选 `repo`

点击 "Generate token"，复制Token

### 2. 配置Workers

登录: https://fxpip.5671234.xyz

进入"设置":
- GitHub Token: 粘贴刚才的Token
- 仓库: `luckyf1oat/proxyip-worker`
- 保存

### 3. 测试触发

进入"概览":
- 点击 "🚀 GitHub Actions检测"
- 提示"GitHub Actions已触发"

### 4. 验证运行

访问: https://github.com/luckyf1oat/proxyip-worker/actions

应该看到新的运行记录

---

## ❓ 常见问题

### Q: 触发失败，提示"未配置GitHub Token"
A: 进入"设置"页面，填写GitHub Token和仓库名

### Q: 触发失败，提示"触发失败:403"
A: Token权限不足，需要 `repo` 权限

### Q: 触发失败，提示"触发失败:404"
A: 仓库名错误，格式应为 `用户名/仓库名`

### Q: 触发成功但Actions没运行
A: 检查 `.github/workflows/check-proxy.yml` 是否有 `workflow_dispatch` 触发器

### Q: 502错误怎么办?
A: 这是检测API或代理IP的问题，可以:
1. 重新检测
2. 增加重试次数
3. 检查IP是否真的有效

---

## 📊 推荐使用流程

```
1. 上传新IP到Workers
   ↓
2. 点击"Workers检测"快速验证
   ↓
3. 点击"GitHub Actions检测"完整检测
   ↓
4. 等待检测完成 (5-10分钟)
   ↓
5. 刷新页面查看结果
   ↓
6. 之后每4小时自动检测
```

---

## 🎉 总结

现在你有3种方式触发检测:

1. **Workers Web界面** - 快速测试
2. **GitHub Actions Web界面** - 手动触发
3. **自动定时** - 每4小时运行

完美的灵活性！
