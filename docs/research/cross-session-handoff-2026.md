# 跨会话上下文接力：开源记忆系统调研（2026-11）

> 目的：为 sedimem 的「跨会话任务开发」设计提供参照。核心问题：**压缩后的上下文怎么存、存多细、怎么注入下一会话**。
>
> 证据纪律：本文只写实际打开并读过的来源（README / 源码 / 官方文档站页面），每条标注出处与性质（官方 README 自述 vs 源码实证 vs issue 实证）。未打开源码的部分明确标注「未验证」。
>
> 我们的现状（背景）：sedimem 任务库 = scope `session:<id>`，close 时只把 decision/gotcha 晋升主库、其余 tombstone；无自动上下文捕获；policy 里 `session.hintTokens=30000` 无消费者（死配置）。

---

## 0. 逐仓对照总表

| 仓库 | 存储结构 | 压缩单元 | LLM 压缩与预算 | 注入方式 | 跨会话恢复入口 |
|---|---|---|---|---|---|
| claude-mem | SQLite（`~/.claude-mem/claude-mem.db`，sessions/observations/summaries 表）+ Chroma 向量库叠加 | observation（工具活动级）+ session summary（会话末） | 有：旁挂 observer agent 记笔记；SessionStart 注入按**字符预算实测递减**（非条数） | SessionStart hook 注入紧凑索引 + MCP 检索三步法（index→timeline→details） | 安装即自动；`search`/`timeline`/`get_observations` MCP 工具 |
| mem0 | 向量库（Qdrant 等）+ 可选 graph store | 单条 memory（从对话抽取的 fact） | 有：旧版 ADD/UPDATE/DELETE 三操作；2026-04 新算法改为**单遍 ADD-only** + BM25/实体多路融合 | SDK `search()` 拼进 system prompt；CLI/MCP | `mem0 add` / `mem0 search` |
| letta (letta-code) | 服务端 agent state；**MemFS：全部上下文（含 memory blocks）git 跟踪** | memory block（agent 自改写的持久段落）+ skills | 有：`/sleeptime` 周期性 "dreaming"（sleep-time compute），agent 重写自己的记忆 | agent 的 context 即其记忆（无外部注入概念）；`/search` 跨会话消息检索 | 同一 agent state 持续存在；`/palace` 查看记忆 |
| graphiti | 图数据库（Neo4j/FalkorDB/Neptune），实体/事实/episode 三层 | episode（原始摄入数据）为溯源单元；事实带时间有效期 | LLM 用于抽取与实体摘要演化，**检索不用 LLM 摘要**（混合检索 sub-second） | 库：`add_episode` 摄入 + `search` 混合检索，自建服务 | 无内建会话概念，由使用方接入 |
| memU | SQLite / Postgres（`MEMU_DB`），按 track 分类（如 skill） | self-contained job（session 日志切片）→ skill Markdown | LLM 判断在 agent 侧：切片 job 交给 agent 蒸馏成 skill md；`MemoryService` 只存/嵌/检索 | 双缝：record（定时桥接任务切日志）+ inject（改 AGENTS.md/CLAUDE.md 常驻指令，让 agent 答前跑 `<binary> retrieve`） | `<host-binary> retrieve "…"` |
| A-mem | ChromaDB 向量库 | note（单条记忆） | 有：每条 note 生成 context/keywords/tags，加新 note 时做 **memory evolution**（互更新元数据、建链，Zettelkasten） | Python API `search_agentic()`，自拼 prompt | 无内建跨会话入口，纯库 |
| basic-memory | **Markdown 文件 + SQLite 索引**（local-first）+ 可选云同步 | note（结构化 schema：session/decision/task/coding_session） | 无 LLM 自动压缩；压缩发生在宿主（Claude Code compaction）前后由 **hook 主动写 checkpoint** | MCP 工具（bm_write/bm_search 等）+ Claude Code 插件：SessionStart briefing / PreCompact checkpoint / 技能命令 | `/basic-memory:bm-orient`（中途定向）、`bm-checkpoint`（交接） |
| mcp-memory-service | SQLite + 本地 ONNX 嵌入；可选 Hybrid 云同步 | 单条 memory + 可选 chunked 文档 | 有：自主 consolidation（聚类/压缩/关联发现/受控遗忘），需配置调度 | MCP + REST；hooks 在会话开始检索、结束时 harvest；`get_bootstrap_profile` 在 **token 预算内**拼新 agent 引导 | hooks 自动 + `memory_harvest` 工具 |

---

## 1. thedotmack/claude-mem —— 与我们场景最像，重点研读

来源：README（https://raw.githubusercontent.com/thedotmack/claude-mem/main/README.md，v15.18.3）、源码 `src/services/context/`（GitHub contents API 实际列出并读取 `ContextBudget.ts`）。

### 存储与压缩单元
- 存储：SQLite `~/.claude-mem/claude-mem.db`，表为 **sessions / observations / summaries**；Chroma 叠加语义检索（README "How it fits together"，指出 `src/services/sqlite/`、`src/services/worker/search/`）。表 schema 细节未验证（未打开 migration 文件）。
- 压缩单元两级：**observation**（observer agent 从每次工具活动中提炼的短笔记）+ **session summary**（会话结束时生成）。
- 压缩由**旁挂 observer agent**做（第二个 agent 记笔记），支持 `CLAUDE_MEM_MODE`（如 `code--zh`，中英文输出、chill 模式只记「重新发现会很痛苦的东西」）。

### 注入方式与预算（源码实证，最有参考价值）
`src/services/context/ContextBudget.ts` 注释原文（我实际读取）：

- `CONTEXT_OUTPUT_LIMIT = 10_000`：Claude Code hook stdout 上限 1 万字符，超一字节整块落盘换成 ~2KB stub 且 hook 仍报成功——**静默失败**（源码引用 issue #3802、#1899）。
- `TERMINAL_BANNER_RESERVE_CHARS = 512`：预留横幅空间（issue #5079）。
- 核心机制：**按条数配预算不可行**（"items are not a fixed size"——observation 标题 ~150-320 字符、summary 行 ~250-600、last-session summary 1-5K），于是**渲染-测量-递减**：渲染后超预算就按固定顺序丢（完整 observation 正文 → last-session summary → last message → 会话数减半 → observation 数减半），重渲染直到塞进预算；保底 header/footer/至少一条 observation 永远存活。
- 注入内容分节渲染（`src/services/context/sections/`：Header / Previously / Summary / Timeline / WorkState 五个 Renderer，目录列表实证）。

### 检索（三步渐进披露）
README：`search`（索引行 ~50-100 token）→ `timeline`（时间线）→ `get_observations`（全文 ~500-1000 token/条，按 ID 批量取）。README 自己承认**索引行约为全量 1/10 的说法没有实测召回/端到端节省证据**（issue [#4138](https://github.com/thedotmack/claude-mem/issues/4138)——README 原文引用，我未另开 issue 页）。

### 已知缺陷（有出处）
- hook 输出超 10k 字符静默丢上下文（源码注释引 #3802/#1899）。
- token 节省比例未测量（#4138）。
- 观察依赖宿主 hooks：Grok Bot 等无 hook 的宿主只能读日志文件（README），会话不可录制则记忆缺失。

---

## 2. mem0ai/mem0 —— 事实抽取型记忆，无「会话」概念

来源：README（https://raw.githubusercontent.com/mem0ai/mem0/main/README.md）。

- 存储：向量库（默认 OpenAI embedding，托管版 Qdrant）+ 实体链接；开源版有自托管 server（docker compose）与 CLI（`mem0 add` / `mem0 search`）。
- 压缩单元：单条 memory（从 messages 抽取的 fact）。**2026-04 新算法（README 自述）**：单遍 ADD-only 抽取（一次 LLM 调用，无 UPDATE/DELETE，记忆只累积不覆盖）、实体链接、semantic+BM25+entity 三路检索融合、时间感知排序；自报 LoCoMo 92.5 / LongMemEval 94.4，~7K token 预算，但**明确注明托管平台含开源 SDK 没有的优化**（README 原文），开源数字只能参考方向。
- 注入：SDK `memory.search()` → 拼 system prompt 的 "User Memories" 段（README 示例代码）；无会话边界、无 SessionStart 概念。
- 与我们相关度：中等。它验证了「ADD-only 防覆盖 + 多路检索」的价值，但它解决的是「用户偏好/事实」不是「任务进度接力」；没有 checkpoint/注入预算机制。

---

## 3. letta-ai/letta —— agent 即记忆容器（路线不同）

来源：`letta-ai/letta` main README（仅 1.4KB，已读）+ `letta-ai/letta-code` README（当前活跃代码仓，已读，grep memory/sleep/context 段落）。`docs.letta.com` 的 markdown 端点尝试 3 个路径均返回 404 HTML——**文档站内容未验证**。

- 架构：不是「外部记忆库」而是**常驻 stateful agent**——agent 本体跨会话存活，记忆就是它的 context 的一部分（memory blocks，agent 可程序化改写；源自 MemGPT 论文，README 自述）。
- 跨会话手段（letta-code README 实证）：
  - `/sleeptime`：周期性 "dreaming"（sleep-time compute），agent 在空闲时重写自己的记忆/技能/系统提示；
  - **MemFS：所有上下文（含 memory blocks）用 git 跟踪**，`/memory-repository set git@…` 可同步到任意 GitHub 仓库；
  - `/search`：跨全部会话与 agent 的消息检索；`/palace`：查看记忆；skills 存于 `~/.letta`（全局）/`.agents/skills`（项目）/MemFS（agent 级）。
- 已知限制（README 自述）：Windows 原生默认禁用自动 dreaming（需 `LETTA_ENABLE_WINDOWS_AUTO_REFLECTION=1`）。
- 对我们意味着：这是一条**不同路线**——不压缩存量对话，而是让 agent 自己维护可改写的记忆层。sedimem 作为「给任意宿主会话做外挂记忆」的产品形态抄不了整套，但「记忆分层可 git 跟踪、可 diff」和「空闲期后台整理（dreaming）」值得借鉴。

---

## 4. getzep/graphiti —— 时序知识图谱， episode 溯源

来源：README（https://raw.githubusercontent.com/getzep/graphiti/main/README.md，已读全文）。

- 存储：图数据库（Neo4j 5.26 / FalkorDB / Neptune），三层：**Entities（节点，摘要随时间演化）→ Facts/边（三元组，带时间有效期，被取代即失效不删除）→ Episodes（原始数据，所有派生事实可溯源至此）**。
- 压缩：LLM 用于摄入时抽取与实体摘要更新；**检索明确不用 LLM 摘要**——semantic + BM25 + 图遍历混合，sub-second（README 自述）；LLM 需支持 Structured Output，小模型会摄入失败（README 警告）。
- 注入：纯库（`graphiti-core`），无会话/注入概念，`add_episode` 增量摄入 + `search` 查询；接入方式由使用方自建（README："you build the service around it"）。
- 已知缺陷线索：默认并发低（`SEMAPHORE_LIMIT=10`）防 429；Kuzu 后端已弃用（README WARNING）。
- 对我们意味着：**bi-temporal（事实有效期）+ episode 溯源**是好概念，sedimem 的 supersede 机制已在做类似事；整套图数据库基建对我们过重，不值得抄。

---

## 5. NevaMind-AI/memU —— 「宿主日志挖掘 + 双缝注入」，与我们最互补

来源：README（https://raw.githubusercontent.com/NevaMind-AI/memU/main/README.md，已读全文）。

- 定位：把 agent **已有的 session 日志**（`~/.claude/projects/<project>/<session>.jsonl`、`~/.codex/sessions/**/*.jsonl` 等）作为输入源，不需要宿主提供 hooks。核心记忆逻辑号称仅 500 行（README 自述，未逐行验证）。
- 双缝模型（README 实证）：
  - **record**：定时桥接任务把新 session 日志切成 **self-contained job**（含路径与上下文）→ agent 自己读 job + 相关已有 skill，决定不改/补丁/新建 skill Markdown → `commit_results` 提交 → 嵌入入库（skill track）；
  - **inject**：在宿主指令文件（CLAUDE.md/AGENTS.md/SOUL.md）里写常驻指令，让 agent 答题前先跑 `<binary> retrieve`。
- 存储：`MEMU_DB`（SQLite 默认 `~/.memu/memu.sqlite3` 或 Postgres+pgvector）；检索返回**至多 5 条 self-contained hits** 的紧凑 JSON（README 明确「数据库 ID 与 scope 元数据不进 agent 输出」）。
- 恢复入口：`memu-claude-code retrieve "…"` 等 per-host 二进制；`<binary> doctor` 验证全链路。
- 已知限制（README 支持矩阵自述）：多平台 retrieve 验证不全（OpenClaw retrieve 未验证、Hermes Windows 旧版会检错文件、WorkBuddy+Hy3 retrieve 可能失败）——说明「挖掘日志」路线对宿主版本敏感。
- 对我们意味着：**「不需要宿主 hook，直接挖宿主的会话 JSONL」**是 sedimem 可以做的兜底采集路径；「切片成 self-contained job 再让 agent 自己蒸馏」比「中心化 LLM 压缩」更尊重 agent 判断。

---

## 6. agiresearch/A-mem —— 记忆演化（学术原型）

来源：README（https://raw.githubusercontent.com/agiresearch/A-mem/main/README.md，已读全文）。

- 存储：ChromaDB 向量库；单元是 note（content + 自动生成的 context/keywords/tags + timestamp）。
- 特色：**memory evolution**——每加一条新 note，找语义邻居，**互改旧 note 的元数据与 context、建链接**（Zettelkasten 式），在 add/update 时自动发生。
- 无会话概念、无注入机制、无预算：纯 Python 库（`AgenticMemorySystem.add_note / search_agentic`），prompt 组装由使用方做。README 自己强调错误处理（KeyError、LLM 调用 try-except）——成熟度是研究原型级。
- 对我们意味着：只值得抄「新记忆入库时回写旧相关记忆的元数据」这一个思想；其余是论文演示代码。

---

## 7. basicmachines-co/basic-memory —— Markdown-first + PreCompact checkpoint（第二相关）

来源：主 README（https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md）+ `plugins/claude-code/README.md`（已读，~13.9KB）。DESIGN.md 未读。

- 存储：**人机共读写的 Markdown 文件（默认 `~/basic-memory`）+ 本地 SQLite 索引**；wikilink + frontmatter 构成知识图谱；可选云同步（Postgres/Milvus 向量）。无 LLM 自动压缩——**文本本身就是持久层**。
- 与我们场景直接相关的插件设计（plugin README 实证）：
  - **SessionStart hook → briefing**：查询活跃任务 + 近期工作，生成简报注入会话开头；
  - **PreCompact hook → checkpoint**：宿主压缩上下文**之前**写一条 `session` 或 schema 化 `coding_session` note（coding 场景强制带 repository/branch/SHA 字段，PR 存在时带类型化 PR 上下文）——「宿主压缩丢掉的质感」被提前落盘；
  - **主动 checkpoint 技能** `bm-checkpoint`：用户说 "checkpoint this / wrap up" 时写交接 note（story、**实际跑过的验证**、decisions、blockers、next action）；
  - `bm-orient`：会话中途「现在到哪了」定向（活跃任务、未决 decisions、近期 checkpoints，带 permalink）；
  - `bm-decide`：结构化 decision note（rationale/alternatives/consequences）；
  - 种子 schema（session/decision/task/coding_session）让写入物**可被 `bm_search` 元数据过滤精确召回**，不是纯模糊搜索。
- 工程细节：hook 脚本是零逻辑 PEP 723 uv 脚本，全部行为在 Python 包内；**每条失败路径 exit 0**（hook 失败不打断会话）；生命周期事件默认捕获、fail-closed。
- 对我们意味着：**PreCompact checkpoint** 正面回应了我们「宿主突然压缩丢上下文」的痛点；schema 化 checkpoint + 元数据过滤召回是我们 close 时 decision/gotcha 晋升的加强版。

---

## 8. doobidoo/mcp-memory-service —— 多传输自托管服务 + 自主整理

来源：README（https://raw.githubusercontent.com/doobidoo/mcp-memory-service/main/README.md，已读全文）。

- 存储：SQLite + 本地 ONNX 嵌入（可选 Hybrid：本地读 + Cloudflare/自建第二后端后台同步；Milvus 可选）。
- 单元：单条 memory；文档摄入带 chunking。特色：**知识图谱带类型化因果边**（causes/fixes/contradicts）、置信度 belief、矛盾检测把旧记忆标 superseded（默认检索隐藏、显式查找保留）、`conversation_id` 绕过去重做增量会话存储、`X-Agent-ID` 按代理身份打标签检索。
- LLM 压缩与预算：**自主 consolidation**（聚类/压缩/关联发现/受控遗忘，需调度）——README 有专章但细节在 docs/ 内，我未打开，**细节未验证**。`get_bootstrap_profile` 在 **token 预算内**为新 agent 拼行为引导（需 `MCP_BOOTSTRAP_ENABLED=true`），README 自述「profiles are not isolated by project」——是一个已知的隔离缺陷。
- 注入/恢复：Claude Code hooks 会话开始检索、结束/压缩前 checkpoint + `memory_harvest`（从 transcript 抽 decisions/bugs/conventions/lessons）；同时有 REST API 供非 MCP 框架。
- 对我们意味着：`memory_harvest`（会话末从 transcript 抽结构化条目）与我们的 close 晋升同构，可对照其字段设计；「superseded 默认隐藏但可显式查」与我们 tombstone 行为一致，是行业共识做法。

---

## 9. 综合结论：对照我们的现状

我们的三个缺口与业界做法映射：

1. **没有自动捕获** → 业界四条路：(a) 宿主 hooks（claude-mem、basic-memory 插件、mcp-memory-service）；(b) 挖宿主会话日志文件（memU，无需 hook）；(c) 宿主压缩前 hook（basic-memory PreCompact）；(d) 常驻 agent 自管记忆（letta）。sedimem 至少要做 (b) 作通用兜底 + (c) 作精确拦截。
2. **`hintTokens=30000` 死配置** → claude-mem 证明：预算不能按条数，必须**渲染-测量-递减**，且要给 hook 输出上限留硬顶（它吃过 10k 字符静默截断的亏）。我们的 hintTokens 应变成「注入块字符/ token 预算」的真实消费者，配降级顺序（正文→摘要→时间线条目）。
3. **close 时只晋升 decision/gotcha** → 业界普遍保留**会话级 checkpoint** 作为独立单元（basic-memory `coding_session`、claude-mem session summary、mcp-memory-service harvest），且 checkpoint 带 **git 锚点（repo/branch/SHA）**与「已验证了什么」，供下一会话精确召回，而不是只靠语义搜索。

## 值得抄的 3 条

1. **PreCompact / close 前的 schema 化 checkpoint**（basic-memory 插件 + mcp-memory-service hooks）：在上下文被宿主压缩**之前**，把 story / 已跑验证 / decisions / blockers / next action 写成带固定字段（repo/branch/SHA）的 checkpoint 记录，SessionStart 时按元数据精确召回——直接解决「宿主压缩过多丢上下文」与「关会话丢进度」两个痛点。
2. **注入按「渲染-测量-递减」管理预算**（claude-mem `ContextBudget.ts`）：hintTokens 不做死配置，而是 SessionStart 注入块的真实预算；超预算按固定降级顺序整块丢弃并重渲染，保证块结构完整、header 至少带一条内容存活；同时硬顶在宿主 hook 输出上限之下（避免静默截断）。
3. **渐进披露检索三步法 + compact index**（claude-mem search→timeline→get_observations；memU ≤5 hits 紧凑 JSON）：注入只给索引/摘要，全文按 ID 或按需取，把「注入预算」和「检索深度」解耦。

## 明确不抄的 3 条

1. **图数据库 / 时序知识图谱基建**（graphiti 的 Neo4j/FalkorDB + 实体摘要演化）：对单机 local-first 的 sedimem 是数量级超配，且强依赖 Structured Output 的 LLM，小模型摄入即失败；我们的 SQLite + supersede 已覆盖「事实被取代」需求。
2. **常驻 stateful agent 自改写记忆**（letta 的 memory blocks/dreaming/MemFS）：前提是 agent 本体常驻、记忆即 context，与 sedimem「外挂在任意宿主会话上」的形态冲突；git 跟踪记忆的思路可借鉴但整套路线不可搬。
3. **中心化 LLM 观察员持续压缩每一步工具活动**（claude-mem observer 全量记 observation、mem0 每轮对话抽取）：token 成本与延迟高、且 claude-mem 自己承认收益未实测（#4138）；memU 的替代方案（切片成 self-contained job、让 agent 空闲时批量蒸馏成 skill/checkpoint）成本更低且判断留在 agent 侧，更适合我们。

---

### 来源清单（全部实际读取）

- claude-mem README：https://raw.githubusercontent.com/thedotmack/claude-mem/main/README.md ；`src/services/context/ContextBudget.ts`（同仓 main）；`src/services/context/` 与 `sections/` 目录列表（GitHub contents API）
- mem0 README：https://raw.githubusercontent.com/mem0ai/mem0/main/README.md
- letta README：https://raw.githubusercontent.com/letta-ai/letta/main/README.md ；letta-code README：https://raw.githubusercontent.com/letta-ai/letta-code/main/README.md （docs.letta.com 多个 .md 端点 404，未验证）
- graphiti README：https://raw.githubusercontent.com/getzep/graphiti/main/README.md
- memU README：https://raw.githubusercontent.com/NevaMind-AI/memU/main/README.md
- A-mem README：https://raw.githubusercontent.com/agiresearch/A-mem/main/README.md
- basic-memory README：https://raw.githubusercontent.com/basicmachines-co/basic-memory/main/README.md ；插件 README：同仓 `plugins/claude-code/README.md`
- mcp-memory-service README：https://raw.githubusercontent.com/doobidoo/mcp-memory-service/main/README.md
