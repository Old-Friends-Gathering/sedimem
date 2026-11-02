# 01 · 架构

## 1. 分层与依赖方向（只允许向下依赖）

```
       ┌───────────────────────────────┐
       │ 入口层：CLI (memo) / MCP (stdio)│   ← 只做参数解析与 JSON 编解码
       └───────────────┬───────────────┘
                       │ MemoryService（唯一对外 API）
       ┌───────────────▼───────────────┐
       │ 服务层：api/service.js         │   ← 编排，不含策略细节
       └───┬───────────┬───────────┬───┘
           │           │           │
   ┌───────▼──┐ ┌──────▼─────┐ ┌───▼──────────┐
   │ hygiene  │ │ storage    │ │ index/render │
   │ 四条路径 │ │ JSONL 真相 │ │ 派生层（可弃）│
   └───────┬──┘ └──────┬─────┘ └───┬──────────┘
           │           │           │
       ┌───▼───────────▼───────────▼───┐
       │ ports/（JSDoc typedef 契约）    │
       │ Clock · StoragePort · IndexPort │
       │ JudgePort · RendererPort · Policy│
       └────────────────────────────────┘
```

**规则**：`hygiene/` 不得 import `storage/` 的具体实现，只能吃 `records[]` 与 `ports`；`api/` 不得包含策略；`cli/` `mcp/` 不得含业务逻辑。

## 2. 四条卫生路径（v0.1 落地范围）

```
写路径（同步，0 次 LLM）
  write ─ normalize → contentHash
        ├ hash 命中 active            → noop_duplicate
        ├ 同 slot 同值                → noop_same_value
        ├ 同 slot 异值：
        │   ├ 值可解析(时间/数字) 且新更晚 → supersede（旧记录追加 valid_to）
        │   └ 否则                     → disputed（新记录 disputed + 入 curate 队列）
        └ 其他                        → created
        → append(items.jsonl) + append(events.jsonl)

裁决（离线、批量）
  curateExport(limit) → queue/curate-<batch>.json
  Agent 读批次、给 decisions
  curateApply(batch, decisions) → supersede / merge / keep-both，写审计

整合（夜间，确定性）
  compact（P2）· TTL/expire 标记 · 配额淘汰（只写墓碑）· brief 重建 · metrics

读路径（同步）
  search ─ tokenize → IndexPort.search → 过滤(status=active && valid_to IS NULL && !expired)
         → 打分 bm25 × kindWeight × recencyDecay × confidence
         → 返回带 validFrom / source / disputed 标记
  asOf 查询：显式传 asOf，返回当时有效版本
```

## 3. 失败模式的防线（每条对应一个真实事故）

| 事故 | 防线 |
|---|---|
| MemoryBank 衰减公式方向错误 | `hygiene/decay.js` 单调性单测 |
| 在 load 路径删数据 | `reindex()` 只读真相层；单测断言 reindex 前后 items.jsonl 字节不变 |
| 重建复活被删条目 | 墓碑版本也进真相层，fold 时最后一条胜出 |
| 用列表下标当 id | `core/ids.js` 生成 26 位 ULID；单测断言跨进程稳定且唯一 |
| 只写新向量不删旧 | v0.1 无向量；`supersede` 必须同时写旧记录 `valid_to` |
| 无 provenance | `validateRecord` 强制 `source.agent`，缺失即拒绝写入 |
| 无上限 append | `QuotaPolicy.selectEvictions` + 单测 |
| hook 静默失败 | 每次写操作必返回 `action`；`doctor` 校验 JSONL 可解析、id 唯一、索引一致 |

## 4. 并发与一致性

- 单行 JSONL 追加用 `O_APPEND` + 单次 `writeSync`（<64KB 原子）；跨进程用 `<memoHome>/.lock`（`fs.open(..., 'wx')` + 陈旧锁 30s 超时，复用 MCP 参考实现策略）。
- 索引在进程内构建（启动时从真相层 fold），写路径通过事件队列增量更新；不做跨进程索引共享。
- 所有时间是 ISO-8601 UTC（毫秒精度），避免时区漂移。

## 5. v0.1 的刻意简化（都留了替换点）

| 简化 | 替换路径 |
|---|---|
| 纯 JS 倒排索引（内存） | 新增 `index/sqlite-index.js` 实现 IndexPort（node:sqlite 已可用）；`MEMO_INDEX=sqlite` 切换 |
| 规则化冲突裁决（时间/数字可比） | 新增 `hygiene/judge-llm.js` 实现 JudgePort，接 curate 批次 |
| 词法检索 | 新增 `index/hybrid-index.js`（dense + BM25，RRF k=60） |
| 单机单写 | P4 走 git 同步 + 冲突合并 |
