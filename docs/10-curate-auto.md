# 10 · curate 裁决任务包与 `memo curate auto`（v0.2.1-B）

> 对应 issue #21。核心判断：**去重的最终判决必须由正在运行的 Agent 做**，但"让 Agent 判"不等于"让 Agent 手工拼 JSON"。
> 本版把这段链路固化成「生成任务包 → Agent 填空 → 严格校验后落盘」，全程零 LLM 依赖、零 API 成本、可离线。

## 1. 为什么这样做

实测结论（docs/02 §3.5 裁决 26/27、§3.6 裁决 29）：

- 在线词法去重只能做到**零误杀**的保守拦截：中文真人改写 containment 0.43–0.67，内容词全换时 0；汉字二元组 Dice 只用于**召回候选**（无关中文对误聚 1.4%）。
- 语义判断（「这两条是不是同一件事」）需要理解，不能靠阈值。把它交给阈值 = 要么误杀、要么形同虚设。
- 而 Agent（DSH / Codex / Claude）本来就在跑，让它在**读 brief 的时候顺手裁决**，成本为零、上下文最新、还能写理由。

所以 v0.2.1 只做一件事：把"候选 → 裁决 → 落盘"这条路上的人工胶水去掉。

## 2. 命令面

```
memo curate prompt  [--limit N] [--json]     生成裁决任务包
memo curate status                           列出批次与进度
memo curate apply   --file <json>            应用裁决（严格校验）
memo curate export  [--limit N]              （既有）导出待裁决批次
memo dedupe scan    [--dice D]               （既有）只读扫描候选簇
```

`memo curate prompt` 的输出：

```
任务包已生成: /Users/…/.memo/curate/2026-11-02T10-15-00-<rand>.md
批次: batch-2026-11-02T10-15-00-ab12
聚类: 3 簇 / 7 对（strong 4，weak 3）
下一步: 按任务包里的「裁决表」填 decisions，然后
  memo curate apply --file <任务包同名 .json>
```

## 3. 任务包格式

写到 `$MEMO_HOME/curate/<batchId>.md`，同时写一份**机读副本** `<batchId>.json`（Agent 只需回填后者，避免从 Markdown 反解析）。

```json
{
  "batchId": "batch-2026-11-02T10-15-00-ab12",
  "createdAt": "2026-11-02T10:15:00.000Z",
  "scope": "repo:sedimem",
  "policy": { "scanThreshold": 0.45, "scanDiceThreshold": 0.15, "nearDupThreshold": 0.85 },
  "pairs": [
    {
      "pairIndex": 0,
      "ids": ["01M6…AAA", "01M6…BBB"],
      "strength": "strong",
      "containment": 0.62, "dice": 0.41,
      "suggestion": "merge",
      "a": { "label": "sedimem/dedupe-threshold：在线近重复阈值 0.60", "text": "全文…", "kind": "fact", "createdAt": "…" },
      "b": { "label": "sedimem/dedupe-threshold：在线近重复阈值 0.85", "text": "全文…", "kind": "fact", "createdAt": "…" }
    }
  ],
  "decisions": []
}
```

`decisions` 由 Agent 回填：

```json
{ "ids": ["01M6…AAA", "01M6…BBB"], "decision": "merge", "note": "同一事实，保留 0.85 那条（更新）" }
```

`decision` 取值：`merge` | `a_wins` | `b_wins` | `keep_both`（与既有 `curateApply` 一致，**不引入新语义**）。

`batchId` 参与幂等键：同一批次重复 apply，已裁决过的 pair 计 `skipped`，不重复写事件。

## 4. `memo curate apply --file` 的校验（严格，全部拒绝而非部分应用）

| # | 校验 | 失败表现 |
|---|---|---|
| V1 | 文件可解析为 JSON，且含 `batchId` 与 `decisions[]` | `E_INVALID_ARG` |
| V2 | `batchId` 对应的任务包存在（`curate/<batchId>.json`） | `E_INVALID_ARG: 未知批次` |
| V3 | 每条 decision 的 `decision` 在四值内 | `E_INVALID_ARG: 非法 decision` |
| V4 | 每条 decision 的 `ids` 必须是任务包里**某一对**的 ids（顺序无关） | `E_INVALID_ARG: ids 与任务包不符` |
| V5 | 同一个 pair 出现两次 | `E_INVALID_ARG: 重复裁决` |
| V6 | 记录在裁决后仍存在且未 tombstone（并发被删） | 该条记 `skipped` 并在输出里报告，不整体失败 |

**原子性**：先全量校验（V1–V5），任一失败则**一条都不落盘**；通过后按 `decisionKey` 逐个 `curateApply`，逐条记 `applied/skipped`。落盘失败（如锁超时）→ 报告已完成条数与失败的 pair，不谎报成功。

## 5. 与 MCP 的一致性

`memory_dedupe_scan`（MCP）与 `memo dedupe scan`（CLI）已经是**同一份 `service.dedupeScan()` 数据**。任务包的 `pairs` 直接取自该返回值（`pairs[]` 已含 containment/dice/score/basis/strength，裁决 26/27），不再二次计算——避免服务端与 CLI 各算一份导致漂移。

同理 `memo curate apply` 内部调 `service.curateApply()`（MCP 的 `memory_curate(apply)` 也调它），语义只有一处实现。

## 6. `memo curate status`

```
待处理批次: 2
  batch-2026-11-02T10-15-00-ab12  7 对 / 已裁决 0  → 未开始
  batch-2026-11-01T09-00-00-cd34  2 对 / 已裁决 2  → 已完成（2026-11-01T09:12Z）
```

判定「已裁决」用事件流里的 `curate_apply` 事件按 `batchId` 聚合（复用裁决 36 的裁决键），不靠额外状态文件——状态文件会与真相层漂移。

## 7. 失败模式与防线

| 失败模式 | 症状 | 防线 |
|---|---|---|
| Agent 编造 pairIndex/ids | 错配记录被合并 | V4 严格比对任务包 |
| Agent 只填一半 | 部分语义未处理 | 允许部分应用，但 status 明示「7 对已裁决 3」 |
| 任务包与库漂移（期后新写入） | 记录的文本变了 | 裁决时按 id 取**当前**记录；若已 superseded/tombstoned 计 `skipped` |
| 重复 apply | 重复写事件 | batchId 幂等键 + 事件侧 `curate_apply` 已带 batchId |
| 任务包文件被删 | apply 报未知批次 | 提示重新 `memo curate prompt` |

## 8. 测试

**单元** `tests/unit/curate-prompt.test.js`

1. 空库 → 任务包 `pairs: []`，stdout 提示「无候选」
2. 有候选 → 任务包 JSON 字段齐全（batchId/scope/pairs[].ids/strength）
3. `apply` 校验：未知 batchId / 非法 decision / ids 不符 / 重复 pair 各自被拒，且**库未变**
4. 幂等：同一 decisions 应用两次 → 第二次 `applied 0, skipped n`
5. `status`：未裁决 / 部分 / 完成三种状态

**注入用例 I17** `tests/injection/i17-curate-loop.test.js`

- 造 6 条中文改写（3 组）→ `memo curate prompt` 生成任务包 → 按包内 pairs 生成 decisions → `apply` → 断言 active 收敛到 3、败者 superseded、真相层全留（原 6 行 + 补丁 + 事件）、再 `dedupe scan` 无候选；
- 再跑一次 `apply`（同文件）→ `applied 0`，active 不变。

## 9. 回滚

纯新增子命令与文件；`memo curate export/apply` 既有路径保持不变。回滚 = 不调用新命令。
