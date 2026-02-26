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

// 解析到Cloudflare DNS
async function resolveToCloudflare(g, ips) {
  if (!g.cfToken || !g.zoneId || !g.domain) {
    throw new Error(`[${g.id}]缺少CF配置`);
  }
  const content = '"' + ips.map(i => i.ipPort).join(',') + '"';
  const headers = {
    'Authorization': `Bearer ${g.cfToken}`,
    'Content-Type': 'application/json'
  };
  const base = `https://api.cloudflare.com/client/v4/zones/${g.zoneId}/dns_records`;

  // 查询现有记录
  const listRes = await fetch(`${base}?name=${g.domain}&type=TXT`, { headers });
  const listData = await listRes.json();
  if (!listData.success) {
    throw new Error('CF查询失败:' + JSON.stringify(listData.errors));
  }

  const existing = listData.result?.[0];
  const body = JSON.stringify({ type: 'TXT', name: g.domain, content, ttl: 60 });

  // 更新或创建记录
  const updateRes = existing
    ? await fetch(`${base}/${existing.id}`, { method: 'PUT', headers, body })
    : await fetch(base, { method: 'POST', headers, body });

  const updateData = await updateRes.json();
  if (!updateData.success) {
    throw new Error('CF写入失败:' + JSON.stringify(updateData.errors));
  }
  return true;
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

  // 更新各分组并解析DNS
  console.log('\n📦 更新分组数据...');
  const groupResults = [];
  for (const g of groups) {
    const ipsStr = await kvGet('ips:' + g.id);
    if (!ipsStr) continue;

    let gips = JSON.parse(ipsStr);
    gips = gips.map(ip => resultMap.get(ip.ipPort) || ip);

    // 移除失效IP
    const validIPs = gips.filter(i => i.status !== 'invalid');
    const removedCount = gips.length - validIPs.length;

    await kvPut('ips:' + g.id, JSON.stringify(validIPs));

    // 选择延迟最低的IP进行DNS解析
    let gv = validIPs.filter(i => i.status === 'valid');
    if (g.selectedAsns?.length) {
      gv = gv.filter(i => g.selectedAsns.includes(i.asn));
    }
    const sorted = [...gv].sort((a, b) => a.checkLatency - b.checkLatency);
    const resolved = sorted.slice(0, g.resolveCount || 8);

    let ok = false, err = '';
    if (resolved.length) {
      try {
        ok = await resolveToCloudflare(g, resolved);
      } catch (e) {
        err = e.message;
      }
    }

    groupResults.push({
      id: g.id,
      name: g.name,
      domain: g.domain,
      ok,
      err,
      count: validIPs.length,
      removed: removedCount,
      resolved: resolved.map(i => i.ipPort + '(' + i.checkLatency + 'ms)')
    });

    console.log(`  ✅ [${g.name}] 剩余: ${validIPs.length}, 移除: ${removedCount}, 解析: ${resolved.length}个IP`);
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
    for (const gr of groupResults) {
      msg += `📦<b>${gr.name}</b>→${gr.domain || 'N/A'} ${gr.ok ? '✅' : '❌'}${gr.err ? ' ' + gr.err : ''}\n`;

      if (gr.resolved && gr.resolved.length > 0) {
        msg += `🌐 已解析: ${gr.resolved.join(', ')}\n`;
      }

      if (gr.removed > 0) {
        msg += `🗑️ 已移除${gr.removed}个失效IP\n`;
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
