# v1.2 计划对抗性审核 · 角度：成本与性能

> doc-kind: history
> doc-version: 1.2
> 说明：本文件是对特定时点计划/代码的审核快照，内容冻结（引用当时的 versions/v1.1），不随版本升级改写。

> 审核对象：`docs/plans/v1.2-task-context-ledger.md`（untracked，HEAD `99baad1`）；代码基线 `versions/v1.1`（只读，未改任何文件）。
> 方法：读代码 + 对本机真实 DSH transcript 实测（node v22.23.2，`~/.dsh/sessions/--Users-yeager-work-yeager-ldywoker--/session-85533211-.../session.v4.jsonl.zstd`）。报告内数字未标注均为实测；估算法均标"外推"。

## 0. 结论（先给判断）

- **阻断 1 条**：计划第 57 行「`transcript.js` 已能解 zstd 多帧」为假——真实 DSH v4 transcript 是 16,994 个 zstd 帧，`zstdDecompressSync(整文件)` 只解出首帧 **214 字节**（header 1 条 record），流式解码在第二帧抛 `Unknown frame descriptor`；即使解压修好，`recordToTurn` 也匹配不到 `user/message`/`assistant/message`（它只认 `user_message`/`assistant_message`）。→ 当前 `readDshTranscript → toTurns` 恒为 0 turns，capture 全链路空转且**静默不报错**。
- **高 3 条**：①全量解析是 O(N²)（本会话规模约 190 次 × 1.4s / 峰值 791MB）；②LLM 日预算没有任何生产代码调用者，`--llm` 成本无闸；③段 `value` JSON 必撞 `MAX_VALUE=2000` 硬上限，长任务整段写失败。
- **中 2 条**：`captureGrowthTokens=20000` 本身不算过频（与 BC 22.5K 同量级），但前提是增量读；规则模式只可见 0.6% 的字节，结构性达不到 I53 的「3 决策/2 卡点/3 文件」。
- **低 2 条**：pre-step 注入（默认关）才影响宿主 prompt cache，capture 写任务库本身不影响；观察台 `/api/tasks` 是全库同步扫、展开原文会每次全量重解析。

## 1. 实测基准（22.2MB 真实 transcript）

| 项 | 实测 | 说明 |
|---|---|---|
| 压缩体 / 解压体 / 事件数 | 22.2MB / 67.4MB / 34,458 | 压缩比 3.0×；与设计文档「63.9MB、34,184 事件」同量级（文档标注为"逐帧解压"口径） |
| zstd 帧 | 16,994 帧，无长度前缀（帧 magic 直接相邻） | 整文件同步解码只出首帧；必须逐帧扫描 |
| 全量解析管线 | 1.41s（解压 622 + join 329 + split 78 + parse 379ms），RSS **791MB**/heap 294MB | 现状 `parseJsonl` 形状；Node 默认 heap 4,144MB，本机不 OOM，1GB 容器 OOM |
| 逐帧流式（不保留） | 814ms，峰值 RSS **117MB** | 修复方案实测可行 |
| 增量读尾部 200 帧 | 299KB → 422 事件 → **11ms** | 增量 capture / expand 的成本基线 |
| 事件字节构成 | assistant/message 38.98MB（其中 `stream` 增量块 29.15MB=47%）；tool/result 5.6；tool/call 4.94；job/* 8.0；request/header 2.12 | 47% 是 UI 回放用流式块，对 capture 无用 |
| capture 可见文本 | user text 0.23MB + assistant text 0.14MB = **0.37MB（0.6%）**；含 tool 参/果 7.6MB（12%） | 规则抽取"只看对话文本"必然丢文件与错误 |
| token 账（4,944 条 `usage`） | Σinput 30.04M / Σoutput 2.45M / ΣcacheRead **1,485.55M** → 缓存命中 **98.0%** | 宿主侧；用于 §⑤ 判断 |

## 2. 发现清单表

| # | 严重度 | 证据（file:line / 计划章节） | 影响 | 修法 |
|---|---|---|---|---|
| C1 | **阻断** | `versions/v1.2/src/session/transcript.js:92-93`（单次 `zstdDecompressSync`）；`:24-45`（只认 `user_message`/`assistant_message`，真实事件为 `user/message`、数据在 `data.*`）；计划 §2 第 57-58 行；测试夹具 `tests/injection/i45-session-llm.test.js:119-121` 用自造旧形状 | 修好前：header 1 条 record、0 turns，capture 产空段却"成功"；计划「复用 `parseDshSummary`」也随之落空（真实 transcript 里无 `compact-checkpoint` 事件）。I53/I57 会假通过或恒失败 | 逐帧扫描 + 事件适配层（`data.content`/`data.message.content`/`tool/call`/`tool/result`）；用真实 transcript 切片做 golden fixture；加不变式：records<2 或 turns==0 → `E_CAPTURE_FAILED`（禁止静默） |
| H1 | **高** | `transcript.js:92-94` + `parseJsonl:54-69` 全量保留；实测 1.41s/791MB；计划 §2 第 60 行 close 强制 capture、第 61 行 nightly `--if-needed`；无 anchor 字节偏移（见 H4） | 约 190 次 capture/长会话 → ≈4.4 分钟 CPU + 190 次 ~790MB 瞬时峰值（O(N²)）；close 每次 +1.4s；10 个 open 任务 nightly 扫描 ≈14s | ①逐帧流式（117MB）；②`sessions/<id>.json` 记 `lastSeq/frameOffset`，只解尾部帧（11ms）；③文件增长 >50MB 时降级到 host checkpoint 摘要 |
| H2 | **高** | `src/llm/budget.js:70`（`chargeBudget`）全仓仅测试引用（`grep -rn chargeBudget src` 无生产调用）；`src/llm/port.js:14-19` purpose 表硬编码、`:118-120` 未知 purpose 直接 `E_INVALID_ARG`；`policy.json:166-179` 的 `purposes` 无代码读取（`grep purposes src` 零命中）；计划 §2 第 59 行、§7 第 105 行 | ①`--llm` capture 会因未知 purpose 直接失败，`policy` 加键无效；②`dailyLimitCny:5` 从未生效，重试/批量下成本无上界；③按 transcript 实测 Σinput 30.04M×0.8 元/M≈¥24/session，5 元阈值与真实用量差 5-6× | purposes 改为 policy 驱动；capture 调 `isBlocked`+`chargeBudget`；把 `src/llm/port.js`、`src/llm/budget.js` 写进 B1 写盘范围；单测断言超限 blocked |
| H3 | **高** | `src/core/record.js:20,33,45-46`（`MAX_VALUE=2000`，`effectiveWriteCaps` 只能缩不能涨）、`:86-98`（超限直接抛 `E_INVALID_RECORD`，不截断）；计划 §1 第 37-43 行 value 含 6 个数组+anchor；`policy.json` capture.maxItems=50 | 元数据≈400 字 + 10 files×60 + 3 decisions + 2 gotchas + … ≈1,550 字，抽到 20 files/5 decisions 即超 2,000 → 整段写失败；长任务恰最需要段，close 强制 capture 会让会话关不掉 | value 只留索引/区间（seq/fromSeq/toSeq/anchor/tokens，≤300 字），明细写 sidecar（anchor 指向的 JSON 文件或独立 kind）；写前 `assert value.length<=caps` 并把数组裁到预算内 |
| H4 | **中** | 计划 §0-1 第 13 行、§1 第 42 行 anchor 只有 `{path, bytes, compressed}`，无字节区间；§4 第 78 行「展开原文」 | 每次点「展开原文」= 全量重解析 1.4s/790MB；190 段的可逆性形同虚设 | capture 逐帧扫描时顺手记 `fromByte/toByte`（帧偏移已算出），expand 只读 1-3 帧（≈299KB/11ms 实测） |
| M1 | **中** | 计划 §0-2 第 14 行、§2 第 63 行；`transcript.js:141` `compactTranscript` 默认 12,000 字；`checkpoint-llm.js` 用 `chars/2` 估 token | 20K 阈值在真实会话产生 **150-215 次** capture（Σoutput 2.45M + 工具输 ≈1.8M + user ≈0.06M ≈4.3M tokens；文档 2.957M/20k=148 同源，非独立验证）；阈值不坏，坏在放大成全量解析 | growth 直接用 `assistant/message.data.usage`（本会话 4,944 条，含 input/output/cacheRead）累加 output+tools，别用 chars/2；`--if-needed` 先比 mtime/大小跳过未变任务 |
| M2 | **中** | `checkpoint.js:90-94`（`parseDshSummary` 只填 currentState）；`transcript.js:36-42`（tool 块被丢）；实测字节构成（0.6% 可见）；计划 §2 第 58 行、§5 I53 第 84 行 | 规则模式 8 段里 7 段为空；文件在 tool/call.arguments、错误在 tool/result、决策多在 reasoning，全部看不到 → I53「3 决策/2 卡点/3 文件 100%」结构性不可达，只能被迫 `--llm`（成本变必选） | 规则抽取读 `tool/call.arguments`+`tool/result.text`（+reasoning 可选，新增 ~12MB 扫描/100-200ms）；给"决策/坑"可机械判定规则；I53 拆 rule（文件 3/3、决策 1/3）与 llm（全 3/3）两档门槛 |
| L1 | **中低** | 计划 §3 第 72 行 pre-step 注入；实测缓存命中 98.0%；`docs/research/host-compaction-2026.md:89`（摘要追加尾部以复用 cache） | capture 只写 `~/.memo`、transcript 只读（计划 §7 第 103 行），**不影响**宿主 cache；但若每步注入 1,200 字：4,944 步 ≈5.9M 字符≈3M tokens（+10% 输入），若注入在 system/前缀则 98% 命中归零（Manus：uncached 成本 10×） | 注入限定"会话第一步一次"且只追加在尾部；`--auto` 语义写死为"定位 transcript，不产出注入" |
| L2 | **低** | `src/session/lifecycle.js:362-417`（`listSessions` 全库 `readFileSync`+逐行 JSON.parse）、`src/web/api/write.js:150-153`；`src/api/read-only.js:64`（`/api/records` 走内存索引，便宜）；计划 §4 第 76-80 行 | 实测 42 行/ms：100 任务/1,000 段≈24ms；若 100 个都是长任务（~450 行/任务）≈45,000 行→**1.1s 同步阻塞**单线程服务；1,000 段 `/api/records` ≈1.5-2MB JSON+1,000 行 DOM（DOM 未实测） | `/api/tasks` 按 items 文件 mtime/size 缓存段数；timeline 分页 100 段/页；统计条 tokens 在 capture 时增量累加，别每次扫全库 |
| L3 | **低** | `src/api/lifecycle.js:139-141`（commit 后 `enqueueDerive` 无 kind 过滤）；`policy.json` 无 derive 排除名单 | provider 打开后每写一个 context 段入一次 derive 队列（≈190 次/会话），多一次 LLM 调用与队列膨胀 | `context` 加入 derive 排除（policy.derive.excludeKinds），B1 顺带改 `enqueueDerive` 调用点 |

## 3. 六个攻击点逐条回答

**① 63.9MB/34k 事件解析的耗时与内存：不会 OOM（本机），但成本被"全量重读"放大。** 63.9MB 若是解压体（设计文档口径，实测同会话 67.4MB），全量管线峰值 **791MB RSS / 1.41s**；Node 默认 heap 4,144MB 不会 OOM，1GB cgroup/CI 会。**当前代码根本走不到这一步**（只解首帧），所以这笔成本是"修复后才出现、计划没算"。修复必须流式（117MB）而非"先全解再 parse"。若 63.9MB 指压缩体，则按 3.0× 压缩比是全量管线的 2.9×（≈2.3GB/4s），需作者澄清口径。

**② captureGrowthTokens=20000 是否过频：不过频，前提是增量读。** 按文档 2.957M tokens/20k=148 次；按 transcript `usage` 独立估算 4.3M tokens 增量→**150-215 次**（会话若 4-6h，约每 1.5-2.5 分钟一次）。账本体积可忽略：190 段 ×（≤400 字 text + ≤2KB value）≈0.5MB/任务。真正的成本是 H1：190 次全量解析 ≈4.4 分钟 CPU、190×790MB 瞬时 RSS。改成增量后单次 11ms，总 ≈2s，可忽略。`rawTailTurns` 保持 12 轮也不便宜——12 轮工具输出可达数万 token，它只是不进段，不影响解析成本。

**③ 规则模式抽取质量：不够，且 I53 不可达。** 修好 schema 后规则模式可见文本仅 0.37MB/61.4MB（0.6%）；文件路径在 `tool/call.arguments`（4.94MB）、错误在 `tool/result`（5.6MB）、决策多在 reasoning（2.04MB），而 `toTurns` 丢弃 tool 块。`parseDshSummary` 只填 `currentState`，8 段中 7 段空。→ 规则模式能给出"文件+下一步"的粗结果，给不出"2 个卡点"；I53 要么分档，要么默认就得上 `--llm`（成本从选配变必配）。

**④ `--llm` 成本上界与失败重试：单次便宜、重试与"无闸"才贵。** 单次：12,000 字（≈6k token）×0.8 元/M + 400 out×2.8 元/M ≈ **¥0.006**；若直传 20k-token 段 ≈¥0.017。190 次/会话 ≈**¥1.1-3.3**。失败重试：`maxRetries=2` → 3 次 × 20s 超时 + 2×2s 退避 ≈ **最坏 64s 阻塞**，若计费按发起算最坏 ≈¥10；`checkpoint-llm.js` 式"失败回落 rule 且永不抛"会让成本与质量都不可见。**上界目前不存在**：`chargeBudget` 无生产调用者、`purposes` 硬编码（H2），`--llm` 实际会 `E_INVALID_ARG`，即使打通也无预算拦截。

**⑤ capture 写任务库是否影响宿主 prompt cache：不影响（仅追加），风险在注入。** 写的是 `~/.memo/items/<scope>.jsonl` + events + derive 队列（3 次追加/lock），DSH transcript 只读，宿主请求前缀不变；实测本会话缓存命中 98.0%（cacheRead 1,485.55M / 总输入 1,515.59M），§0-7「只追加不重写前缀」成立。会坏事的是 §3-72 pre-step 注入：每步 1,200 字 ≈ +3M tokens（+10% 输入），且一旦注入位置在 system/历史前缀，98% 命中归零（Manus uncached 10×）。默认关是对的，但要把"只追加尾部、仅首步"写进契约。

**⑥ 观察台 100 任务/1,000 段：可接受，但两处要改。** `/api/tasks` = `listSessions` 全库同步扫（42 行/ms）：1,000 段 ≈24ms 没问题，100 个长任务（~45,000 行）≈1.1s 会卡住整个服务（单线程事件循环）；建议 items 文件 mtime/size 缓存。`/api/records` 走内存索引（`read-only.js:64`），1,000 段 ≈1.5-2MB JSON，便宜。渲染 1,000 行时间线（每行 ~5 节点）估计 50-100ms（**未实测**，无浏览器基准）；真正贵的是点「展开原文」= 全量重解析 1.4s/790MB，见 H4。天真的分区方案：任务页列表已按 updatedAt 排序，再加"每页 20 任务"即可，不必动数据层。

## 4. 我认为计划必须改的 3 条

1. **把「读 transcript」提为 B0 前置任务并重写，删掉计划第 57-58 行的错误前提。** 现状是三重不匹配（多帧 zstd / 事件 type 与 `data.*` 嵌套 / `ts` 字段），`readDshTranscript` 恒返回 1 条 header、`toTurns` 恒 0，且失败静默。B1 写盘范围（§6 第 95 行）明确不含 `transcript.js`，等于让 capture 建在空地基上。必须：逐帧扫描解码 + v0-v4 schema 适配 + 真实 transcript 切片 golden fixture + `records<2||turns==0 → E_CAPTURE_FAILED`。

2. **capture 一律增量：`sessions/<id>.json` 记 `lastSeq/frameOffset`，anchor 记 `fromByte/toByte`。** 否则 20K 阈值会在长会话里变成 ~190 次 × 1.4s/790MB 的 O(N²)（close 还每次 +1.4s），「展开原文」每点一次 1.4s。实测逐帧流式 814ms/117MB、增量尾 200 帧 11ms、expand 只需 1-3 帧——方案已验证可行，成本差 100-400×。

3. **LLM 成本闸门必须真接线，而不是写在计划里。** `policy.llm.purposes` 当前无代码读取（purpose 表硬编码在 `port.js:14-19`），`chargeBudget/isBlocked` 无生产调用者，`--llm` 会直接 `E_INVALID_ARG`；计划却把「每日预算沿用 `dailyLimitCny`」当兜底。必须：purposes policy 驱动（含 capture.maxInputTokens ≥ 尾部窗口）、capture 走 isBlocked/chargeBudget、`src/llm/port.js`+`budget.js` 写进 B1、单测断言 blocked；同时把 5 元/日的阈值与实测 ~¥24/session 的口径对齐（否则接通即全天 blocked）。

## 5. 无法估 / 未验证

- **宿主侧真实单价**：provider 为 `zai-coding-cn`（订阅制），每 session 边际成本不可见；上文 ¥ 金额只用 `policy.llm.price`（memo 侧 LLM 端口），不代表宿主账单。
- **63.9MB 口径**：设计文档第 10 行标注"逐帧解压"，与实测 67.4MB 吻合，故按解压后处理；若作者原意是压缩体，内存/耗时需 ×2.9。**未与作者确认**。
- **145 次压缩 / 295.7 万 tokens**：34,458 个真实事件里没有 `compact-checkpoint` 类型事件，无法从 transcript 复现；该数字更像 ACP 侧压缩统计。**未验证**，故 ② 改用 `usage` 独立估算。
- **计划 §2 `--auto` 语义**：是"自动定位 transcript"还是 DSH hook 注入？决定 ⑤ 是否成立，计划未定义。**未验证**。
- **浏览器端 1,000 行时间线渲染耗时**：无浏览器基准，仅按节点数估 50-100ms。**未实测**。
- **并发**：多任务同时 capture（nightly 串行 vs 并行）未定义；若并行，峰值内存按任务数线性叠加（2 GB 容器下 2 个长任务即危险）。**未验证**。
