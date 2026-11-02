# 开源 AI 长期记忆 / Agent Memory 项目调研（2026-11-02）

> 口径说明：star / license / 主语言 / 最后 push 均取 GitHub REST API 实测值，查询时间 **2026-11-02T03:4xZ（UTC）**，star 按「约 xk」取整。架构与能力结论优先取自仓库 README、源码与官方 docs；只有 README 自述、未在源码或 docs 二次核实的会标注「自述」。GitHub core API 在本次调研中途触发 60 次/小时限额，individual issue 的主题级统计只有 mem0 完成，其余项目的「已知问题」以 README 明示的限制 + issue 总数为主，查不到的写「未查到」。
>
> 覆盖范围：mem0（含 OpenMemory / MCP）、Letta（原 MemGPT）、Zep + Graphiti、cognee、MemOS、memU、Supermemory、Memobase。

---

## 1. mem0（mem0ai/mem0）

- 仓库：https://github.com/mem0ai/mem0 ｜ 文档：https://docs.mem0.ai
- Star：**约 68k**（68,255；2026-11-02 查询）｜ License：**Apache-2.0** ｜ 主语言：**Python** ｜ 最后 push：2026-10-30，open issues 898（活跃）
- 另两个相关仓库：`mem0ai/openmemory`（101 stars，MIT，已改造为「把 Claude Code / Codex / OpenCode 会话迁移过去」的 CLI/TUI，不再是旧的 OpenMemory 记忆服务）；`mem0ai/mem0-mcp`（已 **ARCHIVED**，官方 README 置顶说明「不再维护，转为公开归档」，指向云端托管 MCP）。

**核心架构**

| 维度 | 事实 |
|---|---|
| 存储（库模式默认） | 向量库默认 **本地 Qdrant 文件模式**（`mem0/configs/vector_stores/qdrant.py`：`path` 默认 `/tmp/qdrant`，collection `mem0`，dims 1536，`on_disk=False`）+ **SQLite 历史库** `~/.mem0/history.db`（`mem0/configs/base.py`） |
| 存储（server 模式） | `docker compose` = mem0 FastAPI（:8888→8000）+ `pgvector/pgvector:pg17`（:8432）+ dashboard（Next.js，:3000），`cd server && make bootstrap` 起；默认开启 auth（`ADMIN_API_KEY` / 注册 admin，`AUTH_DISABLED=true` 仅本地开发） |
| 可插拔存储 | 支持多种向量库 / 图库后端（配置层），但 **v3 OSS 已移除图记忆**：`MemoryConfig` 无 `graph_store` 字段，`mem0/memory/graph_memory.py` 已 404 |
| 检索 | 多信号融合：**semantic + BM25 关键词 + entity matching** 并行打分后 fuse；带 temporal reasoning、entity linking；单遍检索（README 明确「no agentic loops」，top_200 budget） |
| LLM 抽取 | **是**，且是核心路径。v3 算法为 **single-pass ADD-only**：一次 LLM 调用只产出 ADD（`mem0/memory/main.py:20-23` 仅 import `ADDITIVE_EXTRACTION_PROMPT`；:942-950 "Phase 2: LLM extraction (single call)"；:911 event `ADD`）。旧四操作提示（ADD/UPDATE/DELETE/NOOP）仍在 `mem0/configs/prompts.py:176-220`，但默认路径不再使用 |
| 依赖模型 | 默认 LLM `gpt-5-mini`、默认 embedding `text-embedding-3-small`；`pip install mem0ai[nlp]` 才启用 BM25 + entity 那一路 |

README 自述的 v3 指标（注明「分数来自托管平台，含 OSS 没有的私有优化，OSS 方向一致但不完全相同」）：LoCoMo 92.5（旧 71.4）、LongMemEval 94.4（旧 67.8）、BEAM(1M) 64.1、BEAM(10M) 48.6，tokens ≈ 6.7–7.0K，p50 延迟 0.88–1.09s。

**MCP server**

- 官方能力 = **云端托管** `https://mcp.mem0.ai/mcp`（docs：`docs/platform/mem0-mcp.mdx`），需 Mem0 Platform 账号 / API key，暴露 11 个工具：`add_memory`、`search_memories`、`get_memories`、`get_memory`、`update_memory`、`delete_memory`、`delete_all_memories`、`delete_entities`、`list_entities`、`list_events`、`get_event_status`；安装 `npx mcp-add --name mem0-mcp --type http --url https://mcp.mem0.ai/mcp`。
- 仓库内另有**本地插件形态**的 MCP：`integrations/claude-code-plugin/.mcp.json` 启动 `core/mcp_server.py`（env `MEM0_CODE_DATA_DIR`），但只暴露 **1 个工具** `search_memories`（"Search memories from earlier work in this repository"），是「本地编码记忆检索」，不是完整 memory API。同构插件还有 codex / cursor / kimi / antigravity / mem0-agent。
- 结论：**能接 Claude Code / Codex 等通用 MCP 客户端，但完整读写走云端（要 key）；纯本地只有只读检索插件。**

**自我维护（逐项）**

- 去重：**部分**。靠 entity linking + 抽取期去噪，但没有显式 dedup 阶段；issue 里 `duplicate` 相关 175 条、`dedup` 29 条（2026-11-02 搜索计数）。
- 冲突检测 / 失效：**无**。ADD-only 设计下「Memories accumulate; nothing is overwritten」，遇到事实变更不会 invalidate 旧记忆。
- 记忆合并：**无**（默认路径不产生 UPDATE，也就没有 merge 环节）。
- 遗忘 / 衰减：**OSS 无**，且是显式不支持的：`mem0/memory/notices.py` 中 `DECAY_FEATURE_ERROR_MESSAGE = "The decay parameter is not supported by the OSS Memory SDK."`，`timestamp` / `reference_date` 同样返回 "not supported by the OSS Memory SDK"；另有 `detect_decay_usage_from_delete`：7 天内删除 ≥5 次会提示「你在用 delete 模拟衰减」。
- 整合（consolidation）：**无**（没有离线整合 / 睡眠期整理这类机制）。

**部署成本 / 离线**

- 库模式：`pip install mem0ai` 即用，无外部服务；默认落本地 `/tmp/qdrant` + `~/.mem0/history.db`。但**必须**有 LLM + embedding（云端 API 或自建 Ollama / vLLM 端点）。
- server 模式：Docker + Postgres(pgvector)，自带 dashboard。
- 完全离线：**否**（默认依赖 OpenAI 系 API）；换成自建模型端点后可离线。

**已知问题 / 局限**

- 抽取成本与延迟（issue 搜 `latency` 55 条、`accuracy` 28 条）。
- ADD-only 带来的记忆膨胀与重复（`duplicate` 175 条），以及**不覆盖、不失效**导致「旧事实永远在库里」。
- OSS 缺 decay / 时间过滤，README 的 benchmark 数字来自托管平台。
- 旧 OpenMemory（docker：API+UI+Qdrant，`/mcp` 端点）的文档已从 docs 树移除，`openmemory` 仓库被改作他用，历史文章里的「OpenMemory MCP」已不可按原路径复现；官方 Python MCP server 也已归档。

**来源**：https://github.com/mem0ai/mem0 ｜ https://docs.mem0.ai/platform/mem0-mcp ｜ https://github.com/mem0ai/mem0-mcp ｜ https://github.com/mem0ai/openmemory ｜ 源码路径 `mem0/memory/main.py`、`mem0/memory/notices.py`、`mem0/configs/base.py`、`mem0/configs/vector_stores/qdrant.py`

---

## 2. Letta（letta-ai/letta，原 MemGPT）

- 仓库：https://github.com/letta-ai/letta ｜ 文档：https://docs.letta.com
- Star：**约 25k**（25,318；2026-11-02 查询）｜ License：**Apache-2.0** ｜ 主语言：API 字段为 null（README 已无源码）｜ 最后 push：2026-10-18，open issues 0（活跃度已转移到新仓）
- 当前活跃源码：https://github.com/letta-ai/letta-code（**约 3.8k stars**，TypeScript，Apache-2.0，v0.34.37，push 2026-11-02，当日活跃）

**核心架构（重要变化：V1 server 已退役）**

- `letta-ai/letta` 的 README 现在是一个指针：*"Letta (f.k.a. MemGPT) is actively developed. The current source code lives in letta-ai/letta-code"*；`archive` 分支存放**已退役的 Letta V1 API server**（也就是过去那套 Postgres + pgvector 的服务端）。
- letta-code 的形态是 **agent harness**：交互式终端 UI、App Server、channels（Telegram/Slack/Discord/自定义）、desktop/web runtime、TS Agent SDK；`npm install -g @letta-ai/letta-code`，`letta` 进 TUI，`letta server` 起 App Server，另有 chat.letta.com。
- 存储：**本地后端是文件 + git**，不是数据库。所有 context（含 memory blocks）由 **MemFS** 用 git 跟踪，路径族 `~/.letta/{agents,settings,worktrees,skills,logs,crons,artifacts}`；`package.json` 无 sqlite / pg 依赖。`/memory-repository set git@github.com:...` 可把记忆同步到自己的 GitHub 仓库。
- 默认后端是 **Letta Cloud**（首启选择，`letta backend local` 切本地，`--backend` 单次覆盖）。
- 检索 / 记忆读写：agent 自编辑 **memory blocks** + system prompt learning；`/palace` 看记忆、`/search` 跨 agent 搜消息、`/sleeptime` 定期 dreaming、`/doctor` 诊断。
- LLM 抽取：**不是独立抽取器**——由 agent 自己在对话中调用记忆工具写 block（MemGPT 式 self-editing）。

**MCP server**

- 服务端角色：托管 **Letta MCP server** `https://api.letta.com/mcp`（`docs.letta.com/platform/hosted-mcp.md`：让任何 MCP-capable agent 创建并对话「有状态的 Letta agents」），`applies_to.backends: cloud` —— **仅云后端**，Bearer `LETTA_API_KEY`。
- 客户端角色：letta-code 可消费外部 MCP server（源码 `src/backend/api/mcp-servers.ts`、`unified-mcp.ts`、`mcp-subprocess-broker.ts`）。docs 明确提醒：*"If you're using the Letta app or CLI, use skills instead of registering MCP tools through the Letta API"*（CLI 场景推荐 skills）。
- 结论：**能接通用 MCP 客户端（云后端 + key）**；本地后端没有等价的自托管 MCP server 端点。

**自我维护（逐项）**

- 去重：**无显式机制**（靠 agent 自己重写 block）。
- 冲突检测 / 失效：**部分**——block 是「整体重写」语义（`memory_rethink`），旧内容被覆盖而非留下失效记录；无 bi-temporal。
- 记忆合并：**部分**（重写 block 时由 LLM 压缩合并，属 agent 行为而非系统保证）。
- 遗忘 / 衰减：**部分**——超过上下文窗口的消息被驱逐到 recall storage 并做递归摘要（MemGPT 分页），`/sleeptime` dreaming 会整理；但没有 TTL / 衰减打分。
- 整合（consolidation）：**有**——sleep-time / dreaming 是这类项目里最明确的「离线整合」实现（配套论文 Sleep-time Compute）。

**部署成本 / 离线**

- `npm i -g @letta-ai/letta-code`，无 Docker、无外部数据库；`letta backend local` 即本地文件 + git。
- 但**默认云后端**（记忆与对话在 Letta Cloud，需登录），且任何模式都要 LLM API key；secrets 功能需登录。
- 完全离线：**理论可行（local backend + 自建模型），但默认路径不是离线**；V1 自托管服务端已归档，旧的自部署文档不再适用。

**已知问题 / 局限**

- 迁移阵痛：V1 API server 退役、Python 服务端归档，老用户的自托管部署与 Postgres 数据需要迁移；主仓 issues 已关闭（open_issues 0），问题跟踪转移到 letta-code。
- 云优先：默认把 agent 记忆/身份/对话放云端，数据主权需手动切 local。
- 新栈年轻（0.34.x），TS/Bun 重写，生态（SDK、文档）仍在追赶。
- 本地后端无向量检索层，召回靠 `/search`（消息搜索）+ agent 主动读 block，规模化后的召回质量未查到公开评测。

**来源**：https://github.com/letta-ai/letta ｜ https://github.com/letta-ai/letta-code ｜ https://docs.letta.com/platform/hosted-mcp ｜ https://docs.letta.com/guides/agents/mcp

---

## 3. Zep + Graphiti（getzep/graphiti）

- 仓库：https://github.com/getzep/graphiti ｜ 文档：https://help.getzep.com/graphiti
- Star：**约 32k**（32,422；2026-11-02 查询）｜ License：**Apache-2.0** ｜ 主语言：**Python** ｜ 最后 push：2026-11-01，open issues 538（活跃）
- 关系：**Graphiti = 自托管开源框架；Zep = 托管 / BYOC 企业版**（自带 Konig 图引擎，不需要第三方图库）。README 对比表里 Graphiti 的 Deployment 一栏是「Self-hosted only」。

**核心架构**

| 维度 | 事实 |
|---|---|
| 数据模型 | temporal context graph：**entities**、**edges/facts**（带 validity window）、**episodes**（原始输入）、**communities**；每条边保留 provenance |
| 存储 | 图库：**Neo4j 5.26** / **FalkorDB 1.1.2** / **Neptune**（全文用 OpenSearch Serverless）/ **Kuzu 0.11.2**（已 deprecated）；向量与全文索引建在图库内 |
| 检索 | **hybrid**：semantic embedding + **BM25** 关键词 + **graph traversal**，查询期不依赖 LLM 摘要；README 自述「typically sub-second latency」 |
| LLM 抽取 | **是**，且强依赖 structured output：默认 OpenAI LLM+embedding，支持 Gemini / Anthropic / Groq；README 的 IMPORTANT 明说需支持 structured output 的模型，小模型会 schema 错误、ingestion 失败 |
| 时间语义 | **bi-temporal**：`valid_at/invalid_at`（现实时间）+ 系统时间；可查「现在为真」或「某时刻为真」 |

**MCP server**

- 有，但**明确是参考实现**：`mcp_server/` 目录，README 写 *"These servers are not production deployments"*。
- 安全 WARNING（原文要点）：**no authentication、no authorization、no prompt-injection protection**；任何调用者可读/改/删任意 `group_id`；示例 compose 用默认数据库凭据；安全报告 out of scope。
- 能力：episode 增删查、entity/relationship、semantic + hybrid search、group 管理、graph maintenance。另有 `server/` = FastAPI REST 参考实现。

**自我维护（逐项）**

- 去重：**部分**——实体解析（entity resolution）与边去重/合并是写入管线的一部分，但没有对外承诺的强去重。
- 冲突检测 / 失效：**有（本组最强）**——自动 **fact invalidation**：新事实与旧事实矛盾时把旧边 **invalidate**（不物理删除），保留 as-of 查询。
- 记忆合并：**部分**（重复边合并 / 社区摘要，取决于管线配置）。
- 遗忘 / 衰减：**无**——设计取向是「失效 + 可回溯」而不是遗忘/衰减。
- 整合（consolidation）：**有**——community 构建 + 图维护（`graph maintenance`）。

**部署成本 / 离线**

- `pip install graphiti-core`；`docker compose up`（Neo4j）或 `docker compose --profile falkordb up`。
- 需要：图库（Docker）+ LLM（默认 OpenAI）+ embedding key。**成本主要来自逐 episode 的 LLM 抽取**。
- 完全离线：**可以但受限**——图库可本地（Neo4j/FalkorDB），LLM 必须换成支持 structured output 的本地模型，否则 schema 失败。

**已知问题 / 局限**

- 小模型 / 不支持 structured output 的模型直接不可用（README 明示）。
- 抽取成本随 episode 线性增长，长对话 ingestion 慢且贵（issue 总数 538，主题级统计未取）。
- MCP server 无鉴权，**不能直接暴露到网络**。
- Kuzu 后端已 deprecated，选型实际收窄到 Neo4j / FalkorDB / Neptune。

**来源**：https://github.com/getzep/graphiti ｜ https://help.getzep.com/graphiti ｜ 仓库 `mcp_server/README.md`、`server/` ｜ Zep 托管版：https://www.getzep.com

---

## 4. cognee（topoteretes/cognee）

- 仓库：https://github.com/topoteretes/cognee ｜ 文档：https://docs.cognee.ai
- Star：**约 33k**（32,993；2026-11-02 查询）｜ License：**Apache-2.0** ｜ 主语言：**Python** ｜ 最后 push：2026-11-01，open issues 1,075（活跃，issue 积压也最大）

**核心架构**

| 维度 | 事实 |
|---|---|
| 定位 | "open-source AI memory platform for agents"：把文档 / 代码 / 对话变成 self-hosted knowledge graph |
| 管线 | `add` → `cognify`（建图/抽取）→ `search` → `improve`（富化记忆、应用反馈、把 session 知识桥接进长期图）；代码会生成符号与依赖图；session distillation 把 accepted lessons 固化为长期记忆 |
| 存储（默认） | `.env.template:3` 注释写明 "Default databases (SQLite, LanceDB, Ladybug)" —— **SQLite（关系）+ LanceDB（向量）+ Ladybug（图）**，全部本地文件级 |
| 存储（可切） | `DB_PROVIDER=postgres`、`GRAPH_DATABASE_PROVIDER=neo4j`、`VECTOR_DB_PROVIDER=lancedb`；**1.0 起可在单个 Postgres 上跑整套（关系 + PGVector + 图）**，但 README WARNING：Postgres 当 graph store 目前是 **demo feature**，production-ready 版本是 licensed product |
| 检索 | 图 + 向量混合（多种 search 类型），查询期可选用 LLM 做答案合成 |
| LLM 抽取 | **是**；但也可无 LLM key：`pip install cognee[gliner]` 用本地 **GLiNER** 抽取 + 本地 embedding（首次下载模型）。README 明说 bundled GLiNER 是 "a demo of Cognee's small-model pipeline. For a production-ready version with higher accuracy and broader label coverage, reach out"（付费） |

**MCP server**

- **有**：`cognee-mcp/`（docs：`cognee.ai/cognee-mcp/mcp-overview`），`docker compose --profile ui --profile mcp up`；默认端口 API 8000 / UI 3000 / **MCP 8001**。

**自我维护（逐项）**

- 去重：**部分**（图节点/边的归一化与集合式写入，未见对外承诺的语义去重）。
- 冲突检测 / 失效：**无显式 bi-temporal 失效**（与 Graphiti 的关键差异）；靠重新 cognify / improve 覆盖。
- 记忆合并：**部分**（`improve` 会富化与合并，但不是确定性保证）。
- 遗忘 / 衰减：**未查到**明确的 TTL / 衰减机制（有 prune 类运维操作，未逐行核实）。
- 整合（consolidation）：**有**——`improve` + session distillation 就是整合路径。

**部署成本 / 离线**

- `pip install cognee`，默认三件套全是本地嵌入式（SQLite/LanceDB/Ladybug），**无需 Docker、无需外部服务**；也可 `docker compose` 起 API/UI/MCP。
- 完全离线：**可以**（GLiNER + 本地 embedding，不用 LLM key），代价是抽取精度下降（官方自己说 demo 级）。
- 可从 Mem0 / Letta / Zep / Graphiti 迁移（COGX exchange format）。
- 最新 release v1.6.1（2026-09-24）：Google Drive / Gmail OAuth connectors、`/visualize/json` 分块、GLiNER installer 移出 event loop。

**已知问题 / 局限**

- 1,075 个 open issues，积压最重。
- 「本地抽取」是 demo 级；「Postgres 当图库」是 demo 级，两个省成本路径都要付费版才 production-ready。
- 概念多（cognify / improve / memify / distillation），学习曲线陡。
- 主题级 issue 统计未取（GitHub API 限额）。

**来源**：https://github.com/topoteretes/cognee ｜ https://docs.cognee.ai ｜ 仓库 `.env.template`、`cognee-mcp/README.md`

---

## 5. MemOS（MemTensor/MemOS）

- 仓库：https://github.com/MemTensor/MemOS ｜ 文档：https://memos-docs.openmem.net
- Star：**约 12k**（12,225；2026-11-02 查询）｜ License：**Apache-2.0** ｜ 主语言：**TypeScript** ｜ 最后 push：2026-10-29，open issues 151（活跃）
- README 自述："Self-evolving memory OS for LLM & AI Agents: ultra-persistent memory, hybrid-retrieval, cross-task skill reuse, **35.24% token savings** and **DeepSeek Harness support**"；topics 含 `mcp`、`dsh-plugin`、`deepseek-harness`、`openclaw`、`self-evolving`、`skills`。

**核心架构**

| 维度 | 事实 |
|---|---|
| 概念 | **MemCube**：多 cube 知识库，支持隔离 / 受控共享 / 动态组合，跨 user / project / agent；**MemScheduler** 异步 ingestion（自述毫秒级延迟）；分层 **L1 traces / L2 policies / L3 world models** + crystallized Skills |
| 存储（服务端） | **Neo4j + Qdrant**（compose 镜像 `neo4j:5.26.6`、`qdrant/qdrant:v1.15.3`） |
| 存储（本地插件形态） | Hermes Agent / OpenClaw 插件：**100% local SQLite + FTS5 + vector** 混合检索，带 "smart dedup"、tiered skill evolution、Memory Viewer dashboard |
| 检索 | hybrid（向量 + 全文 FTS + 图） |
| LLM 抽取 | **是**（需配 LLM/embedding key） |

**MCP server**

- **有，且是内置服务**：`python src/memos/api/mcp_serve.py`（默认 stdio；`--transport http --host localhost --port 8000`）；文档 `docs/en/open_source/modules/mos/memos_mcp.md`；需 `OPENAI_API_KEY`，`MOS_TEXT_MEM_TYPE=tree_text` 需 Neo4j；示例 `examples/mem_mcp/{simple_fastmcp_client.py,simple_fastmcp_serve.py}`，测试 `tests/api/test_mcp_serve.py`。

**自我维护（逐项）**

- 去重：**有**（本地插件明确写 "smart dedup"；服务端未见同等明确表述）。
- 冲突检测 / 失效：**未查到**明确的 bi-temporal / invalidate 机制。
- 记忆合并：**部分**（cube 组合 / 分层晋升，非确定性 merge）。
- 遗忘 / 衰减：**未查到**（README 主打「ultra-persistent」，取向偏保留）。
- 整合（consolidation）：**有**——L1→L2→L3 晋升 + skill 结晶（tiered skill evolution）。

**部署成本 / 离线**

- 服务端：`cp docker/.env.example .env` 填 key → `cd docker && docker compose up`，**起 API + Neo4j + Qdrant 三个服务**；也可 uvicorn 起（自备 Neo4j/Qdrant）。
- 完全离线：**插件形态可以**（本地 SQLite + FTS5），**服务端不行**（要 Neo4j + Qdrant + LLM key）。

**已知问题 / 局限**

- 自托管门槛高：两个外部数据库 + LLM/embedding key，是 8 个项目里服务端依赖最重的之一。
- 「35.24% token savings」「毫秒级延迟」均为厂商自述，未见第三方复现。
- 项目在 v2 期间从 Python 迁到 TypeScript，API/文档存在双栈并存，选型时要确认版本。
- issue 主题级统计未取。

**来源**：https://github.com/MemTensor/MemOS ｜ https://memos-docs.openmem.net ｜ 仓库 `docker/`、`src/memos/api/mcp_serve.py`、`docs/en/open_source/modules/mos/memos_mcp.md`

---

## 6. memU（NevaMind-AI/memU）

- 仓库：https://github.com/NevaMind-AI/memU ｜ 文档：https://memu.pro/docs
- Star：**约 15k**（14,593；2026-11-02 查询）｜ License：**Apache-2.0**（LICENSE.txt 正文为 Apache 2.0；GitHub API 的 license 字段报 "Other"/NOASSERTION，属元数据识别问题）｜ 主语言：**Python** ｜ 最后 push：2026-10-31，open issues 136（活跃）

**核心架构**

| 维度 | 事实 |
|---|---|
| 定位 | "Personal memory across agents"：跨 session / agent / device 的 shared LLM wiki，从 agent history 蒸馏可复用 skills；core memory logic 自述只有 ~500 行 |
| 存储 | `MEMU_DB`：CLI 默认 `./data/memu.sqlite3`（本地一般 `~/.memu/memu.sqlite3`），或 Postgres DSN；**sqlite = brute-force cosine**，**postgres = pgvector**（`pip install "memu-cli[postgres]"`） |
| 检索 | 向量检索（sqlite 暴力 cosine / pgvector），返回最多 **5 条 hits + resources** 的紧凑 JSON |
| LLM 抽取 | **否（关键差异）**：抽取由**宿主 agent** 完成。原文："The judgment and synthesis stay inside the agent. MemoryService makes no LLM or chat calls; it stores, embeds, and retrieves the skill Markdown the agent prepared." |
| 依赖 | 仍需 **embedding provider**（默认 openai，另有 jina / voyage / doubao / openrouter），即「不调 chat LLM，但要调 embedding」 |
| 宿主集成 | `memu-openclaw`：只读挖 `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite` + legacy `sessions/*.jsonl`，并 patch `~/.openclaw/workspace/AGENTS.md`；`memu-hermes`：读 `~/.hermes/state.db`，patch `~/.hermes/SOUL.md`；`memu-agent detect` 探测 |

**MCP server**

- **未发现官方 MCP**。README、docs 目录（tarball 335 项，`grep -ril mcp` 无命中）、仓库树均无 MCP 代码/文档；仓库 topics 里虽列了 `mcp`，但没有实现证据。
- 第三方 `De13ruyne/memU-mcp` 存在，但非官方、不在本仓维护。
- 结论：**当前不能直接作为 MCP server 被 Claude Code / Codex 接入**（只能通过 CLI 或宿主适配器）。

**自我维护（逐项）**

- 去重：**未查到**（记忆以 skill Markdown 文件形态由 agent 维护，无系统级 dedup）。
- 冲突检测 / 失效：**无**（服务不做 LLM 判断，冲突只能由宿主 agent 发现）。
- 记忆合并：**未查到**（agent 覆写 Markdown 属宿主行为）。
- 遗忘 / 衰减：**未查到**。
- 整合（consolidation）：**部分**——「从 agent history 蒸馏 skills」是整合，但由 agent 驱动，非服务内置调度。

**部署成本 / 离线**

- `pip install memu-cli`，无 Docker、无外部服务（sqlite 模式）；Postgres 模式才需要 DB。
- 离线：**部分**——DB 与检索可全本地，但 embedding 需 provider（可指向本地 embedding 服务）。

**已知问题 / 局限**

- **无 MCP**，接入面窄；设计上把「判断」外包给宿主 agent，独立使用时能力弱。
- 依赖 embedding API；sqlite 模式是暴力 cosine，规模大后检索退化。
- 与 OpenClaw / Hermes 的耦合较深（要 patch 对方的 `AGENTS.md` / `SOUL.md`）。
- issue 主题级统计未取。

**来源**：https://github.com/NevaMind-AI/memU ｜ https://memu.pro/docs ｜ 仓库 README、`LICENSE.txt`

---

## 7. Supermemory（supermemoryai/supermemory）

- 仓库：https://github.com/supermemoryai/supermemory ｜ 文档：https://supermemory.ai/docs
- Star：**约 31k**（31,497；2026-11-02 查询）｜ License：**MIT** ｜ 主语言：**TypeScript** ｜ 最后 push：2026-11-02，open issues 42（非常活跃，issue 积压最少）

**核心架构**

| 维度 | 事实 |
|---|---|
| 定位 | "Memory and context engine + app that is extremely fast, scalable, and **can be run fully locally**. The Memory API for the AI era." |
| 能力 | 从对话抽 facts、建 **user profiles**、处理 temporal changes 与 **contradictions**、自动遗忘过期信息；含 RAG / connectors / file processing |
| 存储（本地） | 自研**内嵌 graph engine**（单进程），数据在本地卷；`npx supermemory local` 起 API `http://localhost:6767`，首次启动打印 API key；Docker 单容器，key 在容器内 `/data/api-key` |
| 存储（云） | Cloudflare Workers / Pages / KV + Postgres（drizzle-orm）+ Remix |
| 检索 | RAG 管线（graph engine + 向量检索） |
| LLM 抽取 | **是**（抽 facts、更新 profile、判矛盾）；本地 embedding 内置 `Xenova/bge-base-en-v1.5`，**无需 embedding API key** |

**MCP server**

- **有，双形态**：托管 `https://mcp.supermemory.ai/mcp`（docs：`supermemory.ai/docs/supermemory-mcp/mcp`）+ 开源自托管 MCP server；README 直接点名可给 **Claude Code、Muse Code、Cursor、Codex、OpenCode** 持久记忆。

**自我维护（逐项）**

- 去重：**部分**（profile 合并 + 噪声过滤）。
- 冲突检测 / 失效：**有**——"handles temporal changes and contradictions"，矛盾自动消解。
- 记忆合并：**部分**（profile 增量更新，非显式 merge 日志）。
- 遗忘 / 衰减：**有**——临时事实（README 例："I have an exam tomorrow"）过期后失效，"Noise never becomes permanent memory"。
- 整合（consolidation）：**部分**（profile 更新即整合，但没有离线批处理整合的公开描述）。

**部署成本 / 离线**

- 本地：`npx supermemory local`（零依赖，内置 embedding，无 API key）；或 `docker compose up -d --wait --wait-timeout 180`，API :6767，数据卷 `supermemory_supermemory-data`（**警告：勿 `docker compose down -v`**）。
- 完全离线：**基本可以**——指向 Ollama（`gpt-oss:20b`）+ `SUPERMEMORY_DISABLE_TELEMETRY=1`，本地文本/文件输入可离线；**例外：URL ingestion 走托管 reader service，非离线**。

**已知问题 / 局限**

- 「完全本地」有例外（URL 抓取走云端 reader），断网时该路径不可用。
- 云侧功能（connectors、部分 RAG 能力）与本地版存在能力差；open issues 仅 42 但仓库体量大（含 app / 浏览器扩展 / 多包），issue 数低不代表成熟度。
- 本地 graph engine 为自研闭源组件（MCP server 才是开源的），扩展性与数据格式可迁移性未查到公开说明。
- 主题级 issue 统计未取。

**来源**：https://github.com/supermemoryai/supermemory ｜ https://supermemory.ai/docs/supermemory-mcp/mcp ｜ 仓库 README

---

## 8. Memobase（memodb-io/memobase）与「OpenMemory / similar」

- 仓库：https://github.com/memodb-io/memobase ｜ 文档：https://docs.memobase.io
- Star：**约 2.9k**（2,946；2026-11-02 查询）｜ License：**Apache-2.0** ｜ 主语言：**Python** ｜ 最后 push：**2026-01-11**，open issues 34（**已停滞约 10 个月**；README 新闻推荐后继项目 `memodb-io/Acontext`）

**核心架构**

| 维度 | 事实 |
|---|---|
| 定位 | "User Profile-Based Long-Term Memory for AI Chatbot Applications"（面向 C 端 chatbot 的用户记忆，不是 agent 记忆） |
| 数据模型 | 结构化 **profile**（basic_info / demographics / education / interest / psychological / work 等分区）+ **time-aware user event timeline**（event gist 支持时间线细粒度检索） |
| 存储 | **Postgres + pgvector** + **Redis**（`src/server/docker-compose.yml`：`pgvector/pgvector:pg17`、`redis:7.4`、`memobase-server-api`，API 端口 8019） |
| 检索 | profile / timeline 直接 SQL 取（自述 "online latency under 100ms"）；`context` API 做语义搜索，自述 500–1000ms（取决于 embedding API） |
| LLM 抽取 | **是**，但刻意压成本：每用户 buffer 批量处理，"no agents in the system"；0.0.40 把单次运行 LLM 调用从 ~3–10 次降到**固定 3 次**，token 成本降 ~40–50% |

**MCP server**

- **仅模板级**：`src/mcp/` fork 自 `coleam00/mcp-mem0`，README 原文 "Use this as a reference point to build your MCP servers yourself"；需自备 Memobase 后端（本地 `http://localhost:8019` / 云 `https://api.memobase.dev` + project token）。
- 结论：**不是可直接投产的 MCP server**，要自己改。

**自我维护（逐项）**

- 去重：**部分**（profile 按 slot 覆盖，天然抑制同槽位重复）。
- 冲突检测 / 失效：**部分**——LLM 更新 profile 时以新值覆盖旧值，但不保留失效历史、无 bi-temporal。
- 记忆合并：**部分**（buffer 批量 → profile 更新即合并）。
- 遗忘 / 衰减：**未查到**（profile 字段可被覆盖，但没有时间衰减 / TTL）。
- 整合（consolidation）：**有**——每用户 buffer 的批量处理就是离线整合。

**部署成本 / 离线**

- 必须 `docker compose`（Postgres + Redis + API），或只跑核心容器 + 自带 Postgres/Redis；`docker pull ghcr.io/memodb-io/memobase`。
- 需 LLM + embedding key；有 Python / Node / Go SDK。
- 完全离线：**否**（三个服务 + 外部模型 API；换本地模型端点后可离线）。

**已知问题 / 局限**

- **项目停滞**（2026-01 后无 push），官方已把注意力转向 Acontext。
- MCP 只是模板；无 agent 记忆能力（设计上只做 user profile）。
- 部署重（PG + Redis），对单机小项目偏重。
- 主题级 issue 统计未取。

**「OpenMemory / similar」补充（同为 mem0 生态）**

- `mem0ai/openmemory`：101 stars，MIT，已从「OpenMemory 记忆服务器（API + UI + Qdrant + `/mcp`）」改造成 **AI coding session 迁移 CLI/TUI**（Claude Code / Codex / OpenCode 之间搬会话），beta。
- `mem0ai/mem0-mcp`：已归档（640+ stars），官方替代是云端 `mcp.mem0.ai`。
- 因此 2024–2025 年文章里那套「本地 OpenMemory + MCP」的部署路径，**在 2026-11 已不可按原文档复现**。

**来源**：https://github.com/memodb-io/memobase ｜ https://docs.memobase.io ｜ 仓库 `src/server/docker-compose.yml`、`src/mcp/README.md` ｜ https://github.com/memodb-io/Acontext

---

## 对比表

| 项目 | Star（2026-11-02） | License | 存储 | 检索 | MCP | 去重 / 冲突失效 | 本地离线 | 维护活跃度 |
|---|---|---|---|---|---|---|---|---|
| mem0 | 约 68k | Apache-2.0 | 本地 Qdrant 文件 + SQLite 历史；server 模式 Postgres+pgvector；**v3 无图** | 向量 + BM25 + 实体融合，单遍 | 云端 MCP（要 key）；本地插件仅 `search_memories` 只读 | 去重：部分；**冲突失效：无**（ADD-only） | 部分（需 LLM+embedding API） | 高（2026-10-30 push，898 open issues） |
| Letta / letta-code | 约 25k / 约 3.8k | Apache-2.0 | 本地 = **文件 + git（MemFS）**；V1 server（PG+pgvector）已归档 | block 自编辑 + `/search` + `/palace` | 托管 `api.letta.com/mcp`（**仅云后端**）；可作 MCP 客户端 | 去重：无；冲突失效：部分（block 覆写） | 部分（默认云后端 + LLM key） | 高（letta-code 当日 push）；主仓已停更 |
| Graphiti (+Zep) | 约 32k | Apache-2.0 | Neo4j / FalkorDB / Neptune（Kuzu 已弃用） | 向量 + BM25 + 图遍历（查询期无 LLM） | 有但**参考实现、无鉴权** | 去重：部分（实体解析）；**冲突失效：有（bi-temporal invalidate）** | 可（本地图库 + 支持 structured output 的本地 LLM） | 高（2026-11-01 push，538 open issues） |
| cognee | 约 33k | Apache-2.0 | 默认 SQLite + LanceDB + Ladybug；可切 Postgres/Neo4j | 图 + 向量混合 | **有**（cognee-mcp，:8001） | 去重：部分；冲突失效：无显式 | **可**（GLiNER 本地抽取，精度 demo 级） | 高（2026-11-01 push，1,075 open issues） |
| MemOS | 约 12k | Apache-2.0 | 服务端 Neo4j + Qdrant；插件 SQLite+FTS5 | 向量 + 全文 + 图混合 | **有内置**（stdio / http） | 去重：有（插件 "smart dedup"）；冲突失效：未查到 | 插件可；服务端不可 | 高（2026-10-29 push，151 open issues） |
| memU | 约 15k | Apache-2.0 | SQLite（默认）/ Postgres+pgvector | 向量（sqlite 暴力 cosine） | **无官方** | 去重：未查到；冲突失效：无（服务不做 LLM 判断） | 部分（需 embedding provider） | 高（2026-10-31 push，136 open issues） |
| Supermemory | 约 31k | MIT | 本地内嵌 graph engine；云 = CF Workers + Postgres | RAG（graph + 向量） | **有**（托管 + 开源自托管） | 去重：部分；**冲突消解 + 自动遗忘：有** | 基本可（URL ingestion 除外） | 很高（2026-11-02 push，42 open issues） |
| Memobase | 约 2.9k | Apache-2.0 | Postgres + pgvector + Redis | profile SQL + 事件时间线 + 语义搜索 | 仅**模板** | 去重：部分（slot 覆盖）；冲突失效：部分（覆盖无历史） | 否（三服务 + 模型 API） | **停滞**（2026-01-11 最后 push） |

---

## 附：本次调研的方法与缺口

- 元数据来源：`api.github.com/repos/<owner>/<repo>`（star / license / language / pushed_at / open_issues），2026-11-02T03:4xZ。GitHub core 限额 60/hr 在 03:45Z 用尽，其后改用 `raw.githubusercontent.com`、`codeload` tarball、官方 docs 的 `.md` 源与 `search` API（10/min）。
- 各项目 README 快照存于 `readmes/`（同目录），源码核验过的关键路径已在正文内标注。
- **缺口**：除 mem0 外，其余 7 个项目未做 issue 主题级频次统计（限额）；MemOS「35.24% token savings」、Memobase「SOTA on LOCOMO」、Supermemory「extremely fast」均为项目自述，未找到第三方复现。
