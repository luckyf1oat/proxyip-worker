// GitHub Actions检测脚本 - 从KV读取IP并检测
const CHECK_API = 'https://cf.090227.xyz/check?proxyip=';
const CHECK_TIMEOUT = 10000;
const RETRY = 1;
const BATCH = 30;

// 从环境变量获取配置
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const API_TOKEN = process.env.CF_API_TOKEN;

if (!ACCOUNT_ID || !KV_NAMESPACE_ID || !API_TOKEN) {
  console.error('❌ 缺少必要的环境变量');
  process.exit(1);
}

const KV_API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}`;
const headers = {
  'Authorization': `Bearer ${API_TOKEN}`,
  'Content-Type': 'application/json'
};

// 从KV读取数据
async function kvGet(key) {
  const url = `${KV_API}/values/${key}`;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  return await res.text();
}

// 写入KV
async function kvPut(key, value) {
  const url = `${KV_API}/values/${key}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: value
  });
  return res.ok;
}

// 检测单个IP
async function fetchCheck(ipPort) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT);

  try {
    const res = await fetch(CHECK_API + encodeURIComponent(ipPort), {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    clearTimeout(timeout);

    if (!res.ok) return { ok: false, reason: 'http_' + res.status };

    const data = await res.json();
    if (data.success === true || data.success === 'true') {
      return {
        ok: true,
        latency: parseInt(data.responseTime) || 9999,
        colo: data.colo || 'UNK'
      };
    }
    return { ok: false, reason: 'api_fail' };
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'network_error' };
  }
}

// 带重试的检测
async function checkIP(ipPort) {
  let lastReason = 'unknown';
  for (let i = 0; i <= RETRY; i++) {
    const r = await fetchCheck(ipPort);
    if (r.ok) return r;
    lastReason = r.reason;
  }
  return { ok: false, reason: lastReason };
}

// 批量检测
async function batchCheck(list) {
  const out = [];
  let valid = 0, invalid = 0;
  const startTime = Date.now();
  const MAX_TIME = 270000; // 4.5分钟

  console.log(`[*] 第一阶段(测速)开始: ${list.length} 个IP`);

  // 第一轮检测
  for (let i = 0; i < list.length; i += BATCH) {
    if (Date.now() - startTime > MAX_TIME) {
      console.log('[!] 达到时间限制');
      break;
    }

    const chunk = list.slice(i, i + BATCH);
    const results = await Promise.allSettled(chunk.map(async ip => {
      const r = await checkIP(ip.ipPort);
      if (r.ok) {
        return {
          ...ip,
          status: 'valid',
          checkLatency: r.latency,
          colo: r.colo || ip.colo,
          failReason: '',
          lastCheck: new Date().toISOString()
        };
      }
      return {
        ...ip,
        status: 'invalid',
        failReason: r.reason || 'unknown',
        lastCheck: new Date().toISOString()
      };
    }));

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      out.push(r.value);
      if (r.value.status === 'valid') {
        valid++;
        console.log(`    [+] 有效IP: ${r.value.ipPort.padEnd(21)} | 延迟: ${r.value.checkLatency}ms | 机房: ${r.value.colo}`);
      } else {
        invalid++;
      }
    }

    if (out.length % 50 === 0 || out.length === list.length) {
      console.log(`[*] 第一阶段进度: ${out.length}/${list.length} | 有效: ${valid} | 失效: ${invalid}`);
    }
  }

  // 第二轮重测
  const failed = out.filter(i => i.status === 'invalid');
  if (failed.length > 0 && Date.now() - startTime < MAX_TIME) {
    console.log(`[*] 第二阶段(失效重测)开始: ${failed.length} 个IP`);
    const RECHECK_BATCH = 15;
    let rechecked = 0;

    for (let i = 0; i < failed.length; i += RECHECK_BATCH) {
      if (Date.now() - startTime > MAX_TIME) break;

      const chunk = failed.slice(i, i + RECHECK_BATCH);
      await Promise.allSettled(chunk.map(async ip => {
        const r = await fetchCheck(ip.ipPort);
        if (r.ok) {
          ip.status = 'valid';
          ip.checkLatency = r.latency;
          ip.colo = r.colo || ip.colo;
          ip.failReason = '';
          ip.lastCheck = new Date().toISOString();
          valid++;
          invalid--;
          console.log(`    [+] 重测成功: ${ip.ipPort} | 延迟: ${ip.checkLatency}ms`);
        } else {
          ip.failReason = r.reason || ip.failReason;
        }
      }));

      rechecked += chunk.length;
      if (rechecked % 10 === 0 || rechecked === failed.length) {
        console.log(`[*] 重测进度: ${rechecked}/${failed.length}`);
      }
    }
  }

  console.log(`\n[+] 检测完成: 总计 ${out.length}, 有效 ${valid}, 失效 ${invalid}`);
  return out;
}

// 发送Telegram通知
async function sendTelegram(cfg, msg) {
  if (!cfg.tgToken || !cfg.tgChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.tgChatId,
        text: msg,
        parse_mode: 'HTML'
      })
    });
    console.log('✅ Telegram通知已发送');
  } catch (e) {
    console.log('⚠️ Telegram通知发送失败:', e.message);
  }
}

// 主函数
async function main() {
  console.log('=== GitHub Actions 检测开始 ===\n');

  // 读取配置和分组
  const configStr = await kvGet('config');
  const groupsStr = await kvGet('groups');
  const blacklistStr = await kvGet('blacklist');

  if (!groupsStr) {
    console.log('❌ 未找到分组配置');
    return;
  }

  const groups = JSON.parse(groupsStr);
  const blacklist = new Set(blacklistStr ? JSON.parse(blacklistStr) : []);

  console.log(`📊 分组数: ${groups.length}`);
  console.log(`🚫 黑名单: ${blacklist.size} 个IP\n`);

  // 收集所有IP
  const allMap = new Map();
  for (const g of groups) {
    const ipsStr = await kvGet('ips:' + g.id);
    if (!ipsStr) continue;

    let gips = JSON.parse(ipsStr);
    let filtered = gips.filter(ip => !blacklist.has(ip.ip));
    if (g.selectedAsns?.length) {
      filtered = filtered.filter(ip => g.selectedAsns.includes(ip.asn));
    }
    filtered.forEach(ip => {
      if (!allMap.has(ip.ipPort)) allMap.set(ip.ipPort, ip);
    });
  }

  const toCheck = [...allMap.values()];
  console.log(`📋 待检测IP总数: ${toCheck.length}\n`);

  if (!toCheck.length) {
    console.log('⚠️ 没有需要检测的IP');
    return;
  }

  // 检测
  const checked = await batchCheck(toCheck);
  const resultMap = new Map(checked.map(i => [i.ipPort, i]));
  const validSet = new Set(checked.filter(i => i.status === 'valid').map(i => i.ipPort));

  // 收集失效IP到回收站
  const trashStr = await kvGet('trash');
  const trash = trashStr ? JSON.parse(trashStr) : [];
  const invalidIPs = checked.filter(i => i.status === 'invalid');
  const now = new Date().toISOString();
  invalidIPs.forEach(ip => {
    trash.push({ ...ip, deletedAt: now, deletedReason: ip.failReason || 'unknown' });
  });
  await kvPut('trash', JSON.stringify(trash));
  console.log(`\n🗑️ 已移除 ${invalidIPs.length} 个失效IP到回收站`);

  // 更新各分组
  console.log('\n📦 更新分组数据...');
  for (const g of groups) {
    const ipsStr = await kvGet('ips:' + g.id);
    if (!ipsStr) continue;

    let gips = JSON.parse(ipsStr);
    gips = gips.map(ip => resultMap.get(ip.ipPort) || ip);

    // 移除失效IP
    const validIPs = gips.filter(i => i.status !== 'invalid');
    const removedCount = gips.length - validIPs.length;

    await kvPut('ips:' + g.id, JSON.stringify(validIPs));
    console.log(`  ✅ [${g.name}] 剩余: ${validIPs.length}, 移除: ${removedCount}`);
  }

  // 保存结果
  const failedIPs = checked.filter(i => i.status === 'invalid');
  const reasonMap = {};
  failedIPs.forEach(i => {
    const r = i.failReason || 'unknown';
    reasonMap[r] = (reasonMap[r] || 0) + 1;
  });

  const result = {
    time: new Date().toISOString(),
    total: toCheck.length,
    checked: checked.length,
    valid: validSet.size,
    invalid: checked.length - validSet.size,
    failReasons: reasonMap
  };

  await kvPut('last_result', JSON.stringify(result));
  console.log('\n=== 检测任务完成 ===');
  console.log(`⏰ 时间: ${result.time}`);
  console.log(`📊 总计: ${result.total}, 有效: ${result.valid}, 失效: ${result.invalid}`);

  // 发送Telegram通知
  const config = configStr ? JSON.parse(configStr) : {};
  if (config.tgToken && config.tgChatId) {
    const reasonText = Object.entries(reasonMap)
      .map(([k, v]) => `${k}:${v}`)
      .join(' | ');

    let msg = `🔍 <b>ProxyIP检测报告</b>\n`;
    msg += `⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`;
    msg += `📊 总:${result.total} ✅${result.valid} ❌${result.invalid}\n\n`;

    if (reasonText) {
      msg += `📋 失效原因: ${reasonText}\n\n`;
    }

    // 显示每个分组的详细信息
    for (const g of groups) {
      const ipsStr = await kvGet('ips:' + g.id);
      if (!ipsStr) continue;
      const gips = JSON.parse(ipsStr);

      // 获取该分组的有效IP（按延迟排序）
      const validInGroup = gips
        .filter(ip => ip.status === 'valid' && ip.checkLatency)
        .sort((a, b) => a.checkLatency - b.checkLatency);

      // 获取该分组移除的IP
      const removedInGroup = invalidIPs.filter(ip =>
        gips.some(g => g.ipPort === ip.ipPort)
      );

      msg += `📦<b>${g.name}</b>→${g.domain || 'N/A'}\n`;

      if (validInGroup.length > 0) {
        msg += `✅ 有效IP (${validInGroup.length}个):\n`;
        // 显示前5个最快的IP
        validInGroup.slice(0, 5).forEach(ip => {
          msg += `  ${ip.ipPort} (${ip.checkLatency}ms, ${ip.colo || 'UNK'})\n`;
        });
        if (validInGroup.length > 5) {
          msg += `  ...还有${validInGroup.length - 5}个\n`;
        }
      }

      if (removedInGroup.length > 0) {
        msg += `🗑️ 已移除${removedInGroup.length}个失效IP:\n`;
        // 显示前3个移除的IP
        removedInGroup.slice(0, 3).forEach(ip => {
          msg += `  ${ip.ipPort} (${ip.failReason || 'unknown'})\n`;
        });
        if (removedInGroup.length > 3) {
          msg += `  ...还有${removedInGroup.length - 3}个\n`;
        }
      }

      msg += `\n`;
    }

    await sendTelegram(config, msg);
  }
}

main().catch(err => {
  console.error('❌ 错误:', err);
  process.exit(1);
});
