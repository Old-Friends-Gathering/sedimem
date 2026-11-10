# 分层蒸馏记忆：GitHub 上更值得抄的做法（2026-11 调研）

> **一句话结论**：dsh-prime-memory 的分层**思路**值得吸收，但它的**实现路径**不是当前最优：
> 业界更好的做法是「**层级聚合用确定性算法、LLM 只写表述层、每层派生可重建、注入分级 + 配额 + 证据链**」。
> 三处证据：Graphiti 的社区发现用 label propagation（纯算法）、Memobase 把 L2→L3 压到固定 3 次 LLM 调用、
> dsh-auto-memory 用 Tier-0 目录 + 每层硬配额治住了「单层吃满预算」。

## 0. 这次调研回答什么

针对「给 sedimem 加 L0→L1→L2→L3 分层」这件事，查三件事：

1. **层级之间的转换怎么算**：LLM 生成还是确定性聚合？哪层最容易失真？有没有做到反向溯源？
2. **自动捕获 / 自动注入**怎么控成本、防噪声、防「注错了没人发现」？
3. 如果加 L2/L3，**用什么指标证明比现在的扁平 brief 更好**？

## 1. 方法与可信度

- 三个方向各由一名调研代理并行完成（glm-5.3），**只记真正打开过的页面/源码**；拿不到的标「未验证」。
- star / license 取自 GitHub API（2026-11-07）或页面徽章，未逐个截图核对。
- 术语约定：**L0** 原始对话；**L1** 原子事实（≈ sedimem 的 record）；**L2** 场景块（同主题聚合）；**L3** 核心画像/方法论。

## 2. 值得抄的机制

### 2.1 层级转换：确定性聚合 + LLM 只写表述

| 机制 | 它怎么做 | 为什么值得抄 | 出处 |
|---|---|---|---|
| episode 溯源 | 每条派生实体/事实记录**来自哪个 episode**，README 原话 "Every derived fact traces back here" | L2/L3 失真时能一键回到原始对话；sedimem 现在只有 record 级 `source.agent`，没有「这条画像来自哪几条记录」 | [getzep/graphiti](https://github.com/getzep/graphiti) |
| 社区发现用算法、摘要才用 LLM | `graphiti_core/utils/maintenance/community_operations.py` 用 `label_propagation`（确定性），LLM 只在最后生成摘要 | **失真被限制在"表述层"，且表述可随时从结构重算** —— 这正是「分层但不放弃可审计」的做法 | 同上（源码） |
| 固定次数 LLM 巩固 | Memobase 把 profile 更新从 3–10 次调用压到**固定 3 次**，token 降 40–50%；在线读 profile 只走 SQL，<100ms | 给 L2→L3 一个**成本上界**，不是「有多少调用多少次」 | [memodb-io/memobase](https://github.com/memodb-io/memobase) |
| 睡眠期后台巩固 + git 化 | Letta `/sleeptime` 把巩固移出对话路径；memory blocks 用 git 追踪，画像可 diff / 回滚 | 与 sedimem「append-only + 可回放」同构；画像层有版本历史才敢自动生成 | [letta-ai/letta](https://github.com/letta-ai/letta) |
| 分层寿命/晋升语义 | MemOS：L1 traces → L2 policies → L3 world models，各层寿命与晋升规则不同（README 声称，代码未核） | 「不同层不同衰减」比「一套 TTL」更贴近现实 | [MemTensor/MemOS](https://github.com/MemTensor/MemOS) |

**对 sedimem 的直接含义**：L2 的「哪些记录聚在一起」应该在本地算（并查集 / 相似度图 / 主题聚类，我们已经有了 `dedupeScan` 的簇），
L3 的「一句话概括」才需要 LLM，而且这句概括必须带 `source_refs` 指回 record id —— 概括可重算、可删除、可重建。

### 2.2 捕获与注入：分级 + 配额 + 证据链

| 机制 | 它怎么做 | 为什么值得抄 | 出处 |
|---|---|---|---|
| 三级渐进披露 | `search` 只回 50–100 token/条索引 → `timeline` → 按 id 批量取原文（500–1000 token/条），自称省 ~10x token | **默认注入摘要不注入原文**的成熟实现 | [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) |
| Tier-0 目录 + 每层硬配额 | 默认只注入 ≤800 token 目录（一条一行：标题·结论·层级·日期）；因为实测 project 层 77 chunks 吃光预算，改成每层硬配额（project ≤60%）+ whiteboard/user 保底 floor；总预算 `injectBudgetChars=8000` | **纯优先级一定会塌成单层** —— 这条是踩坑换来的 | [Aik358/dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory) |
| recall 决策带证据链可评级 | 每次自动 recall 附决策依据，可在 UI 里评级；写入侧有 write gate（乱码/口吃/JSON 注入拦截） | 直接回应「注错了没人发现」 | 同上 |
| dry-run / preview / apply + 隔离副本 | 只同步 idle 会话日志；模型只能改隔离副本，宿主校验后才写 Git；给模型看的 summary ≤12 KiB 且标 "explicitly untrusted" | 「模型加工的中间产物一律当不可信输入」的治理范式 | [seriousz158/dsh-memory](https://github.com/seriousz158/dsh-memory) |
| 矛盾 → 置信度 → 软失效 | 从 observation 派生带置信度的 belief，启发式矛盾检测把旧记忆标 superseded（默认检索隐藏） | 与 sedimem 的非破坏失效同型，可借它的置信度打分口径 | [doobidoo/mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) |
| single-pass ADD-only | mem0 OSS 改成一次 LLM 调用、只 ADD 不 UPDATE/DELETE，靠检索端去重兜底 | 「写时不动旧账」换一致性；代价是噪声靠读侧 | [mem0ai/mem0](https://github.com/mem0ai/mem0) |

### 2.3 检索与评测：先校准裁判，再谈收益

| 机制 | 它怎么做 | 为什么值得抄 | 出处 |
|---|---|---|---|
| vec0 虚表 + 元数据同表 | sqlite-vec：向量列与非向量列同表，KNN 用 `WHERE embedding MATCH ? ORDER BY distance LIMIT k`，单文件零服务；**无 ANN**（万条以下无妨） | 与 sedimem「单文件 + 零服务」目标一致 | [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) |
| RRF 融合 | `score = Σ 1/(k+rank)`，k≈60；不用归一化 BM25 与余弦 | hybrid 检索的标准解，3 行代码 | [Elastic RRF 文档](https://www.elastic.co/guide/en/elasticsearch/reference/8.14/rrf.html) |
| turn 级召回标注 | LongMemEval 每条证据 turn 带 `has_answer`、证据 session id —— 能直接算「检索层命中率」而非只算端到端分数 | **分层 vs 扁平**的天然度量：L2 块命中率 = 分子分母都可得 | [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval) |
| 裁判先校准 | LoCoMo-Refined 报原版 judge 与人一致率仅 **43.67%**，收紧后 86.33% | 不校准裁判，任何「提升 X%」都可能是评分噪声 | [mem-eval-suite/LoCoMo_refined](https://github.com/mem-eval-suite/LoCoMo_refined) |
| 差异提取而非压缩 | nemori 的 Predict-Calibrate：先预测该 episode 应含什么，再与真实对话比对，**差值处**提取高价值事实 | 「L3 不是把 L2 压短，而是提取变化」——与 sedimem 的冲突/失效语义天然契合 | [nemori-ai/nemori](https://github.com/nemori-ai/nemori) |

## 3. 明确不值得抄

| 东西 | 理由 |
|---|---|
| claude-mem 的**常驻 worker + 每轮一个观察回合** | issue #5023：observer 每回合重读 ~100K token，一夜耗光周额度 98%；#701：209 个孤儿进程吃 2.5–3.5GB；#1226：worker 不回收子进程。后台 LLM 观察者是成本与进程治理双雷区 |
| MemInsight | **CC-BY-NC 4.0**（不可商用）+ 2025-09 后停更 |
| A-MEM 的 Zettelkasten 演化 | 每次 add 都让 LLM 分析历史记忆并回写链接 → **写入成本随库大小增长，无上界** |
| MemoryOS | OS 隐喻 + heat 晋升，超参多；benchmark 为论文自报，对 sedimem 增量低 |
| LanceDB / hnswlib | 面向 PB 级 / 需原生编译；单用户 <10⁴ 条记忆用不上 |
| jieba（引入为依赖） | 2024-08 停更 + Python 生态绑定；Node 侧 nodejieba 同样是原生依赖。**字符 bigram + RRF 已是我们现状，够用** |
| basic-memory | AGPL-3.0 对集成不友好，机制与 sedimem 重合 |

## 4. 对 sedimem 的三条建议（可直接落 issue）

### A. L2 场景块：确定性聚合，引用 record id，可重建

- 输入：`dedupeScan()` 已有簇 + slot 分组；输出：`$MEMO_HOME/views/<scope>/L2.jsonl`，每条 `{blockId, key, recordIds[], stats{count,firstAt,lastAt}, sentence?}`
- `sentence` 允许为空（纯结构块）；有 LLM 时才填，且必须带 `recordIds`
- **验收**：删掉整个 `views/` 目录后 `memo view rebuild` 能逐字节复原（同一真相层 → 同一视图），并进 eval（I21）

### B. L3 画像：固定成本 + 强制溯源 + 失效期

- 每条画像 `{text, sourceRefs[], confidence, validTo?}`；生成走 `memo curate auto` 同一裁决通道（夜间批，不占对话路径）
- **固定调用次数**（Memobase 式）：一次批处理最多 N 条 LLM 调用（N 进 policy），超了排队到下次
- **验收**：任意一条 L3 都能 `memo view trace <l3Id>` 列出它的 record 出处；删除 L3 不影响真相层

### C. 注入分级 + 配额 + 证据链

- brief 之外新增 Tier-0：`memo brief --tier0` 输出 ≤800 字符的「一条一行」目录（契约里已有的 `brief.lines=80` 之上）
- 每层硬配额（L1 ≤60%、L2 ≤25%、L3 ≤15%），总注入上限 `injectBudgetChars`
- 每条注入附 `recordId`，Agent 可用 `memory_get` 反查原文 —— 这就是「证据链」
- **验收**：把某一层灌爆，注入仍按配额截断（I22）

## 5. 最小实验：证明分层比扁平 brief 好

- **对照**：现状 `brief`（扁平，80 行）
- **实验**：L2 场景块 + L3 画像（同一真相层派生的视图）
- **数据**：LongMemEval `_s`（500 题，含 `has_answer` turn 标注）
- **指标**：① turn 级 recall@5 / @20；② 端到端 QA F1（官方 `evaluate_qa.py`）；③ 注入 token 数（成本）
- **样本量**：500 题配对比较可检出 ~5pt 差异；3 个 seed
- **前置**：抽 100 题人工判卷，judge 与人一致率 <80% 前不采信端到端分数

## 6. 存疑 / 未验证

- HippoRAG、MemoRAG、FlexA-Mem、TencentDB Agent Memory / MemoryCore：仓库 404 或未打开，**未验证**
- MemOS 的 L1/L2/L3、MemoryOS / cognee 的 benchmark 数字：README/论文自报，未读代码核验
- Letta sleep-time 的调度实现：只核 README
- Engram / Memorix / Letta hooks / dsh-noema / guardian / steward：本环境网页抓取失败，**未验证**
- jieba vs 字符 bigram 的中文检索对照实验：未找到可打开的实测，标未验证
- MemBench：GitHub 未找到可靠官方仓（多个候选 404）
- sqlite-vec 在 macOS arm64 / Node 的加载稳定性、transformers.js 小模型的中文 embedding 质量：未实测

## 7. 与 dsh-prime-memory 的取舍

| 维度 | dsh-prime-memory | 本调研建议的 sedimem 路线 |
|---|---|---|
| L1→L2 | LLM 整合场景块 | **确定性聚合**（聚类），LLM 只写表述 |
| 溯源 | 无（覆盖式更新） | 每条 L2/L3 带 `recordIds`，可 `trace` |
| 注入 | 每步自动注入 | 分级（Tier-0 目录 + 按需下钻）+ 每层配额 + 证据链 |
| 成本 | 每轮一次 `ctx.llm` 蒸馏 | 固定次数、夜间批、可预算上限 |
| 跨端 | DSH-only | MCP，DSH / Codex / Claude 共用同一真相层 |
| 可恢复 | 蒸馏结果覆盖即丢 | `views/` 可整目录删除后重建 |
