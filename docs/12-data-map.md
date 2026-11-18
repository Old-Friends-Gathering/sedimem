# 12. 数据地图与保留期

> doc-kind: manual
> doc-version: 1.4
> verified-at: 2026-11-17
> verified-against: versions/CURRENT（v1.4 / 1.4.0）

本页回答四个问题：数据落在哪里、属于哪一类、保留多久、怎么导出/删除。它是 P0b 的运维与隐私契约，不替代 [`02-data-model-and-contract.md`](02-data-model-and-contract.md) 的字段级规格。

## 12.1 数据类别与位置

| 类别 | 路径 | 内容 | 敏感级别 |
|---|---|---|---|
| 真相层 | `~/.memo/items/<scope>.jsonl` | 记录快照（append-only，同 id 最后一行胜出） | 高：可能含个人事实、决策、引用 |
| 事件/审计 | `~/.memo/events.jsonl` | 写入、检索、注入、删除、信任提升、任务库操作 | 高：只存 id/哈希/选择器，不存正文；注入审计存 packHash |
| 任务库 | `~/.memo/sessions/<taskId>/segments.jsonl`、`<taskId>.json`、`autocapture.json` | 任务账本段、8 段 checkpoint、简报、自动捕获运行状态（mtime/size/上次时间，可删） | 高：过程记录，永不进 facts |
| 捕获待审 | `~/.memo/inbox/<scopeKey>.jsonl`、`*.quarantine.jsonl` | 候选；隔离区只存 `uri+hash+quote(≤200)` | 中：可能含第三方内容 |
| 索引/视图 | `~/.memo/index/`、`views/`、`brief/`、`derive-queue/` | 可删可重建的派生层 | 中：由真相层派生 |
| Web 运行时 | `~/.memo/web-token`（0600） | 每次 `memo serve` 启动随机生成 | 高：等同本机 API 凭据 |
| 配置/覆盖 | `~/.memo/.scope.<client>.json`、`profiles.json` | 分库指针、profile 映射 | 低 |
| 临时导出 | `/tmp/...`、用户指定路径 | `memo export` / `memo import` 的中转文件 | 由用户负责 |

## 12.2 保留期（默认值，policy 可调）

| 数据 | 默认保留 | 说明 |
|---|---|---|
| 真相层记录 | 永久（墓碑保留） | `forget`/`deleteBySource` 只追加墓碑；历史 as-of 仍可回查 |
| 任务账本段 | 90 天（可配） | `capture.ledgerRetentionMs`；过期由 nightly/`session sweep` 报告，不静默删 |
| 任务库 open | 14 天未活动 → sweep 候选 | `session sweep` 只报告，不自动关闭 |
| 捕获候选 inbox | 14 天 | 未 accept 的候选可清理 |
| 隔离区 | 90 天 | `capture.quarantineTtlMs` |
| events.jsonl | 90 天（可配） | 审计/注入回执；归档由用户决定，代码不自动删 |
| 索引/视图/brief | 可随时重建 | 删除不影响真相层 |

## 12.3 删除与导出

- 单条删除：`memo forget <id>` → 墓碑；真相层不减行。
- 按来源删除：`memo forget --source-agent <a>` / `--source-session <s>` / `--content-hash <h>`；会清 items 索引、向量、brief 与任务账本，并写脱敏 `delete_source` 事件。
- 验证：`memo verify-delete --source-agent ...`（或 session/hash）逐项检查 items/index/vector/brief/账本；有残留非零退出。
- 整库/任务库：`memo session remove --scope session:<id> --yes` 移入 `trash/`（可恢复），不是物理删除。
- 导出：`memo export --format jsonl`；导出文件含 trust/taint 与 provenance 字段，便于迁移到其它记忆库。
- 备份：`~/.memo` 不进 git；Time Machine / iCloud / OneDrive 会复制 0600 文件，若要避免，请在备份工具里排除 `~/.memo`。

## 12.4 PII 与第三方内容

- 写入前统一过 `redactText`：邮箱、手机号、证件号、IP、API key/token 等按类别替换为 `[REDACTED:<kind>]`，落盘前生效。
- 日历/邮件等第三方内容（P2 起）：只保留与本人相关的字段（from/to/attendee/subject/time），正文默认哈希或不存；共享日历需告知参与者。
- 任务账本段过 `redactText` + `detectSuspicious`；命中注入证据的段标 `quarantined=true`、`taint` 含 `suspicious`，不进简报。
- 本机边界：`~/.memo` 权限 0700/0600 只挡其它本机用户；同 UID 进程仍可读，这是本地优先模型的已知边界，不承诺机密性对抗同 UID。

## 12.5 P1a pilot 评测资产（v2.0 规划期）

P1a 的评测资产存放在仓库 [`pilot/p1a/`](../pilot/p1a/corpus/README.md)（不在 `~/.memo`），是开发/评测数据，不是运行时数据。新资产按 [`design/v2.0/02-evidence-and-deletion.md`](design/v2.0/02-evidence-and-deletion.md) §8 登记：保留期/条数上限框架冻结、数值归 P1b 填；在此之前按 fail-closed 处理（不自动清理、不自动重新 capture、删除动作人工留痕）。

| 资产 | 路径 | 内容 | 状态 |
|---|---|---|---|
| 语料（pilot v0 → exit） | `pilot/p1a/corpus/*.jsonl` | 合成脱敏场景 + gold + 对抗标注（exit：218 场景/347 gold/对抗 10 类 test 各 10，含 split） | 已提交（PR #221、PR #240） |
| 校验/基线/评分/复核/切分/盲评/守卫工具 | `pilot/p1a/tools/` | corpus-validate / baseline-runner / score / review / protocol-sim / split-corpus / annotation-pass / contract-guards | 已提交（PR #221、B2、B3、B4） |
| 盲评包与裁决工作表 | `pilot/p1a/out/blind/`（gitignore） | 盲评包（剥离 gold 侧字段）+ 导入校验 + 一致性报告 + 裁决工作表；含第二标注人标注产物 | 本地生成，不入库（含人工标注内容） |
| 冻结配置 | `pilot/p1a/config/eval-manifest.json` | 门槛与配额（改数须版本化 diff + 签署） | 已提交（PR #220） |
| 验证轨输出 | `pilot/p1a/out/`（gitignore） | 候选 jsonl / meta / 评分报告；本地可重建，不入库 | 每次运行带 runId |

要求：baseline/score 每次运行输出必须带 runId 落盘（输入与结论成对保留）；语料场景删除/修改须在对应 REVIEW 留痕；pilot 阶段评分器不得输出 pass/fail（fail-closed）。
