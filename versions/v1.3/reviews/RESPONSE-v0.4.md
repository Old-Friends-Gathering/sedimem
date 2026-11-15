# v0.4 审核意见处置（arch + adversarial）

审核输入：`reviews/arch-v0.4.md`（架构，判阻断 yes）、`reviews/adversarial-v0.4.md`（对抗，判阻断 yes）、探针 `reviews/probes/v04-*.mjs`。

本轮原则：**阻断项全修**；严重项按「能不能用测试钉住」取舍——能钉住的修并加回归用例（I31–I36），不能在本版安全落地的写进 Known limits 并挂 v0.4.1。

## 阻断项（6 项，全部已修）

| 编号 | 问题 | 处置 | 证据 |
| --- | --- | --- | --- |
| B1 | 脱敏只覆盖 `text`；`value`/`title`/`source.quote` 与 `supersede()` 是旁路 | 新增 `write-path.js: redactInput()`，**四个面逐个脱敏**且不再依赖 text 是否变化；`supersedeRecord` 补脱敏 + 投毒检测；`assignment` 正则补 `"password":"x"` / `DB_PASSWORD=` / 嵌套 JSON（key 前缀 `[A-Za-z0-9_]{0,32}`、分隔符前允许一个关闭引号） | `tests/injection/i31-redaction-surfaces.test.js`（2 例，读真相层文件断言四类密钥都不落盘 + `redacted:*` 标签） |
| B2 | 注入越权：旧 active 快照、raw suspicious、围栏可闭合、预算超发 | `inject.js` 加 `neutraliseFence()`（转义而非删除）；items 兜底**按 id 折叠取最后一行**再筛 active；`tags` 含 suspicious 与 `[suspicious withheld]` 双过滤；预算连围栏都放不下时返回空块（不再输出 71 字符）；文件名走 `config/paths.js` | `tests/injection/i32-injection-hardening.test.js`（3 例：闭合标签只剩结尾一次、旧快照/新版都不注入、`maxChars:50` 返回 null） |
| B3 | 所有 `text/text` 记录共用一个 slot → 无关记录被一条 resolve 连带压制 | `conflict.js` 导出 `isUnstructured()`；`listConflicts` 分组前跳过无结构记录（自由文本的分歧只能走 dedupeScan + Agent 裁决）；`resolveConflicts` 对无结构 winner 抛 `E_INVALID_ARG` | `tests/injection/i33-conflicts-scope.test.js`（3 条无关自由文本 slots=0；结构化 slot 仍可 resolve 且真相层只增不减） |
| B4 | 捕获队列「全量读 + 全量写」并发丢一半 | `queue.js` 加 `withLockSync()`（`mkdir` 原子排他、陈旧锁 10s 接管、5s 超时 `E_LOCK_TIMEOUT`）；`append` 拆成无锁 `appendRaw` + 带锁 `append`；写临时文件再 `rename` | `tests/injection/i34-capture-queue-safety.test.js`（两进程各 100 条 → 200 条） |
| B5 | 向量索引忽略 `row.model` → 换模型后两套向量混算 | 加载时只接受同 `model` 的行；跳过/重复/坏行 → 标记 dirty 并**清理重写文件**（顺带修 S-1 的无界增长） | `tests/injection/i35-vector-model-and-incremental.test.js`（model-b 加载后 size=0、文件里 `model-a` 已消失） |
| B6 | `IndexPort.add` 双参 vs lifecycle 单参 → 在线新增永不产向量；`curateApply` 可复活墓碑 | `hybrid-index.add()` 兼容 `add(record)` 与 `add(id, record)` 两种形状；`applyIdsDecision` 对 `tombstoned` 抛 `E_INVALID_ARG`（MCP `memory_curate` 同样被挡） | `i35` 第 2 例（单参/双参都产向量）、`tests/injection/i36-curate-tombstone-guard.test.js`（keep_both/a_wins/b_wins 全被拒、墓碑仍是墓碑） |

## 严重项（15 项）

已修（6）：
- **S-1** `close()` 不 flush 在途向量 → `lifecycle.close()` 先 `await index.flush()` 再 `flushHits()`。
- **S-3** 队列坏行阻断 → `read()` 跳过坏行并计数，`lastCorrupt` getter 可观察（`i34` 第 2 例）。
- **S-5** 并发 resolve 双重执行 → `resolveConflicts` 整段放进 scope 锁，锁内重读后逐个 apply。
- **S-6** `inject.js` 自拼 Windows 路径 → 改走 `config/paths.js` 的 `itemsFileName/briefFileName`。
- **S-7** `newestScope` 跨分库注入 → **删除该导出**；插件只认 `config.inject.scope` 或 `MEMO_SCOPE`，都没有就不注册（fail closed）。
- **S-8 / S-11** `/api/conflicts` 载荷 → `limit` 参数（默认 50、硬上限 200）+ `truncated/totalSlots`；单 slot 候选对上限 200（`pairTotal`/`pairsTruncated`）。

延期到 v0.4.1（7），理由与入口：
- **S-2** 每次 init 全量重嵌：向量文件已是「派生层」，全量重建是正确性兜底；增量加载需要记录 `contentHash` 对账，属 v0.4.1「向量增量」。
- **S-9** `doctor` 不报 inbox 坏行/积压：`lastCorrupt` 已有出口，接入 doctor 报告要同时定「inbox 积压」阈值。
- **S-10** policy 只部分生效（search 排名/write suspicious 用模块常量）：改成全量 policy 注入会影响 v0.3 起的行为矩阵，需要一次单独的等价性验证。
- **S-12** `buildInjection` 每步读整文件：当前先以 `ITEMS_TAIL_LINES` 截断候选，但读取仍是整文件；改「按字节倒读」要与跨平台换行一起测。
- **S-13** `search({filter})` 语义路不成立：语义索引没有 filter 字段，需先给向量行加元数据。
- **S-14** `accept` 非事务：单条失败已隔离并报告；「整批原子」需要 inbox 版本号 + 两阶段。
- **S-15** `extract` 忽略 policy：词表目前是常量，开放成 `policy.capture.cues` 要同步文档与测试。

驳回（2）：
- 「`/api/search` 默认 `degraded:true` 是错误」——**这是设计**（D1：未启用语义道时显式标记 `semantic-disabled`，避免被读成"检索正常但没结果"），已在 `docs/08 §14` 写明。
- 「注入应改宿主 `messages` 才能真正生效」——**不做**（裁决 64：不改宿主消息数组，只用 `systemPrompt.context`；模型侧看到的是 system 上下文，改 messages 会污染会话历史与回放）。

## 新增回归用例

`tests/injection/i31..i36` + `eval/cases/i31..i36.json`，全部登记在 `eval/run.js` 的 `CASE_FILES`。当前：**382 tests / 382 pass**、**eval I1–I36 全 PASS**、质量 9/9、安全 9/9、覆盖率 lines 93.67% / branches 81.52% / functions 92.65%。
