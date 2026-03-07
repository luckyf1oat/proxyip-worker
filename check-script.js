// GitHub Actions检测脚本 - 从KV读取IP并检测
const CHECK_API = 'https://cf.090227.xyz/check?proxyip=';
const CHECK_TIMEOUT = 10000;
const RETRY = 2;
const BATCH = 60;

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
  const url = `${KV_API}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  return await res.text();
}

// 写入KV
async function kvPut(key, value) {
  const url = `${KV_API}/values/${encodeURIComponent(key)}`;
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
  const recordType = g.recordType || 'TXT';
  const headers = {
    'Authorization': `Bearer ${g.cfToken}`,
    'Content-Type': 'application/json'
  };
  const base = `https://api.cloudflare.com/client/v4/zones/${g.zoneId}/dns_records`;

  if (recordType === 'A') {
    // A记录：为每个IP创建一条A记录
    // 1. 查询所有现有的A记录
    const listRes = await fetch(`${base}?name=${g.domain}&type=A`, { headers });
    const listData = await listRes.json();
    if (!listData.success) {
      throw new Error('CF查询失败:' + JSON.stringify(listData.errors));
    }
    const existing = listData.result || [];

    // 2. 删除所有现有的A记录
    for (const record of existing) {
      await fetch(`${base}/${record.id}`, { method: 'DELETE', headers });
    }

    // 3. 为每个IP创建新的A记录（去掉端口）
    for (const ip of ips) {
      const ipOnly = ip.ipPort.split(':')[0];
      const body = JSON.stringify({ type: 'A', name: g.domain, content: ipOnly, ttl: 60, proxied: false });
      const res = await fetch(base, { method: 'POST', headers, body });
      const resData = await res.json();
      if (!resData.success) {
        throw new Error('CF写入失败:' + JSON.stringify(resData.errors));
      }
    }
  } else {
    // TXT记录：多个IP用逗号分隔
    const listRes = await fetch(`${base}?name=${g.domain}&type=TXT`, { headers });
    const listData = await listRes.json();
    if (!listData.success) {
      throw new Error('CF查询失败:' + JSON.stringify(listData.errors));
    }

    const existing = listData.result?.[0];
    const content = '"' + ips.map(i => i.ipPort).join(',') + '"';
    const body = JSON.stringify({ type: 'TXT', name: g.domain, content, ttl: 60 });

    const updateRes = existing
      ? await fetch(`${base}/${existing.id}`, { method: 'PUT', headers, body })
      : await fetch(base, { method: 'POST', headers, body });

    const updateData = await updateRes.json();
    if (!updateData.success) {
      throw new Error('CF写入失败:' + JSON.stringify(updateData.errors));
    }
  }
  return true;
}

// 批量检测
async function batchCheck(list) {
  const out = [];
  let valid = 0, invalid = 0;
  const startTime = Date.now();
  const MAX_TIME = 500000; // 4.5分钟

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

  // 统计失效原因
  const failReasons = {};
  out.filter(i => i.status === 'invalid').forEach(i => {
    const reason = i.failReason || 'unknown';
    failReasons[reason] = (failReasons[reason] || 0) + 1;
  });

  if (Object.keys(failReasons).length > 0) {
    console.log('\n[!] 失效原因统计:');
    Object.entries(failReasons).forEach(([reason, count]) => {
      console.log(`    ${reason}: ${count}个`);
    });

    // 列出所有失效的IP
    console.log('\n[!] 失效IP列表:');
    const failedIPs = out.filter(i => i.status === 'invalid');
    failedIPs.forEach(i => {
      console.log(`    ${i.ipPort} - ${i.failReason || 'unknown'} | AS${i.asn} | ${i.country || 'N/A'} | ${i.org || 'N/A'}`);
    });

    // 统计失效IP的ASN分布
    const asnMap = {};
    failedIPs.forEach(i => {
      if (i.asn) {
        asnMap[i.asn] = (asnMap[i.asn] || 0) + 1;
      }
    });
    if (Object.keys(asnMap).length > 0) {
      console.log('\n[!] 失效IP的ASN分布:');
      Object.entries(asnMap).sort((a, b) => b[1] - a[1]).forEach(([asn, count]) => {
        const sample = failedIPs.find(i => i.asn === asn);
        console.log(`    AS${asn} (${sample?.org || 'N/A'}): ${count}个`);
      });
    }
  }

  // 去重：同一个IP不同端口只保留延迟最低的（只对有效IP去重）
  const ipMap = new Map();
  const validIPs = out.filter(i => i.status === 'valid');

  for (const item of validIPs) {
    const ip = item.ipPort.split(':')[0];
    const existing = ipMap.get(ip);

    if (!existing) {
      ipMap.set(ip, item);
    } else {
      // 比较延迟，保留延迟更低的
      const existingLatency = existing.checkLatency || 99999;
      const currentLatency = item.checkLatency || 99999;

      if (currentLatency < existingLatency) {
        console.log(`[*] IP去重: ${ip} 保留 ${item.ipPort}(${currentLatency}ms) 移除 ${existing.ipPort}(${existingLatency}ms)`);
        ipMap.set(ip, item);
      } else {
        console.log(`[*] IP去重: ${ip} 保留 ${existing.ipPort}(${existingLatency}ms) 移除 ${item.ipPort}(${currentLatency}ms)`);
      }
    }
  }

  const kept = new Set([...ipMap.values()].map(i => i.ipPort));
  const deduplicated = [...ipMap.values()];
  // dupRemoved 包含被去重移除的有效IP
  const dupRemoved = validIPs.filter(i => !kept.has(i.ipPort));
  // 将失效IP也加入到最终结果中（不参与去重）
  const invalidIPs_temp = out.filter(i => i.status === 'invalid');
  const finalResults = [...deduplicated, ...invalidIPs_temp];

  if (dupRemoved.length > 0) {
    console.log(`[+] 去重完成: ${validIPs.length} -> ${deduplicated.length} (移除 ${dupRemoved.length} 个重复端口IP)`);
  }

  return { results: finalResults, dupRemoved };
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
  const blacklistRaw = blacklistStr ? JSON.parse(blacklistStr) : [];
  const blacklistIP = new Set(blacklistRaw.map(b => b.split(':')[0]));
  const blacklistIPPort = new Set(blacklistRaw.filter(b => b.includes(':')));
  const config = configStr ? JSON.parse(configStr) : {};

  console.log(`📊 分组数: ${groups.length}`);
  console.log(`🚫 黑名单: ${blacklistRaw.length} 条`);
  console.log('');

  // 收集所有IP (排除回收站中的IP，但包含因延迟超标的IP以便重新检测)
  const allMap = new Map();
  const overLatencyRetryMap = new Map(); // 记录哪些IP是从回收站中因延迟超标而重新检测的
  for (const g of groups) {
    const ipsStr = await kvGet('ips:' + g.id);
    if (!ipsStr) continue;

    // 读取该分组的回收站
    const groupTrashStr = await kvGet('trash:' + g.id);
    const groupTrash = groupTrashStr ? JSON.parse(groupTrashStr) : [];
    const trashIPs = new Set(groupTrash.map(t => t.ipPort));

    // 找出回收站中因延迟超标的IP，准备重新检测
    const overLatencyTrash = groupTrash.filter(t => t.deletedReason && t.deletedReason.startsWith('over_latency_'));
    overLatencyTrash.forEach(ip => {
      if (!blacklistIP.has(ip.ip) && !blacklistIPPort.has(ip.ipPort)) {
        if (!allMap.has(ip.ipPort)) {
          allMap.set(ip.ipPort, ip);
          overLatencyRetryMap.set(ip.ipPort, g.id); // 记录这个IP属于哪个分组
        }
      }
    });

    let gips = JSON.parse(ipsStr);
    let filtered = gips.filter(ip => !blacklistIP.has(ip.ip) && !blacklistIPPort.has(ip.ipPort) && !trashIPs.has(ip.ipPort));
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
  const checkResult = await batchCheck(toCheck);
  const checked = checkResult.results;
  const dupRemoved = checkResult.dupRemoved;
  const resultMap = new Map(checked.map(i => [i.ipPort, i]));
  const validSet = new Set(checked.filter(i => i.status === 'valid').map(i => i.ipPort));

  // 读取上次的失效IP记录，对比是否是同一批IP一直失效
  const lastFailedStr = await kvGet('last_failed_ips');
  const lastFailed = lastFailedStr ? JSON.parse(lastFailedStr) : [];
  const currentFailed = checked.filter(i => i.status === 'invalid').map(i => i.ipPort);

  // 区分新失效IP和持续失效IP
  const newFailed = currentFailed.filter(ip => !lastFailed.includes(ip));
  const persistentFailed = currentFailed.filter(ip => lastFailed.includes(ip));

  if (newFailed.length > 0) {
    console.log(`\n[!] 新失效的IP (${newFailed.length}个):`);
    newFailed.forEach(ip => {
      const ipData = checked.find(i => i.ipPort === ip);
      console.log(`    ${ip} - ${ipData?.failReason || 'unknown'}`);
    });
  }

  if (persistentFailed.length > 0) {
    console.log(`\n[!] 持续失效的IP (${persistentFailed.length}个，本次后将不再重试):`);
    persistentFailed.forEach(ip => {
      const ipData = checked.find(i => i.ipPort === ip);
      console.log(`    ${ip} - ${ipData?.failReason || 'unknown'}`);
    });
  }

  // 保存本次失效IP列表供下次对比
  await kvPut('last_failed_ips', JSON.stringify(currentFailed));

  // 收集失效IP、重复端口IP和超过延迟上限的IP到各分组的回收站
  // 同时处理回收站中因延迟超标的IP：达标则放回IP池
  const invalidIPs = checked.filter(i => i.status === 'invalid');
  const now = new Date().toISOString();
  let totalRestored = 0;
  const restoredPerGroup = {}; // 记录每个分组恢复的IP数

  for (const g of groups) {
    const ipsStr = await kvGet('ips:' + g.id);
    if (!ipsStr) continue;

    const gips = JSON.parse(ipsStr);
    const groupInvalidIPs = invalidIPs.filter(ip => gips.some(gip => gip.ipPort === ip.ipPort));
    const groupDupIPs = dupRemoved.filter(ip => gips.some(gip => gip.ipPort === ip.ipPort));

    // 检查该分组是否设置了延迟上限
    const groupMaxLatency = g.maxLatency || null;
    let groupOverLatencyIPs = [];
    if (groupMaxLatency) {
      groupOverLatencyIPs = checked.filter(ip =>
        ip.status === 'valid' &&
        ip.checkLatency > groupMaxLatency &&
        gips.some(gip => gip.ipPort === ip.ipPort)
      );
    }

    // 处理回收站：找出因延迟超标重新检测后达标的IP，放回IP池
    const groupTrashStr = await kvGet('trash:' + g.id);
    let groupTrash = groupTrashStr ? JSON.parse(groupTrashStr) : [];
    const restoredIPs = [];

    groupTrash = groupTrash.filter(t => {
      if (!t.deletedReason || !t.deletedReason.startsWith('over_latency_')) return true;
      const result = resultMap.get(t.ipPort);
      if (!result) return true; // 没有检测结果，保留在回收站
      if (result.status !== 'valid') {
        // 检测失效，更新失效原因，不再作为延迟超标IP重试
        t.checkLatency = result.checkLatency;
        t.failReason = result.failReason;
        t.deletedReason = result.failReason || 'unknown';
        t.deletedAt = now;
        t.lastCheck = result.lastCheck;
        console.log(`    [!] 延迟超标IP重测失效: ${t.ipPort} - ${t.deletedReason}`);
        return true; // 保留在回收站，但原因已更新
      }
      if (groupMaxLatency && result.checkLatency > groupMaxLatency) {
        // 仍然超标，更新回收站中的延迟值和原因
        t.checkLatency = result.checkLatency;
        t.deletedReason = `over_latency_${groupMaxLatency}ms`;
        t.deletedAt = now;
        return true;
      }
      // 达标了，从回收站移除，准备放回IP池
      restoredIPs.push(result);
      return false;
    });

    if (restoredIPs.length > 0) {
      totalRestored += restoredIPs.length;
      restoredPerGroup[g.id] = restoredIPs.length;
      console.log(`♻️ [${g.name}] ${restoredIPs.length} 个IP延迟达标，从回收站放回IP池`);
    }

    // 添加新的失效/重复/超延迟IP到回收站
    groupInvalidIPs.forEach(ip => {
      groupTrash.push({ ...ip, deletedAt: now, deletedReason: ip.failReason || 'unknown' });
    });
    groupDupIPs.forEach(ip => {
      groupTrash.push({ ...ip, deletedAt: now, deletedReason: 'duplicate_port' });
    });
    groupOverLatencyIPs.forEach(ip => {
      groupTrash.push({ ...ip, deletedAt: now, deletedReason: `over_latency_${groupMaxLatency}ms` });
    });

    await kvPut('trash:' + g.id, JSON.stringify(groupTrash));

    // 将达标IP放回该分组的IP列表
    if (restoredIPs.length > 0) {
      const currentIPs = JSON.parse(await kvGet('ips:' + g.id) || '[]');
      const existingSet = new Set(currentIPs.map(i => i.ipPort));
      restoredIPs.forEach(ip => {
        if (!existingSet.has(ip.ipPort)) {
          currentIPs.push(ip);
        }
      });
      await kvPut('ips:' + g.id, JSON.stringify(currentIPs));
    }

    const removedCount = groupInvalidIPs.length + groupDupIPs.length + groupOverLatencyIPs.length;
    if (removedCount > 0) {
      let logMsg = `🗑️ [${g.name}] 已移除 ${groupInvalidIPs.length} 个失效IP`;
      if (groupDupIPs.length > 0) logMsg += ` + ${groupDupIPs.length} 个重复端口`;
      if (groupOverLatencyIPs.length > 0) logMsg += ` + ${groupOverLatencyIPs.length} 个超延迟(>${groupMaxLatency}ms)`;
      logMsg += ' 到回收站';
      console.log(logMsg);
    }
  }

  // 统计总移除数量（包括超延迟的）
  let totalOverLatency = 0;
  for (const g of groups) {
    if (g.maxLatency) {
      const ipsStr = await kvGet('ips:' + g.id);
      if (ipsStr) {
        const gips = JSON.parse(ipsStr);
        const count = checked.filter(ip =>
          ip.status === 'valid' &&
          ip.checkLatency > g.maxLatency &&
          gips.some(gip => gip.ipPort === ip.ipPort)
        ).length;
        totalOverLatency += count;
      }
    }
  }

  console.log(`\n🗑️ 总计移除 ${invalidIPs.length} 个失效IP + ${dupRemoved.length} 个重复端口 + ${totalOverLatency} 个超延迟到回收站`);
  if (totalRestored > 0) {
    console.log(`♻️ 总计恢复 ${totalRestored} 个延迟达标IP从回收站放回IP池`);
  }

  // 读取上次的分组统计数据
  const lastGroupStatsStr = await kvGet('last_group_stats');
  const lastGroupStats = lastGroupStatsStr ? JSON.parse(lastGroupStatsStr) : {};

  // 更新各分组并解析DNS
  console.log('\n📦 更新分组数据...');
  const groupResults = [];
  const currentGroupStats = {};

  for (const g of groups) {
    // 注意：这里读取的是已经包含恢复IP的最新数据
    const ipsStr = await kvGet('ips:' + g.id);
    if (!ipsStr) continue;

    let gips = JSON.parse(ipsStr);
    const beforeCount = gips.length;
    gips = gips.map(ip => resultMap.get(ip.ipPort) || ip);

    // 读取回收站，用于排除已在回收站中的非延迟超标IP
    const groupTrashStr = await kvGet('trash:' + g.id);
    const groupTrash = groupTrashStr ? JSON.parse(groupTrashStr) : [];
    // 只排除非延迟超标的回收站IP（延迟超标的IP会被重新检测和恢复）
    const nonOverLatencyTrashIPs = new Set(
      groupTrash
        .filter(t => !t.deletedReason || !t.deletedReason.startsWith('over_latency_'))
        .map(t => t.ipPort)
    );

    // 移除失效IP、重复端口IP、超过延迟上限的IP和回收站中的非延迟超标IP
    const dupRemovedSet = new Set(dupRemoved.map(i => i.ipPort));
    const groupMaxLatency = g.maxLatency || null;

    let validIPs = gips.filter(i => {
      // 移除黑名单IP
      const ip = i.ipPort.split(':')[0];
      if (blacklistIP.has(ip) || blacklistIPPort.has(i.ipPort)) return false;
      // 移除失效IP
      if (i.status === 'invalid') return false;
      // 移除重复端口IP
      if (dupRemovedSet.has(i.ipPort)) return false;
      // 移除超过延迟上限的IP
      if (groupMaxLatency && i.status === 'valid' && i.checkLatency > groupMaxLatency) return false;
      // 移除回收站中的非延迟超标IP
      if (nonOverLatencyTrashIPs.has(i.ipPort)) return false;
      return true;
    });

    // 计算实际移除数量
    const restoredCount = restoredPerGroup[g.id] || 0;
    const removedCount = beforeCount - validIPs.length;

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

    // 收集该分组的超延迟IP（从回收站读取）
    const groupTrashStr2 = await kvGet('trash:' + g.id);
    const groupTrash2 = groupTrashStr2 ? JSON.parse(groupTrashStr2) : [];
    const overLatencyIPs = groupTrash2.filter(t => t.deletedReason && t.deletedReason.startsWith('over_latency_'));

    // 统计该分组的IP数量
    const totalIPs = validIPs.length;
    const aliveIPs = gv.length;
    const overLatencyCount = overLatencyIPs.length;

    // 保存当前统计数据
    currentGroupStats[g.id] = {
      total: totalIPs,
      alive: aliveIPs,
      overLatency: overLatencyCount
    };

    // 获取上次统计数据
    const lastStats = lastGroupStats[g.id] || { total: totalIPs, alive: aliveIPs, overLatency: overLatencyCount };

    groupResults.push({
      id: g.id,
      name: g.name,
      domain: g.domain,
      recordType: g.recordType || 'TXT',
      ok,
      err,
      count: validIPs.length,
      removed: removedCount,
      restored: restoredPerGroup[g.id] || 0,
      resolved: resolved,  // 保存完整的IP对象
      overLatencyIPs: overLatencyIPs,  // 超延迟IP列表
      maxLatency: g.maxLatency || null,  // 延迟上限
      stats: {
        total: totalIPs,
        alive: aliveIPs,
        overLatency: overLatencyCount,
        totalChange: totalIPs - lastStats.total,
        aliveChange: aliveIPs - lastStats.alive,
        overLatencyChange: overLatencyCount - lastStats.overLatency
      }
    });

    let logMsg = `  ✅ [${g.name}] 剩余: ${validIPs.length}, 移除: ${removedCount}`;
    if (restoredCount > 0) logMsg += `, 恢复: ${restoredCount}`;
    logMsg += `, 解析: ${resolved.length}个IP`;
    console.log(logMsg);
  }

  // 保存当前分组统计数据
  await kvPut('last_group_stats', JSON.stringify(currentGroupStats));

  // 保存结果
  const failedIPs = checked.filter(i => i.status === 'invalid');
  const reasonMap = {};
  failedIPs.forEach(i => {
    const r = i.failReason || 'unknown';
    reasonMap[r] = (reasonMap[r] || 0) + 1;
  });

  // 统计去重移除的IP原因
  if (dupRemoved.length > 0) {
    reasonMap['duplicate_port'] = dupRemoved.length;
  }

  // 统计超延迟移除的IP
  if (totalOverLatency > 0) {
    reasonMap['over_latency'] = totalOverLatency;
  }

  const result = {
    time: new Date().toISOString(),
    total: toCheck.length,
    checked: checked.length + dupRemoved.length,
    valid: validSet.size - totalOverLatency, // 有效数量要减去超延迟的
    invalid: failedIPs.length,
    duplicates: dupRemoved.length,
    overLatency: totalOverLatency, // 新增：超延迟移除的数量
    failReasons: reasonMap
  };

  await kvPut('last_result', JSON.stringify(result));
  console.log('\n=== 检测任务完成 ===');
  console.log(`⏰ 时间: ${result.time}`);
  console.log(`📊 总计: ${result.total}, 检测: ${result.checked}, 有效: ${result.valid}, 失效: ${result.invalid}, 去重: ${result.duplicates}, 超延迟: ${result.overLatency}`);

  // 发送Telegram通知
  if (config.tgToken && config.tgChatId) {
    const reasonText = Object.entries(reasonMap)
      .map(([k, v]) => `${k}:${v}`)
      .join(' | ');

    let msg = `🔍 <b>ProxyIP检测报告</b>\n`;
    msg += `⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`;
    msg += `📊 总:${result.total} ✅${result.valid} ❌${result.invalid} 🔄${result.duplicates}`;
    if (result.overLatency > 0) msg += ` ⏱️${result.overLatency}`;
    if (totalRestored > 0) msg += ` ♻️${totalRestored}`;
    msg += `\n\n`;

    if (reasonText) {
      msg += `📋 失效原因: ${reasonText}\n\n`;
    }

    // 显示每个分组的详细信息
    for (const gr of groupResults) {
      const recordType = gr.recordType || 'TXT';
      const stats = gr.stats;

      // 格式化变化量
      const formatChange = (change) => {
        if (change > 0) return `(+${change})`;
        if (change < 0) return `(${change})`;
        return '';
      };

      msg += `📦<b>${gr.name}</b>→<code>${gr.domain || 'N/A'}</code>\n`;
      msg += `🌐 DNS类型: ${recordType} ${gr.ok ? '✅' : '❌'}${gr.err ? ' ' + gr.err : ''}\n`;

      // 显示IP统计信息
      msg += `📊 总IP:${stats.total}${formatChange(stats.totalChange)} | 存活:${stats.alive}${formatChange(stats.aliveChange)}`;
      if (stats.overLatency > 0 || stats.overLatencyChange !== 0) {
        msg += ` | 超标:${stats.overLatency}${formatChange(stats.overLatencyChange)}`;
      }
      msg += `\n`;

      if (gr.resolved && gr.resolved.length > 0) {
        msg += `已解析:\n`;
        gr.resolved.forEach(ip => {
          msg += `  <code>${ip.ipPort}</code> | ${ip.checkLatency}ms | AS${ip.asn} ${ip.org || ''}\n`;
        });
      }

      if (gr.removed > 0) {
        msg += `🗑️ 已移除${gr.removed}个失效IP\n`;
      }
      if (gr.restored > 0) {
        msg += `♻️ 已恢复${gr.restored}个延迟达标IP\n`;
      }
      if (gr.overLatencyIPs && gr.overLatencyIPs.length > 0) {
        msg += `⏱️ 延迟超标IP (上限${gr.maxLatency}ms):\n`;
        gr.overLatencyIPs.slice(0, 5).forEach(ip => {
          const exceed = ip.checkLatency - gr.maxLatency;
          msg += `  <code>${ip.ipPort}</code> | ${ip.checkLatency}ms (+${exceed}ms)\n`;
        });
        if (gr.overLatencyIPs.length > 5) {
          msg += `  ...还有${gr.overLatencyIPs.length - 5}个\n`;
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
