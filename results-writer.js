/**
 * results-writer.js — ProxyIP 检测结果文档生成器
 *
 * 每次检测结束后，按分组把本次结果写成文档并落盘到仓库 results/ 目录：
 *   results/<分组名>/<时间戳>.json   完整结果文档（机器可读，含全部有效IP与分布统计）
 *   results/<分组名>/<时间戳>.md     可读版结果文档（表格摘要）
 *   results/index.json               最近 N 次运行的索引
 *   results/README.md                目录说明（首次自动生成）
 *
 * 保留策略：每组仅保留最近 RESULTS_KEEP 份（默认 36，约 3 天 @2 小时一次）。
 * 依赖：仅 Node 内置模块（fs / path），可在 GitHub Actions 里直接跑。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_KEEP = parseInt(process.env.RESULTS_KEEP || '36', 10) || 36;
const DEFAULT_KEEP_INDEX = parseInt(process.env.RESULTS_KEEP_INDEX || '60', 10) || 60;

function pad(n) { return String(n).padStart(2, '0'); }

/** 文件名时间戳：2026-09-10_1430Z（UTC） */
function stampOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
}

function safeName(s) {
  return String(s || 'group').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'group';
}

function latencyOf(ip) {
  const v = (ip && ip.checkLatency !== undefined && ip.checkLatency !== null && ip.checkLatency < 9999)
    ? ip.checkLatency
    : (ip && ip.latency !== undefined ? ip.latency : null);
  return (v === null || v === undefined) ? null : v;
}

function addCount(map, key) {
  if (key === undefined || key === null || key === '') return;
  map[key] = (map[key] || 0) + 1;
}

function topN(map, n) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function latencyBuckets(ips) {
  const buckets = { '<50ms': 0, '50-100ms': 0, '100-200ms': 0, '200-500ms': 0, '500-1000ms': 0, '>1000ms': 0, 'unknown': 0 };
  ips.forEach(ip => {
    const l = latencyOf(ip);
    if (l === null) buckets['unknown']++;
    else if (l < 50) buckets['<50ms']++;
    else if (l < 100) buckets['50-100ms']++;
    else if (l < 200) buckets['100-200ms']++;
    else if (l < 500) buckets['200-500ms']++;
    else if (l < 1000) buckets['500-1000ms']++;
    else buckets['>1000ms']++;
  });
  return buckets;
}

/** 全部有效IP的紧凑表示：ipPort|延迟|ASN|colo|状态 */
function compactIPs(ips) {
  return ips.map(i => {
    const l = latencyOf(i);
    return [i.ipPort || '', (l === null ? '' : l + 'ms'), i.asn ? 'AS' + i.asn : '', i.colo || '', i.status || ''].join('|');
  });
}

function buildGroupDoc(gr, ctx) {
  const allValid = gr.allValidIPs || [];
  const trash = gr.trash || [];
  const restoredDetail = (ctx.restoredPerGroupDetails && ctx.restoredPerGroupDetails[gr.id]) || [];
  const removedThisRun = trash.filter(t => t.deletedAt === ctx.runStartedAt);

  const asnMap = {}, coloMap = {}, countryMap = {}, cityMap = {}, orgMap = {};
  allValid.forEach(ip => {
    addCount(asnMap, ip.asn ? 'AS' + ip.asn : '');
    addCount(coloMap, ip.colo);
    addCount(countryMap, ip.country);
    addCount(cityMap, ip.city);
    addCount(orgMap, ip.org);
  });

  const overLatency = gr.overLatencyIPs || [];
  const resolved = (gr.resolved || []).map(ip => ({
    ipPort: ip.ipPort, latency: latencyOf(ip), asn: ip.asn ? 'AS' + ip.asn : '', org: ip.org || '', colo: ip.colo || '', city: ip.city || '', country: ip.country || ''
  }));

  return {
    runTime: ctx.runTime,
    group: {
      id: gr.id, name: gr.name, domain: gr.domain || '', recordType: gr.recordType || 'TXT',
      maxLatency: gr.maxLatency === undefined ? null : gr.maxLatency,
      resolveCount: ctx.groupMeta[gr.id] ? (ctx.groupMeta[gr.id].resolveCount || 8) : undefined,
      selectedAsns: ctx.groupMeta[gr.id] ? (ctx.groupMeta[gr.id].selectedAsns || []) : []
    },
    dns: { ok: !!gr.ok, type: gr.recordType || 'TXT', err: gr.err || '' },
    counts: {
      total: gr.count, alive: gr.stats ? gr.stats.alive : null,
      removedThisRun: gr.removed, restoredThisRun: gr.restored, overLatencyInTrash: overLatency.length,
      change: gr.stats ? { total: gr.stats.totalChange, alive: gr.stats.aliveChange, overLatency: gr.stats.overLatencyChange } : null
    },
    removedThisRun: removedThisRun.map(t => ({
      ipPort: t.ipPort, latency: latencyOf(t), reason: t.deletedReason || '', failCount: t.failCount || 0, asn: t.asn ? 'AS' + t.asn : '', country: t.country || '', org: t.org || ''
    })),
    restoredThisRun: restoredDetail.map(t => ({ ipPort: t.ipPort, latency: latencyOf(t), asn: t.asn ? 'AS' + t.asn : '', org: t.org || '' })),
    resolved,
    distribution: {
      byAsn: topN(asnMap, 15), byColo: topN(coloMap, 10), byCountry: topN(countryMap, 10),
      byCity: topN(cityMap, 10), byOrg: topN(orgMap, 10), latencyBuckets: latencyBuckets(allValid)
    },
    ips: compactIPs(allValid)
  };
}

function buildGroupMd(doc) {
  const g = doc.group, c = doc.counts;
  const fmt = n => (n > 0 ? `(+${n})` : (n < 0 ? `(${n})` : ''));
  const L = [];
  L.push(`# ${g.name} 检测结果`);
  L.push('');
  L.push(`- 运行时间(UTC): \`${doc.runTime}\``);
  L.push(`- 分组ID: \`${g.id}\``);
  L.push(`- 目标域名: \`${g.domain || 'N/A'}\` (${doc.dns.type}) — DNS 解析: ${doc.dns.ok ? '✅ 成功' : '❌ 失败' + (doc.dns.err ? ' ' + doc.dns.err : '')}`);
  if (g.maxLatency) L.push(`- 延迟上限: ${g.maxLatency}ms`);
  L.push('');
  L.push('## 统计');
  L.push('');
  L.push('| 指标 | 数量 | 环比 |');
  L.push('| --- | --- | --- |');
  L.push(`| 有效(存活) | ${c.alive} | ${c.change ? fmt(c.change.alive) : '-'} |`);
  L.push(`| IP总数 | ${c.total} | ${c.change ? fmt(c.change.total) : '-'} |`);
  L.push(`| 本轮移除 | ${c.removedThisRun} | - |`);
  L.push(`| 本轮恢复 | ${c.restoredThisRun} | - |`);
  L.push(`| 回收站超延迟 | ${c.overLatencyInTrash} | ${c.change ? fmt(c.change.overLatency) : '-'} |`);
  L.push('');
  if (doc.dns.ok || doc.resolved.length) {
    L.push(`## DNS 解析 (${doc.resolved.length})`);
    L.push('');
    L.push('| IP | 延迟 | ASN | 地区 | colo |');
    L.push('| --- | --- | --- | --- | --- |');
    doc.resolved.forEach(ip => L.push(`| \`${ip.ipPort}\` | ${ip.latency === null ? '-' : ip.latency + 'ms'} | ${ip.asn} ${ip.org} | ${ip.city} ${ip.country} | ${ip.colo} |`));
    L.push('');
  }
  if (doc.removedThisRun.length) {
    L.push(`## 本轮移除 (${doc.removedThisRun.length})`);
    L.push('');
    L.push('| IP | 延迟 | 原因 | ASN |');
    L.push('| --- | --- | --- | --- |');
    doc.removedThisRun.slice(0, 100).forEach(ip => L.push(`| \`${ip.ipPort}\` | ${ip.latency === null ? '-' : ip.latency + 'ms'} | ${ip.reason} | ${ip.asn} |`));
    if (doc.removedThisRun.length > 100) L.push(`| ... | | 还有 ${doc.removedThisRun.length - 100} 条 | |`);
    L.push('');
  }
  if (doc.restoredThisRun.length) {
    L.push(`## 本轮恢复 (${doc.restoredThisRun.length})`);
    L.push('');
    L.push('| IP | 延迟 | ASN |');
    L.push('| --- | --- | --- |');
    doc.restoredThisRun.slice(0, 100).forEach(ip => L.push(`| \`${ip.ipPort}\` | ${ip.latency === null ? '-' : ip.latency + 'ms'} | ${ip.asn} |`));
    L.push('');
  }
  const d = doc.distribution;
  if (d.byAsn.length) {
    L.push('## ASN 分布 (Top 15)');
    L.push('');
    d.byAsn.forEach(([k, v]) => L.push(`- ${k}: ${v}`));
    L.push('');
  }
  L.push('## 延迟分布');
  L.push('');
  Object.entries(d.latencyBuckets).forEach(([k, v]) => { if (v) L.push(`- ${k}: ${v}`); });
  L.push('');
  if (d.byColo.length) {
    L.push('## colo 分布 (Top 10)');
    L.push('');
    d.byColo.forEach(([k, v]) => L.push(`- ${k}: ${v}`));
    L.push('');
  }
  L.push('---');
  L.push('');
  L.push(`完整明细（含全部 ${doc.ips.length} 个有效IP）见同目录 \`${path.basename(doc._file || '')}\``);
  L.push('');
  return L.join('\n');
}

const README = `# 检测结果文档

每次 ProxyIP 检测（GitHub Actions，每 2 小时）完成后自动写入，按分组归档。

\`\`\`
results/
├── index.json                  # 最近若干次运行的索引（时间 + 各组统计 + 文档路径）
├── README.md                   # 本说明
└── <分组名>/
    ├── 2026-09-10_1430Z.json   # 完整结果文档：统计、DNS解析、本轮移除/恢复、ASN/延迟分布、全部有效IP
    └── 2026-09-10_1430Z.md     # 可读版摘要（表格）
\`\`\`

- 保留策略：每个分组仅保留最近 \`RESULTS_KEEP\` 份（默认 36 份，约 3 天），旧文档在写入新文档时自动删除。
- 索引保留最近 \`RESULTS_KEEP_INDEX\` 次运行（默认 60 次）。
- 由 \`check-script.js\`（Actions）调用 \`results-writer.js\` 生成；也可本地运行 \`node check-script.js\` 复现。
`;

/**
 * 写入结果文档
 * @param {object} opts
 * @param {string} opts.runTime        本次运行时间（ISO）
 * @param {object} opts.result         check-script 的 result 汇总对象
 * @param {Array}  opts.groupResults   每个分组的结果（需含 allValidIPs / trash 字段）
 * @param {Array}  opts.groups         分组配置（用于取 resolveCount / selectedAsns）
 * @param {object} opts.restoredPerGroupDetails 每个分组本轮恢复的IP明细
 * @param {string} opts.runStartedAt   本轮时间戳（与回收站 deletedAt 比对）
 * @param {string} [opts.dir]          输出目录（默认 results）
 * @param {number} [opts.keep]         每组保留份数
 * @param {number} [opts.keepIndex]    索引保留条数
 * @returns {{dir:string,files:string[],groups:Array,pruned:number}}
 */
function writeResultDocs(opts) {
  const dir = path.resolve(opts.dir || 'results');
  const keep = opts.keep || DEFAULT_KEEP;
  const keepIndex = opts.keepIndex || DEFAULT_KEEP_INDEX;
  const runTime = opts.runTime || new Date().toISOString();
  const stamp = stampOf(runTime);

  const groupMeta = {};
  (opts.groups || []).forEach(g => { groupMeta[g.id] = g; });

  const ctx = {
    runTime, runStartedAt: opts.runStartedAt || null,
    restoredPerGroupDetails: opts.restoredPerGroupDetails || {}, groupMeta
  };

  fs.mkdirSync(dir, { recursive: true });
  const readmePath = path.join(dir, 'README.md');
  if (!fs.existsSync(readmePath)) fs.writeFileSync(readmePath, README, 'utf8');

  const files = [];
  const entryGroups = [];
  let pruned = 0;

  for (const gr of (opts.groupResults || [])) {
    const gdir = path.join(dir, safeName(gr.name || gr.id));
    fs.mkdirSync(gdir, { recursive: true });

    const doc = buildGroupDoc(gr, ctx);
    const jsonName = `${stamp}.json`;
    const mdName = `${stamp}.md`;
    doc._file = jsonName;

    fs.writeFileSync(path.join(gdir, jsonName), JSON.stringify(doc, null, 1), 'utf8');
    fs.writeFileSync(path.join(gdir, mdName), buildGroupMd(doc), 'utf8');
    delete doc._file;

    // 保留策略：同组只留最近 keep 份（json/md 成对）
    const stamps = fs.readdirSync(gdir).filter(f => f.endsWith('.json')).sort().reverse();
    stamps.slice(keep).forEach(f => {
      const base = f.replace(/\.json$/, '');
      ['.json', '.md'].forEach(ext => {
        const p = path.join(gdir, base + ext);
        if (fs.existsSync(p)) { fs.unlinkSync(p); pruned++; }
      });
    });

    const rel = path.join(path.relative(dir, gdir), jsonName).split(path.sep).join('/');
    files.push(rel, rel.replace(/\.json$/, '.md'));
    entryGroups.push({
      id: gr.id, name: gr.name, domain: gr.domain || '', doc: rel, docMd: rel.replace(/\.json$/, '.md'),
      total: gr.count, alive: gr.stats ? gr.stats.alive : null,
      removed: gr.removed, restored: gr.restored, overLatency: gr.stats ? gr.stats.overLatency : null,
      dnsOK: !!gr.ok, dnsErr: gr.err || '', validIPs: doc.ips.length
    });
  }

  // 索引（滚动保留）
  const indexPath = path.join(dir, 'index.json');
  let index = { updated: '', runs: [] };
  if (fs.existsSync(indexPath)) {
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { index = { updated: '', runs: [] }; }
  }
  if (!Array.isArray(index.runs)) index.runs = [];
  index.runs = index.runs.filter(r => r && r.time !== runTime);
  index.runs.unshift({
    time: runTime, ref: `results/${stamp}`,
    summary: opts.result || null,
    groups: entryGroups
  });
  // 索引里指向已删除文档的条目一并清掉
  index.runs = index.runs.filter(r => !r.groups || r.groups.every(g => fs.existsSync(path.join(dir, g.doc))));
  index.runs = index.runs.slice(0, keepIndex);
  index.updated = new Date().toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 1), 'utf8');
  files.push('index.json');

  return { dir, files, groups: entryGroups, pruned };
}

module.exports = { writeResultDocs, stampOf, safeName, buildGroupDoc, buildGroupMd };

// 允许直接运行做自测：node results-writer.js --selftest
if (require.main === module && process.argv.includes('--selftest')) {
  const res = writeResultDocs({
    runTime: new Date().toISOString(),
    dir: process.env.SELFTEST_DIR || '/tmp/results-selftest',
    result: { time: new Date().toISOString(), total: 10, checked: 10, valid: 7, invalid: 2, duplicates: 0, overLatency: 1, failReasons: { timeout: 2 } },
    restoredPerGroupDetails: { g1: [{ ipPort: '1.1.1.1:80', checkLatency: 42, asn: '13335', org: 'CF' }] },
    groups: [{ id: 'g1', name: 'kr', resolveCount: 8, selectedAsns: ['4766'] }],
    groupResults: [{
      id: 'g1', name: 'kr', domain: 'kr.example.com', recordType: 'TXT', ok: true, err: '', count: 7, removed: 2, restored: 1,
      maxLatency: 1000,
      resolved: [{ ipPort: '1.1.1.1:80', checkLatency: 42, asn: '13335', org: 'CF', colo: 'LAX', city: 'LA', country: 'US' }],
      overLatencyIPs: [],
      stats: { total: 7, alive: 7, overLatency: 0, totalChange: 1, aliveChange: 1, overLatencyChange: 0 },
      allValidIPs: [{ ipPort: '1.1.1.1:80', checkLatency: 42, asn: '13335', colo: 'LAX', city: 'LA', country: 'US', org: 'CF', status: 'valid' }],
      trash: [{ ipPort: '2.2.2.2:80', checkLatency: 9999, deletedReason: 'timeout', deletedAt: 'x', failCount: 1 }]
    }]
  });
  console.log(JSON.stringify(res, null, 1));
}
