# 检测结果文档

每次 ProxyIP 检测（GitHub Actions，每 2 小时）完成后自动写入，按分组归档。

```
results/
├── index.json                  # 最近若干次运行的索引（时间 + 各组统计 + 文档路径）
├── README.md                   # 本说明
└── <分组名>/
    ├── 2026-09-10_1430Z.json   # 完整结果文档：统计、DNS解析、本轮移除/恢复、ASN/延迟分布、全部有效IP
    └── 2026-09-10_1430Z.md     # 可读版摘要（表格）
```

- 保留策略：每个分组仅保留最近 `RESULTS_KEEP` 份（默认 36 份，约 3 天），旧文档在写入新文档时自动删除。
- 索引保留最近 `RESULTS_KEEP_INDEX` 次运行（默认 60 次）。
- 由 `check-script.js`（Actions）调用 `results-writer.js` 生成；也可本地运行 `node check-script.js` 复现。
