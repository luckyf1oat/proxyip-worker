// ProxyIP检测脚本 - 适用于GitHub Actions
// 使用Cloudflare API读写KV数据
// 基于原始Python检测逻辑: 检测proxyip.py

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CHECK_API = 'https://cf.090227.xyz/check?proxyip=';
const CHECK_TIMEOUT = 10000;  // Python版本: 10秒超时
const BATCH = 30;
const RETRY = 1;  // Python版本: MAX_RETRIES=1 (共2次尝试)

// KV操作函数
async function kvGet(key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${key}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` }
  });
  if (!res.ok) return null;
  return await res.text();
}

async function kvPut(key, value) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${key}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` },
    body: value
  });
  return res.ok;
}

// 检测单个IP (对应Python的单次请求逻辑)
async function fetchCheck(ipPort) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT);

  try {
    const res = await fetch(CHECK_API + encodeURIComponent(ipPort), {
      signal: controller.signal,
      headers: { 'User-Agent': UA }
    });

    if (!res.ok) {
      clearTimeout(timeout);
      return { ok: false, reason: 'http_' + res.status };
    }

    // Python版本: response.json() 也有超时保护
    const data = await Promise.race([
      res.json(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('body_timeout')), 5000))
    ]);

    clearTimeout(timeout);

    // Python版本: data.get('success') is True
    if (data.success === true || data.success === 'true') {
      const lat = parseInt(data.responseTime);
      return { ok: true, latency: isNaN(lat) ? 9999 : lat, colo: data.colo || 'UNK' };
    }

    return { ok: false, reason: data.message || data.error || 'api_fail' };
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') return { ok: false, reason: 'timeout' };
    if (e.message === 'body_timeout') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'network_error' };
  }
}

// 带重试的检测 (Python: MAX_RETRIES=1, 即最多2次尝试)
async function checkIP(ipPort) {
  let lastReason = 'unknown';
  for (let attempt = 0; attempt <= RETRY; attempt++) {
    const result = await fetchCheck(ipPort);
    if (result.ok) return result;  // 成功立即返回
    lastReason = result.reason;
  }
  return { ok: false, reason: lastReason };
}

// 批量检测 (对应Python的worker并发逻辑)
async function batchCheck(list) {
  const out = [];
  let valid = 0, invalid = 0;
  const startTime = Date.now();
  const MAX_TIME = 270000; // 4.5分钟总时限

  console.log(`[*] 第一阶段(测速)开始: ${list.length} 个IP`);

  // 第一轮: 全量并发检测 (Python: NUM_WORKERS=400并发)
  for (let i = 0; i < list.length; i += BATCH) {
    if (Date.now() - startTime > MAX_TIME) {
      console.log('[!] 达到时间限制，停止检测');
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
        // Python风格: 打印每个有效IP
        console.log(`    [+] 有效IP: ${r.value.ipPort.padEnd(21)} | 延迟: ${r.value.checkLatency}ms | 机房: ${r.value.colo}`);
      } else {
        invalid++;
      }
    }

    // Python风格: 每50个打印进度
    if (out.length % 50 === 0 || out.length === list.length) {
      console.log(`[*] 第一阶段进度: ${out.length}/${list.length} | 有效: ${valid} | 失效: ${invalid}`);
    }
  }

  // 第二轮: 失效IP重测 (Python风格: 快速过一遍)
  const failed = out.filter(i => i.status === 'invalid');
  if (failed.length > 0 && Date.now() - startTime < MAX_TIME) {
    console.log(`[*] 第二阶段(失效重测)开始: ${failed.length} 个IP`);
    const RECHECK_BATCH = 15;
    let rechecked = 0;

    for (let i = 0; i < failed.length; i += RECHECK_BATCH) {
      if (Date.now() - startTime > MAX_TIME) break;

      const chunk = failed.slice(i, i + RECHECK_BATCH);
      await Promise.allSettled(chunk.map(async ip => {
        const r = await fetchCheck(ip.ipPort);  // 单次尝试，不重试
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

async function resolveToCloudflare(group, ips) {
  if (!group.cfToken || !group.zoneId || !group.domain) {
    throw new Error(`[${group.id}]缺少CF配置`);
  }

  const content = '"' + ips.map(i => i.ipPort).join(',') + '"';
  const headers = {
    'Authorization': 'Bearer ' + group.cfToken,
    'Content-Type': 'application/json'
  };
  const base = `https://api.cloudflare.com/client/v4/zones/${group.zoneId}/dns_records`;

  // 查询现有记录
  const listRes = await fetch(`${base}?name=${group.domain}&type=TXT`, { headers });
  const listData = await listRes.json();

  if (!listData.success) {
    throw new Error('CF查询失败:' + JSON.stringify(listData.errors));
  }

  const existing = listData.result?.[0];
  const body = JSON.stringify({ type: 'TXT', name: group.domain, content, ttl: 60 });

  // 更新或创建记录
  const res = existing
    ? await fetch(`${base}/${existing.id}`, { method: 'PUT', headers, body })
    : await fetch(base, { method: 'POST', headers, body });

  const data = await res.json();
  if (!data.success) {
    throw new Error('CF写入失败:' + JSON.stringify(data.errors));
  }

  return true;
}

async function sendTelegram(config, message) {
  if (!config.tgToken || !config.tgChatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${config.tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.tgChatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.error('Telegram通知失败:', e.message);
  }
}

async function main() {
  console.log('=== ProxyIP检测任务开始 ===');

  // 读取配置
  const configStr = await kvGet('config');
  const groupsStr = await kvGet('groups');
  const blacklistStr = await kvGet('blacklist');

  if (!configStr || !groupsStr) {
    console.error('配置或分组数据不存在');
    return;
  }

  const config = JSON.parse(configStr);
  const groups = JSON.parse(groupsStr);
  const blacklist = new Set(JSON.parse(blacklistStr || '[]'));

  if (!groups.length) {
    console.log('没有配置分组');
    return;
  }

  // 收集所有IP
  const allMap = new Map();
  for (const group of groups) {
    const ipsStr = await kvGet('ips:' + group.id);
    let groupIps = JSON.parse(ipsStr || '[]');
    let filtered = groupIps.filter(ip => !blacklist.has(ip.ip));

    if (group.selectedAsns?.length) {
      filtered = filtered.filter(ip => group.selectedAsns.includes(ip.asn));
    }

    filtered.forEach(ip => {
      if (!allMap.has(ip.ipPort)) allMap.set(ip.ipPort, ip);
    });
  }

  const toCheck = [...allMap.values()];
  if (!toCheck.length) {
    console.log('没有需要检测的IP');
    return;
  }

  // 批量检测
  const checked = await batchCheck(toCheck);
  const resultMap = new Map(checked.map(i => [i.ipPort, i]));
  const validSet = new Set(checked.filter(i => i.status === 'valid').map(i => i.ipPort));

  // 按分组更新和解析
  const groupResults = [];
  for (const group of groups) {
    const ipsStr = await kvGet('ips:' + group.id);
    let groupIps = JSON.parse(ipsStr || '[]');

    // 更新检测结果
    groupIps = groupIps.map(ip => resultMap.get(ip.ipPort) || ip);
    await kvPut('ips:' + group.id, JSON.stringify(groupIps));

    // 筛选有效IP
    let validIps = groupIps.filter(i => i.status === 'valid');
    if (group.selectedAsns?.length) {
      validIps = validIps.filter(i => group.selectedAsns.includes(i.asn));
    }

    // 按延迟排序并解析
    const sorted = [...validIps].sort((a, b) => a.checkLatency - b.checkLatency);
    const resolved = sorted.slice(0, group.resolveCount || 8);

    let ok = false, err = '';
    if (resolved.length) {
      try {
        ok = await resolveToCloudflare(group, resolved);
        console.log(`✅ [${group.name}] 解析成功: ${resolved.length}个IP`);
      } catch (e) {
        err = e.message;
        console.error(`❌ [${group.name}] 解析失败: ${err}`);
      }
    }

    groupResults.push({
      id: group.id,
      name: group.name,
      domain: group.domain,
      ok,
      err,
      count: groupIps.length,
      resolved: resolved.map(i => `${i.ipPort}(${i.checkLatency}ms)`)
    });
  }

  // 统计失效原因
  const failedIPs = checked.filter(i => i.status === 'invalid');
  const reasonMap = {};
  failedIPs.forEach(i => {
    const r = i.failReason || 'unknown';
    reasonMap[r] = (reasonMap[r] || 0) + 1;
  });

  const reasonLabels = {
    timeout: '超时',
    network_error: '网络错误',
    api_fail: 'API返回失败',
    unknown: '未知'
  };
  const reasonStr = Object.entries(reasonMap)
    .map(([k, v]) => `${reasonLabels[k] || k}:${v}`)
    .join(' | ');

  // 保存结果
  const result = {
    time: new Date().toISOString(),
    total: toCheck.length,
    checked: checked.length,
    valid: validSet.size,
    invalid: checked.length - validSet.size,
    failReasons: reasonMap,
    groups: groupResults
  };

  await kvPut('last_result', JSON.stringify(result));

  // 发送Telegram通知
  let tgMsg = `<b>🔍 ProxyIP检测报告</b>\n⏰${result.time}\n📊 总:${result.total} ✅${result.valid} ❌${result.invalid}`;
  if (reasonStr) tgMsg += `\n📋 失效原因: ${reasonStr}`;

  for (const g of groupResults) {
    tgMsg += `\n\n<b>📦${g.name}</b>→${g.domain}\n${g.ok ? '✅' : '❌'}${g.err ? ' ' + g.err : ''}\n`;
    tgMsg += g.resolved.length ? g.resolved.map(r => '  ' + r).join('\n') : '  无有效IP';
  }

  await sendTelegram(config, tgMsg);

  console.log('=== 检测任务完成 ===');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});
