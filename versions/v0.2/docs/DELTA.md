# v0.1 · 版本说明（DELTA）

> **0.1.2 增量（2026-11-02）**：本版新增「不被自己腐化」的机制——四道门禁（质量/安全/覆盖率/issue 关联）+ 四个 CI workflow，
> 以及并发漏读缺陷根治（`_reload` 先取水位再读，见 CHANGELOG [0.1.2]）。产品更名 strata，技术标识保持不变。

## 本版做了什么

P0 可用闭环 + **确定性**卫生 + **Agent 当裁判的去重闭环**。目标是先把「不变量」立住（真相层不可变、id 稳定、过期即失效、删除可审计），再把「重复/冲突/冗余」这条用户最痛的问题用零成本方式闭上环。

| 能力 | 状态 | 说明 |
|---|---|---|
| 真相层 `items/<scope>.jsonl` | ✅ | append-only，同 id 最后一行胜出；`reindex` 只读；增量读 `loadScopeIncremental` |
| 倒排索引（BM25） | ✅ | 纯 JS 内存索引，启动时从真相层重建；`size` 入契约（可换 sqlite） |
| hash 去重 | ✅ | `sha256(normalizeText(text)+slot)`，零 LLM，跨进程锁内判定 |
| 同 slot 同值短路 | ✅ | 换措辞的**字面近似**重复不增长（containment ≥0.85） |
| 语义去重（Agent 裁判） | ✅ | 真人改写去 `dedupeScan` 聚簇 → 模型判定 → `curateApply` 非破坏合并（I11 英文 / I12 中文） |
| 中文改写召回（0.1.1） | ✅ | 双路候选：containment ≥0.45 或 汉字二元组 Dice ≥0.15（纯英文对 Dice=0，不引入 13.68% 的英文误聚） |
| 冲突失效（supersede） | ✅ | 值可比较（时间/数字）时自动取代；旧记录写 `validTo` |
| 不确定即 disputed | ✅ | 不可比较的异值并存 + 入裁决队列，绝不静默覆盖 |
| bi-temporal + `asOf` | ✅ | 按时间戳比较（UTC ms），可回查「当时有效」的版本 |
| 墓碑删除 | ✅ | `forget` 只写 tombstone，不物理删 |
| 确定性 brief | ✅ | ≤80 行；suspicious 行占位；末尾提示待裁决去重候选数 |
| 裁决批次 curate | ✅ | 导出 → Agent 签字 → 回写（`decisions:[{ids,decision,note}]`） |
| 投毒防线 | ✅ | 归一化（NFKC/零宽/CJK 空格/异体字）+ base64/拆字/拼音启发式；读路径默认遮蔽 |
| MCP stdio（10 工具） | ✅ | 三端唯一缝；严格参数校验、响应串行、未 initialize 拒绝 |
| eval（11 注入 + 指标 + 基准） | ✅ | 门禁见 `docs/ACCEPTANCE.md`；I7b 如实记录「词法不覆盖真人改写」 |

## 本版刻意不做（附理由）

| 不做 | 理由 |
|---|---|
| 向量/embedding | 5k 条以内词法 + 实体键 + Agent 裁判足够；先证明治理机制，再加检索能力 |
| 图数据库 | 冲突消解靠 (subject,predicate) 约束，不需要图 |
| 自动摘要分层 | 加工本身会腐化（FlexA-Mem），v0.1 只做确定性渲染 |
| 跨机同步 | 单机需求未验证，先不引入 git 冲突合并 |
| JSONL compact | 容量上限 5000 条 + 墓碑，短期无压力；v0.2 做 |
| 夜间无人 LLM 裁决 | 需要 `JudgePort` 注入点与 API 预算；v0.1 用「正在运行的 Agent」当裁判，零成本 |

## 与上一状态的关系

这是从零开始的 v0.1，没有「上一版」。参考实现对照：
- 取代 `dsh-memory@0.1.0`（只有 INSERT/DELETE，无去重/冲突/过期）—— 用 `memo migrate dsh-memory` 搬运存量。
- 不采用 mem0 v3（ADD-only，显式放弃冲突消解）。
- 借鉴 Graphiti 的 bi-temporal 失效、mcp-memory-service 的四类卫生动作，但去掉它们的服务端依赖。

## 与最初的差异（第二轮审核后修正的认知）

1. **「换措辞重复」不能只靠词法**：实测 5 句真人改写词面相似度只有 0.4–0.5，写入门控会全部放行（这是正确的：不误杀）。语义去重改为「候选发现（0.45）+ Agent 判定 + 非破坏合并」，并在 I7b 里**把这个限制固化成断言**，防止未来谎报。
2. **跨进程一致性是阻断级**：常驻 MCP server 的内存快照会漏掉别的进程写入，必须锁内「重读→判定→追加」。
3. **「词法完全不行」只对英文成立**：中文真人改写如果保留名词，containment 能到 0.55–0.67（写入门控 0.85 仍不误杀、扫描 0.45 就能召回）；只有「内容词全换」才需要汉字二元组 Dice。IDF 加权、全字符 Dice、降到 0.10 三种加强方案都有实测反例，已写入 §3.5。
4. **`source.agent` 不收窄成枚举**：否则新客户端（grok/opencode）接不进来；改成自由标签 + 保留名黑名单。

## v0.2 入口（按优先级）

1. `JudgePort` 注入点 + `judge-llm.js`（夜间无人裁决；接口已在 `docs/03` 列为 Port）。
2. `src/index/sqlite-index.js`（IndexPort 第二实现，验证可替换性）+ `MEMO_INDEX` 切换。
3. `kind`/`status` 注册表数据化（新增 kind 只改 policy）。
4. `memo compact`：墓碑与历史版本压缩（必须保号、必须可回放）。
5. 错误码归一（`E_MEMO_HOME_UNWRITABLE`）+ metrics 时间序列与趋势告警（`conflict_rate` 连续上升 → 提示整理）。

## 0.1.3 增量（2026-11-02）：只读 Web UI「记忆观察台」

在 0.1.2 之上补「人看的窗口」：`memo serve` 起只读服务（仅 127.0.0.1），三页静态 UI（今日变化 / 记忆图谱 / 卫生洞察），零构建零依赖零外链。

- **数据面**：`service.events()` / `service.exportRecords()` 两个只读方法（裁决 30）；metrics 快照按 scope 分文件、兼容读旧名（裁决 31，修复多分库同日互相覆盖）。
- **服务面**：7 个 `/api/*` 只读端点（裁决 32 时区由调用方给、裁决 36 裁决键聚合、裁决 38 activeRatio 百分比趋势）。
- **图谱**：力导向动态图，same-entity 边为 createdAt 时间链（裁决 35），label 服务端生成（裁决 37），边开关存 localStorage。
- **规模**：单测从 117 → 146（+29）；I1–I12 评测与 bench 快照不变（n5000 write p95 5.72ms / search p95 2.83ms，`eval/results/LATEST.json`）。
- **边界不变**：不做导出、不做写操作、不做远程访问；写入入口仍只有 CLI 与 MCP。
- 语义裁决与实现偏差详见 `docs/02` §3.10 与 `docs/08` §12。

## 0.1.4 增量（2026-11-02）：SQLite FTS5 索引 + curate 裁决任务包

v0.2.1 的两个能力（代码合入本版）：**A) 检索后端可换**（`index.backend=memory|sqlite`，验证 IndexPort 扩展点），
**B) 去重裁决去掉人工胶水**（任务包 → Agent 填空 → 严格校验落盘）。契约见 `docs/09-sqlite-index.md` 与 `docs/10-curate-auto.md`。

### 做了什么

- **SqliteIndex（FTS5，WAL）**：`src/index/sqlite-index.js`（262 行）+ 构造点 `src/index/create-index.js`（69 行）。
  与内存索引同一套接口语义（同一 `tokenize()`、同一排序/过滤/limit 约定、BM25 负分转正）。
  落盘 `$MEMO_HOME/index/<scopeKey>.sqlite`，派生层可删可重建（`memo reindex`）；损坏自愈（行数不符 → 删库重建 + `IndexRebuilt` warning）。
- **IndexPort 可插拔性实测成立**：`service.js` 只改了 import（`src/api/service.js:10`）+ 一行 `createIndex` 调用（`src/api/service.js:53`），
  没有任何 `if (impl === 'sqlite')` 分支散落——`docs/03` §2 的判定标准通过。
- **fail-loud**：`node:sqlite` / FTS5 不可用 → 启动即抛 `E_INDEX_UNAVAILABLE`（提示升 Node ≥22.5 或改回 memory），**不静默降级**。
  首次创建打一句「node:sqlite 为实验特性」warning。
- **curate 任务包**：`src/cli/curate.js`（342 行）+ `memo curate prompt|status|apply --file`。
  任务包（`curate/<batchId>.md` 人读 + `.json` 机读）的 pairs 直接取 `service.dedupeScan()`；Agent 回填 `decisions[]`
  （`merge|a_wins|b_wins|keep_both`，不引入新语义）；V1–V5 校验失败一条都不落盘；V6 并发被删计 `skipped`。
- **幂等与状态**：重复 apply 对已裁决 pair 计 `skipped`（事件流 `curate_apply` 裁决键聚合，裁决 36 语义）；
  `curate status` 用同一事件流判进度，不靠额外状态文件。无候选时 `prompt` 正常退出不写文件。
- 测试：单元 147 → 165（sqlite-index 9 + create-index 4 + curate-prompt 8），注入新增 I16（两后端检索一致）/
  I17（curate 闭环）；**182 tests / 182 pass**，eval I1–I17 全 PASS。

### 双审核后修掉的四个严重项（v0.2.1 收尾）

| # | 问题 | 修法 |
|---|---|---|
| S1 | 两后端 `limit` 缺省行为相反（内存 10 / sqlite 不截断） | sqlite 对齐默认 10；契约 §3.12 写明「要全量显式传 `index.size`」 |
| S2 | 绕过 `build()` 后 `search` 静默返回空 | 抛 `E_INDEX_STALE`（fail-loud），并如实写明「`.sqlite` 不是启动加速，每次启动仍全量重建」 |
| S3 | `curate prompt` 不收敛：已裁决 pair 反复出现、批次无界增长 | `curatePrompt` 按 `decidedKeys` 过滤候选（回归用例：已裁决 pair 不得重发） |
| S4 | 一致性检查是假检查（external-content 表 `count` 恒等）+ 无查询 token 上限 | 改 FTS5 `integrity-check` + `MAX_QUERY_TOKENS=256`（实测 50k 词项 848ms） |

附带：`batchId` 随机后缀 2→4 字节（撞名会静默覆盖旧批次）、任务包 `nearDupThreshold` 改读 `policy.json`（不再硬编码 0.85）。

### 刻意不做

| 不做 | 理由 |
|---|---|
| 向量/语义检索 | 与 docs/09 非目标一致；hybrid 仅当 `stale_hit_rate` 有实测痛点（docs/03 §5-6） |
| `MEMO_INDEX` 环境变量切换 | 切换收敛到 `policy.json` 的 `index.backend` 一处；env 覆盖等有第二配置源的需求再加 |
| `memo curate auto` 单命令闭环 | 本版把链路拆成 prompt / apply --file / status 三步（Agent 在中间填 decisions）；全自动调 LLM 裁决仍等 `JudgePort`（v0.2 候选 1） |
| 多进程并发写 sqlite 索引 | 与真相层「同一 scope 单写者」约定一致；不做跨进程写并发 |
| `MEMO_INDEX` 环境变量 | 切换收敛到 `policy.json` 的 `index.backend` 一处；有第二配置源需求再加 |

### v0.2.1（已交付，2026-11-06）

施工图见 `docs/plans/v0.2.1-plan.md`（对应 issue #32–#37）。本轮 5 个交付项**均为进行中 / v0.2.1 将提供**，未完成的不得写成已完成：

1. **拆分 service**（[#32](https://github.com/Old-Friends-Gathering/strata/issues/32)）：`src/api/service.js` 拆为 lifecycle / write-path / search-path / maintenance 四个承接模块，主文件回落到 ≤320 行；只搬不改语义（`MemoryService` 仍是唯一对外类）。
2. **kind 注册表数据化**（[#33](https://github.com/Old-Friends-Gathering/strata/issues/33)）：kind 清单从代码迁到 `config/policy.json`，新增 kind 只改配置、代码零改动。
3. **JudgePort + `memo curate auto`**（[#34](https://github.com/Old-Friends-Gathering/strata/issues/34)）：确定性规则 judge（默认无 LLM）+ 一条命令跑完 scan→判→apply，幂等。
4. **compact 物理清理**（[#35](https://github.com/Old-Friends-Gathering/strata/issues/35)）：墓碑 + `purge` 标签 + 超 grace 才物理删；原子替换 + 自动备份，events 永不删。
5. **检索健康指标**（[#36](https://github.com/Old-Friends-Gathering/strata/issues/36)）：metrics 新增 `searchCount` / `noHitRate` / `staleHitRate` / `avgTopScore`，无数据写 `null`；不存 query 原文。

仍在候选池（本轮不做）：

- `hybrid-index.js`（BM25+dense，RRF k=60）：仅当 #36 的检索指标暴露实测痛点时启动。
- `EmbeddingIndex`：与向量/语义检索的非目标一致，等词法检索被证明不够再上。
- `MEMO_INDEX` 环境变量：切换已收敛到 `policy.json` 的 `index.backend` 一处；等出现第二配置源需求再加。

## v0.3.0（已交付）：分层视图

- **做了什么**：L2 场景块（`src/views/l2.js`，确定性聚类、可字节重建）、注入分级（`brief --tier0` + 每层硬配额 + 完整 id 证据链）、L3 画像（`src/views/l3.js`，固定预算 + 强制 `sourceRefs` + TTL）
- **刻意不做**：向量检索（等 `noHitRate` 有痛感）、自动捕获 hook（跨端与成本未解）、L2/L3 由 LLM 全量生成（结构层必须确定性）
- **入口**：`memo view build|show|trace|l3`、`memo brief --tier0`；契约见 `docs/02` §3.14（裁决 54–57）
