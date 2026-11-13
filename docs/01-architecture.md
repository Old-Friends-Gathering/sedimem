# 01 · 架构

> doc-kind: contract
> doc-version: 1.0
> verified-at: 2026-11-14
> verified-against: versions/CURRENT（v1.0 / 1.0.0）

## 1. 分层与依赖方向（只允许向下依赖）

```
        ┌───────────────────────────────┐
        │ 入口层：CLI (memo) / MCP (stdio)│   ← 只做参数解析与 JSON 编解码
        └───────────────┬───────────────┘
                        │ MemoryService（唯一对外 API）
        ┌───────────────▼───────────────┐
        │ 服务层：api/service.js         │   ← 编排，不含策略细节
        └──┬─────────┬─────────┬────┬───┘
           │         │         │    │
   ┌───────▼──┐ ┌────▼────┐ ┌──▼─────────────┐ ┌──▼─────────────┐
   │ hygiene  │ │ storage │ │ index/render   │ │ views/capture  │
   │ 卫生四路 │ │ JSONL 真│ │ 派生层（可弃） │ │ session        │
   └───────┬──┘ │ 相层    │ └──┬─────────────┘ └──┬─────────────┘
           │    └────┬────┘    │                  │
       ┌───▼─────────▼─────────▼──────────────────▼───┐
       │ 端口 = 约定命名（IndexPort/JudgePort/          │
       │ EmbedderPort）+ 注入点：create-index.js /      │
       │ service 构造参数（无独立 ports/ 目录）          │
       └───────────────────────────────────────────────┘
```

三个 v0.4–v0.6 落地的派生/辅助模块（都在派生层，可删可重建，真相层 `items/*.jsonl` 逐字节不变）：

- **views/**（L2/L3 派生视图）：`views/l2.js` 同主题确定性聚合（slot 分组 + 近重聚类）、`views/l3.js` 画像层（带 `sourceRefs` 溯源、预算硬上限）、`views/conflicts.js` 分歧视图。整个目录删掉后用真相层重建必须字节相同。
- **capture/**（半自动捕获）：`capture/extract.js` 从粘贴文本提取候选记录、`capture/queue.js` 候选队列；只有人工确认后才进真相层写入。
- **session/**（会话临时记忆库）：`session/lifecycle.js`（`session:<id>` scope 生命周期）、`session/checkpoint.js`（8 段 checkpoint）、`session/handoff.js`（close 时交接文档）；close 只晋升 decision/gotcha 到主库，其余随库丢弃。

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

读路径（v0.4 起为混合检索：词法 BM25 + 可选语义道 + RRF 融合）
  search ─ tokenize → IndexPort.search（backend=memory|sqlite|hybrid，
           见 config/policy.json 的 index.backend）
         ├ 语义道（EmbedderPort，policy.search.embedder.kind，默认 none=关闭）：
         │   bm25 与 vector 两路命中经 RRF（rrfK=60）融合
         ├ 过滤(status=active && valid_to IS NULL && !expired)
         ├ 打分 × kindWeight × recencyDecay × confidence
         └ 每条命中带 basis（'bm25'|'vector'|'bm25+vector'，说明来自哪一路）
           与 degraded 标记（语义道缺失/超时/维度漂移时显式降级为纯词法，
           见 src/index/hybrid.js / src/index/hybrid-index.js）
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

- 单行 JSONL 追加用 `O_APPEND` + 单次 `writeSync`（<64KB 原子）；跨进程用 `<memoHome>/.lock/` 目录锁（`mkdir` 原子排他 + 陈旧锁 30s 超时；见 docs/02 与 `src/storage/lock.js` 注释）。
- 索引在进程内构建（启动时从真相层 fold），写路径通过事件队列增量更新；不做跨进程索引共享。
- 所有时间是 ISO-8601 UTC（毫秒精度），避免时区漂移。

## 5. v0.1 的刻意简化（都留了替换点，多数已落地）

| 简化 | 替换路径 | 现状（2026-11-14，对照 v0.6.2） |
|---|---|---|
| 纯 JS 倒排索引（内存） | `index/sqlite-index.js` 实现 IndexPort；`config/policy.json` 的 `index.backend=memory\|sqlite` 切换 | **已落地**（v0.2.1 起，`index/create-index.js` 单点注入） |
| 规则化冲突裁决（时间/数字可比） | JudgePort：确定性规则实现 `hygiene/judge.js`（v0.6 `memo curate auto` 默认裁决器） | 规则裁决器**已落地**；LLM 裁决留给 v1.0 的 LlmPort |
| 词法检索 | `index/hybrid-index.js`（EmbedderPort 语义道 + BM25，RRF k=60，结果带 basis/degraded） | **已落地**（v0.4 起，`policy.search.embedder.kind` 默认 `none` 即纯词法） |
| 单机单写 | P4 走 git 同步 + 冲突合并 | **未落地**（仍是替换点） |
