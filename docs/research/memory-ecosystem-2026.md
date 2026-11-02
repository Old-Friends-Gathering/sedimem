# 面向编码 Agent 的本地跨会话记忆生态调研（2026-11-02）

> 口径：star / license / 最近 push 均于 **2026-11-02（北京时间 11:4x，UTC 03:4x）** 通过 GitHub REST API 实测；命中的仓库逐一标注。文档类结论来自官方文档页面当天抓取。凡本次未核实到的，明确写「未查到」，不做推测填充。

## TL;DR

1. **两极分化**：一端是「纯文本约定」（Cline Memory Bank、Codex/Claude 的 AGENTS.md/CLAUDE.md），零依赖、跨 agent 天然可读，但无检索、无治理；另一端是「本地向量库 + LLM 压缩 + 生命周期管理」（claude-mem、mcp-memory-service、basic-memory），能力完整但引入进程、成本、一致性风险。
2. **官方内置记忆在 2026 年已经出现**：Claude Code 有 auto memory（文件型，`~/.claude/projects/<project>/memory/`），Codex 有 Memories（`~/.codex/memories/`，默认关闭）。两者都是**单产品私有 store**，不通过 MCP 暴露、也不跨 agent 共享。
3. **DeepSeek Harness 官方没有 memory 插件**：`packages/` 下没有任何 memory 包，extension cookbook 只把「记忆」定义为一种扩展模式（`section 提供方 + 工具`）。实际生态由第三方插件承担，awesome 清单的 memory 分类已收录 **639 个**插件。
4. **唯一被官方背书的跨客户端共享机制是「一个 MCP memory server + 一份共享存储」**，MCP 官方参考 server 甚至为此实现了跨进程文件锁。
5. **跨 agent 的「可移植记忆」标准仍在早期**：AGENTS.md 已成为事实标准（60k+ 项目，Linux Foundation 下的 Agentic AI Foundation 托管）；真正的记忆数据协议 `draft-saihm-memory-protocol` 的 ISE 流程刚于 2026-07 结束、正被推向 IETF 正式流程，W3C CG 只做 profile 与一致性测试。

---

## 1. claude-mem（thedotmack/claude-mem）

- 仓库：https://github.com/thedotmack/claude-mem ｜文档/官网：https://claude-mem.ai ｜license 说明：`docs/license.md`、`docs/ip-boundary.md`（open/commercial 边界）
- **⭐ 约 1.1e5（实测 109,548）**，fork 9,581，open issues 176，**Apache-2.0**，TypeScript，创建 2025-08-31，最近 push **2026-11-02T02:01:56Z**，README 版本徽章 **15.8.1**
- 定位：「Persistent memory compression system」——捕获工具调用观察 → AI 压缩成语义摘要 → 注入后续 session

**存储与检索**
- SQLite 存 `sessions` / `observations` / `summaries`；Chroma 向量库做 hybrid（语义 + 关键词）检索
- 本地 worker service（Bun 管理）提供本地 HTTP API、web viewer、search endpoints；数据落在 `~/.claude-mem/`
- MCP 侧 4 个工具，三层渐进披露：`search`（约 50–100 tokens/条）→ `timeline` → `get_observations`（约 500–1,000 tokens/条），宣称约 10x token 节省

**接入形态**
- Claude Code 插件市场：`/plugin marketplace add thedotmack/claude-mem`，靠 6 个生命周期 hook（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SessionEnd）驱动，每个 hook 执行 `claude-mem hook claude-code <event>`
- 跨宿主安装：`npx claude-mem install --ide <grok-bot|opencode|t3code|antigravity|omp|pi|dsh>`；DSH 走原生插件（`--dsh-profile tui`）；另有 OpenClaw 一键脚本；GitHub description 列 Codex/Gemini/Hermes/Copilot/OpenCode

**API key / 离线**
- 安装流程默认会打开浏览器做 email magic link 登录并下发 memory key；在线能力（claude-mem observer 30 天试用、CMEM Pro 托管记忆、Cloud Sync 到 cmem.ai）需要账号
- 可跳过：`--provider` 指定自有 provider，或 `CLAUDE_MEM_ONLINE_OPTIN=false`；向量检索依赖本地 `uv`。**结论：可离线，但默认路径是在线优先**

**多 agent 共用**
- 一个 worker 同时服务多个 harness；但 SessionStart 注入**默认只含当前 harness** 的观察，要跨 harness 共享必须显式设 `CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES=true`
- 团队共享是商业化能力（TeamBrain，每人自选共享内容），非本地

**自我维护**
- 有：AI 压缩/摘要、隐私 `<private>` 标签排除、截图默认关闭、项目级 merge 机制
- 无/弱：去重、冲突检测、过期淘汰、人工审核队列。早期 issue #390「how to delete useless memory」即为该缺口的直接反映

**已知局限与抱怨（issue 实测）**
- **成本与 token 放大**：#3848「claude-mem 在真实编码花费之上多加约 64%」；#2643「静默烧掉 649M tokens」；#3497「conversationHistory 从不裁剪，约 10x token 放大，静默计入用户订阅」
- **进程与资源失控**：#1089（17 小时 48 个孤儿子进程 ≈2.3GB，16GB 机器 swap 14.8GB）、#803（worker 池无上限，34 个 `claude --resume` ≈13.6GB）、#1185（`chroma-mcp` 子进程 500–700% CPU、400MB–1GB+ 内存）
- **捕获停摆**：#4068 配额守卫在 `resetsAt` 已过期的快照上持续 abort（`Aborting session for quota guard: quota:seven_day utilization 93.0% >= 93%`），重启 worker 会丢弃内存队列（1297 条 ENQUEUED 事件丢失）
- **项目隔离**：#683 全局单库跨项目污染；#4782 monorepo 内 `withPrimaryKey()`（`src/utils/project-name.ts:384-398`）仍保留 git-root key、`projectReadKeys()`（`src/services/sqlite/project-read-keys.ts:41-60`）把 merged 源项目提升为整项目读 key；#5093 stdio 客户端把 cwd 设为插件目录导致所有 session 归到同一项目

---

## 2. basic-memory（basicmachines-co/basic-memory）

- 仓库：https://github.com/basicmachines-co/basic-memory ｜官网：https://basicmemory.com
- **⭐ 4,445**，fork 345，open issues 92，**AGPL-3.0**，Python，创建 2024-12-02，最近 push **2026-11-02T03:33:38Z**（v0.24.x 线，v0.24.0 milestone 于 2026-10-29 关闭）

**存储与检索**
- 真相在**纯 Markdown 文件**（默认 `~/basic-memory`），本地 **SQLite 索引**；可选 Postgres 后端，向量可落 Milvus（`basic-memory[milvus]`）
- 语义检索用 **FastEmbed（ONNX，本地）**，hybrid 全文 + 向量；可选 cross-encoder rerank（默认 `jinaai/jina-reranker-v1-tiny-en` 本地，或 LiteLLM 托管如 `cohere/rerank-v3.5`，需 `COHERE_API_KEY`）
- 文件格式：frontmatter（title/type/permalink/tags）+ `## Observations`（`- [category] fact #tag`）+ `## Relations`（`- relates_to [[Target]]`）

**接入形态**
- MCP server 为主：stdio `uvx basic-memory mcp` 或 https。Claude Desktop / Claude Code（`claude mcp add basic-memory -- uvx --prerelease=allow basic-memory mcp`）/ Codex CLI（`~/.codex/config.toml` `[mcp_servers.basic-memory]`，可加 `default_tools_approval_mode = "approve"`）/ Cursor `.cursor/mcp.json` / VS Code / ChatGPT（search+fetch actions）
- 另发官方 Claude Code 插件（`bm install claude-code`：session-start briefings、pre-compaction checkpoints、`/basic-memory:bm-setup|remember|share|status`）、skills 包、Hermes 插件、OpenClaw 插件
- 工具集：`bm_write/read/edit/move/delete/search/list/find/context/project/schema/man`，均带 MCP 行为注解（readOnlyHint / destructiveHint / idempotentHint / openWorldHint），支持渐进式工具发现

**API key / 离线**
- 本地完全不需要 key；只有 Cloud / 托管 reranker 需要。**本地离线：是**（air-gapped friendly）

**多 agent 共用**
- 天然支持：Markdown 文件可被任意 MCP 客户端 + Obsidian 同时读写；Cloud 版做跨设备同步（rclone，含冲突消解）与 Teams 共享 workspace

**自我维护**
- 部分：`bm_schema(infer|validate|diff)` 结构推断/校验/差异；`bm doctor` 文件↔DB 一致性检查与修复建议；写入有 checksum 防误覆盖、`bm_edit` 显式修改
- issue #993 提出 frontmatter 级 `locked` / `permissions`（只读笔记、agent 不得静默改）与可强制的 schema 校验，已进 v1.0 设计窗口
- 无：自动去重、向量级冲突消解、过期淘汰（未查到）

**已知局限与抱怨**
- 822 个 issue，集中在工程摩擦而非记忆质量：安装需 `--prerelease=allow`（否则静默装旧版）、CLI 挂起（#504，升级后多数命令 hang）、DB 表缺失（#87 `no such table: entity`）、`build_context` 输出不符 schema（#263，MCP error -32602）、Docker 镜像长期滞后（#153）
- 项目/多仓配置曾长期靠手改 mcp.json（#220），多项目场景体验粗糙

---

## 3. mcp-memory-service（doobidoo/mcp-memory-service）

- 仓库：https://github.com/doobidoo/mcp-memory-service
- **⭐ 2,058**，fork 378，open issues 36，**Apache-2.0**，Python，创建 2024-12-26，最近 push **2026-11-01T21:20:07Z**

**存储与检索**
- 四种后端：**SQLite**（本地单用户默认，sqlite-vec）/ **Cloudflare**（云多设备）/ **Hybrid**（本地 5ms 读 + 后台云同步，`MCP_HYBRID_SECONDARY_BACKEND=http` 可同步到另一实例）/ **Milvus**（Lite 文件、自托管或 Zilliz Cloud）
- 检索：本地 ONNX embedding 向量 + BM25 混合；`mode="ranked"` 按 recency / access frequency / quality 加权；tag AND/OR、自然语言时间范围、store partitions（default/docs/all）；可选 `summarize=true` 查询感知摘要（需 `MCP_SEARCH_SUMMARIZE_ENABLED=true` + LLM provider）

**接入形态**
- 一个服务三种进程模式：stdio MCP（`memory server`）、HTTP REST + dashboard（`memory server --http`，默认 127.0.0.1:8000）、MCP-over-HTTP（`--streamable-http`）
- 客户端覆盖最广：Claude Desktop/Code、Codex CLI、Gemini CLI、OpenCode、Goose、Aider、Amp、Cursor、Windsurf、JetBrains、Zed；REST 供 LangGraph/CrewAI/AutoGen；Remote MCP over HTTPS + OAuth 2.0 + DCR 供 claude.ai / ChatGPT Developer Mode
- 自动记忆：Codex hooks（`python3 codex/install_hooks.py`）、Claude Code hooks（`claude-hooks/`）

**API key / 离线**
- 无云依赖即可全本地（ONNX embedding、SQLite）；HTTP 模式可配 `MCP_API_KEY`；远程模式必须 OAuth。**本地离线：是**

**多 agent 共用（设计目标之一）**
- `X-Agent-ID` header 自动打 `agent:<id>` 标签做 scoped retrieval；`conversation_id` 绕过去重；SSE 事件在任一 agent 写入/删除时实时通知；Hybrid 支持多主机 delta-sync（默认关）。RFC #1345 正在推进「append-only 事件日志 + 每 agent  authorship」的多写 mesh

**自我维护（同类中最完整）**
- autonomous consolidation：定时聚类、压缩、关联发现、controlled forgetting（`docs/guides/memory-consolidation-guide.md`）
- beliefs + 置信度评分 + 启发式矛盾检测：旧记忆标 `superseded`，默认检索隐藏、可显式查
- `memory_harvest` 从 transcript 提 decisions / bugs / conventions / lessons；entity extraction（@mentions / #tags / URL / 文件路径）；quality scoring 可指向 Ollama / LiteLLM / vLLM；insight cards 呈现 pattern / trend / knowledge gap
- 运维：`memory launch|info|logs|stop`、8 tab dashboard、JSON 导入导出、mem0 迁移、定时备份

**已知局限与抱怨**
- **hooks 静默失败**（#530，最伤的一条）：默认 MCP 配置只起 stdio server，而 `session-end.js` / `auto-capture-hook.js` 直接 POST `http://localhost:8000`，结果「218+ 个 session、零条 session-consolidation 记忆」，且无任何报错——读路径正常让人误以为一切正常。用户需 bash wrapper 同时起两个进程
- Docker 镜像缺 ONNX 质量评分依赖（#782）；日志卫生欠账大（#1146：573 处未消毒 f-string logger 调用）
- 单人维护（README 明说 maintained by one person），有 Ko-fi/Sponsors
- 推理能力仍在补：`SemanticReasoner` 的传递闭包 / 溯因曾是 `return []` 占位（#732）

---

## 4. Cline Memory Bank（memory-bank 约定）

- 官方文档：https://docs.cline.bot/best-practices/memory-bank
- **形态：纯文档方法论**，不是插件、不是 MCP、仓库里没有对应代码 → 无 star / license 可言（license 随你所在项目）

**做法**
1. 复制文档给的 custom instructions → 2. 放进 Cline Rules 文件（如 `.clinerules/memory-bank.md`）→ 3. 让 Cline 执行 "initialize memory bank"

**文件层级**（均在项目内 `memory-bank/`）
| 文件 | 作用 |
|---|---|
| `projectbrief.md` | 基础文档，其他文件的源头 |
| `productContext.md` | 为什么做这个项目 |
| `activeContext.md` | 当前工作焦点（最动态） |
| `systemPatterns.md` | 架构与模式 |
| `techContext.md` | 技术栈与 setup |
| `progress.md` | 状态与里程碑 |

**存储 / 检索 / 治理**
- 存储：项目内 Markdown；检索：**无**——靠 session 开始时通读全部文件塞进上下文
- 去重 / 冲突 / 过期 / 整合：**均无机制**，完全依赖模型自觉在 session 结束时更新；人工只能靠 git diff 事后审查

**多 agent 共用**
- 文件在仓库里，任何能读文件的 agent 都能读；但「注入」取决于各客户端自己的 rules 机制，没有统一协议

**社区实现（把约定 MCP 化）**
- `alioshr/memory-bank-mcp`：inspired by Cline Memory Bank 的 MCP server，做远端 memory bank 管理 — https://github.com/alioshr/memory-bank-mcp
- `Sato-Isolated/memory-bank-mcp-mongo`：同思路 + MongoDB 后端 — https://github.com/Sato-Isolated/memory-bank-mcp-mongo
- 两者 star 数本轮**未核实**（GitHub API 触发速率限制）

**已知局限与抱怨**
- 结构性缺陷清晰可推：全量注入 → token 随项目增长线性膨胀；无索引 → 无法按需召回；更新靠自觉 → 实际使用中 `activeContext.md` / `progress.md` 容易漂移；无冲突处理
- 社区批评（第三方评测，非官方度量）：token 开销大、需手动维护、与真正检索方案相比扩展性差。**未见官方给出量化数据**

---

## 5. OpenAI Codex CLI：AGENTS.md + Memories

- 文档：https://learn.chatgpt.com/docs/customization/（AGENTS.md / Memories / Skills / MCP / Subagents 五个层次）
- 形态：**文件约定 + 产品内置记忆**，不是 MCP

**AGENTS.md**
- 位置：`~/.codex/AGENTS.md`（个人全局）+ 仓库根/嵌套 AGENTS.md（团队）；**越近越优先**；官方建议「保持小」
- 维护手段：PR 评论 `@codex add this to AGENTS.md` 委派更新；scheduled tasks 做 guidance drift 检查；配套 pre-commit / linter / typechecker 强制

**Memories（官方 memory，2026 年已有）**
- 默认**关闭**：本地 `config.toml` 里 `[features] memories = true`；ChatGPT 桌面 Settings > Personalization → "Enable Codex memories"
- 存储 `~/.codex/memories/`（summaries、durable entries、recent inputs、supporting evidence）；文档明确 "Treat these files as generated state … don't rely on editing them by hand"
- 生成方式：后台异步（等 chat idle），自动 redact secrets、跳过 active/short session
- 配置项：`memories.generate_memories`、`memories.use_memories`、`memories.disable_on_external_context`（旧名 `no_memories_if_mcp_or_web_search`）、`memories.min_rate_limit_remaining_percent`、`memories.extract_model`、`memories.consolidation_model`
- 控制：CLI `/memories` 决定当前 chat 是否可读/可贡献；存在 global memory consolidation 概念
- 官方定位原话：「Keep required team guidance in AGENTS.md or checked-in documentation. Treat memories as a helpful recall layer, not as the only source for rules that must always apply.」

**多 agent 共用**
- AGENTS.md 是**跨 agent 事实标准**（见 §9）；Memories 则是 Codex 本地私有 store，不通过 MCP 暴露、不被其他客户端读取

**自我维护**
- 有：后台异步提炼 + consolidation + secret redaction + 自动跳过短 session
- 无：冲突检测/人工审核界面（未查到）；文件被视为生成态，不鼓励手改

---

## 6. Anthropic Claude Code：CLAUDE.md / `#` / auto memory

- 文档：https://code.claude.com/docs/en/memory（页面标题 "How Claude remembers your project"）
- 形态：**文件约定 + 产品内置记忆**，不是 MCP

**两套机制**
1. **CLAUDE.md 家族**（人写，指令/规则）
2. **auto memory**（Claude 自己写，learnings/patterns）

**CLAUDE.md 加载顺序**（全部拼接、非覆盖）
managed policy（macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`、Linux/WSL `/etc/claude-code/CLAUDE.md`、Windows `C:\Program Files\ClaudeCode\CLAUDE.md`）→ user `~/.claude/CLAUDE.md` → project `./CLAUDE.md` 或 `./.claude/CLAUDE.md` → local `./CLAUDE.local.md`；子目录按需加载；`@path/to/import` 最多 4 跳；HTML 注释块注入前剥离；>4MiB 跳过；建议 <200 行

**补充机制**
- `.claude/rules/`：`paths:` frontmatter 做路径域规则；`~/.claude/rules/` 用户级；支持 symlink 共享（外部目标需批准）
- **AGENTS.md 官方互操作**：v2.1.277+ 内建插件 `cc-plugin-agents-md@builtin`；`/config` 的 Project instructions 四档 `claude-md-or-agents-md`（默认）/ `claude-md-and-agents-md` / `claude-md` / `managed-only`；也可在 settings `pluginConfigs."cc-plugin-agents-md@builtin".options.instructionFiles` 配置

**auto memory**
- 默认本地开启（self-hosted 环境默认关）；四类 `type`：`user` / `feedback` / `project` / `reference`
- 存储 `~/.claude/projects/<project>/memory/`：`MEMORY.md` 索引 + 每主题一文件；**每次 session 只加载 MEMORY.md 前 200 行或 25KB**；`modified` frontmatter 记录写入时间
- 按 git repo 派生 project 名 → **跨 worktree 共享**；不随 `cleanupPeriodDays` 清理
- 开关：`autoMemoryEnabled`、`autoMemoryDirectory`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`

**命令**
- `/memory`：列出/打开 CLAUDE.md、CLAUDE.local.md、auto memory 目录，并含 auto memory 开关
- `/context`：查看实际加载的 Memory files；`/doctor prompt-audit`（v2.1.283+）审计过期/冲突指令；`/init` 生成 CLAUDE.md；`/import` 导入其他 agent 配置

**关于 `#` 快捷记忆命令**
- **未在当前官方文档查到** `#` 前缀快捷添加记忆的说明；文档现在的表述是 "When you ask Claude to remember something … Claude saves it to auto memory" 或「把这条加到 CLAUDE.md」。判断：`#` 写法疑似已被 auto memory 取代，**报告中不作为现行能力陈述**

**多 agent 共用**
- CLAUDE.md 是纯文本，其他 agent 可读；官方已通过 `cc-plugin-agents-md` 支持读 AGENTS.md。但 auto memory 是 Claude Code 私有目录，其他客户端读不到

**自我维护**
- 有：Claude 自动写入 + 按类型归档 + 索引化 + `prompt-audit` 审计冲突
- 无：去重、过期淘汰（明确不随 `cleanupPeriodDays` 清理）、冲突自动消解
- 官方自述局限：CLAUDE.md 是 context 不是强制配置，含糊/冲突指令可能被任选其一，跨文件冲突需人工 review

---

## 7. DeepSeek Harness：官方没有 memory 插件

- 仓库：https://github.com/deepseek-ai/deepseek-harness ｜**⭐ 268,576**，fork 32,598，**MIT**，TypeScript，创建 2026-08-13，最近 push **2026-10-30T06:54:11Z**；description "Everything is a Plugin."
- 注意：仓库 `has_issues=false`（无 issue 跟踪，只有 discussions）；根 `CLAUDE.md` 仅 9 字节，真正的规范是根 `AGENTS.md`（19KB）

**官方证据（三重）**
1. `packages/` 下 40+ 子包（acp / api / attachment / boot / browser-use / bundle / client / compaction / computer-use / context / core / credentials / deliverables / document / experimental / extensions / feedback / fs / goal / guard / host / identity / interaction / jobs / llm / lsp / mcp / plan / preset / ptc-runtime / sandbox / schedule / sdk / session-query / session / settings / shell / skill / spill / ssh / storage / subagent / subprocess / telemetry / terminal / todo / typert / util / web / workflow / workspace）中**没有任何 memory 包**
2. `docs/cookbook/extension-cookbook.zh.md` 的「功能→机制映射」表把记忆列为一种**扩展模式**，而非内置能力：
   - `| 记忆 | section 提供方 + 工具 |`
   - `| AGENTS.md（根目录） | 一个读取该文件的 section 提供方 |`
   - `| AGENTS.md（子目录，按需触发）+ 文件变更通知 | 从 watcher / 工具结果监听器调用 agent.inject() |`
   - `| MCP | 每个服务器一个插件：发现工具 → ctx.tools.register() |`
3. system prompt 通过 `ctx.systemPrompt.section()` 注入（带排序与作用域局部覆盖）——这正是「记忆注入」的官方接缝

**社区事实上的 memory 生态**
- `billliao/awesome-dsh-plugin` 的 `categories/memory.md` 自称收录 **639 个** memory 类插件（Persistent memory / knowledge bases / context retention）
- 星数前列：`text2future/flowix` ⭐493（Notes + agent memory）、`himovo/movo` ⭐475（自托管企业 Agent 平台）、`seriousz158/dsh-memory` ⭐180、`Aik358/dsh-auto-memory` ⭐172（事件驱动 recall + 三层自动 consolidation + skill 固化）、`ZSeven-W/dsh-noema` ⭐129、`AskTheWay/dsh-auto-memory` ⭐119（Claude Code 风格 typed files + `MEMORY.md` 索引注入）、`Soren-ABT/dsh-knowledge` ⭐77（RAG）
- 形态几乎全是 **DSH 原生插件（Cordis plugin）**；少数同时发 MCP server 或做桥接：`lna-lab/distill-kura`（插件 + MCP）、`qualixar/dsh-superlocalmemory`（stdio MCP 接 SuperLocalMemory）、`baaai123/dsh-memory-protocol`（桥接 opencode-memory MCP server）、`nowledge-co/nowledge-mem-deepseek-harness`、`meisijiya/omp-memory-dsh`（跨 agent 共享 lessons）
- 治理能力是这批插件的分化点：`Ukashi0/dsh-memory-guardian`（provenance + conflict review + dashboard）、`rezon-aki/dsh-memory-steward`（待审批队列 + 审批 Tab + 带备份执行）、`AieXile/dsh-memory-plugin`（轮末草稿审批 + supersedes 版本链）、`liangxiaobing520/dsh-local-vector-memory`（去重 + 冲突检测 + 软删除回收站）、`aujurd22/dsh-flymemory`（supersede/decay/entity-state）、`GIT121995/dsh-memory-gate`（retrieved ≠ injected）
- 生态噪声：同名 fork 泛滥（`dsh-noema` 在清单里重复出现约 20 次），质量高度参差

**结论**
- 官方无 memory 插件；官方只提供「section provider + tool」这一接缝
- 想要官方口径的记忆能力，当前唯一路径是第三方插件；跨 agent 共用则要自己搭 MCP server 或选带 MCP 的插件

---

## 8. 其他 MCP 形态的 memory server

### 8.1 MCP 官方参考实现 `@modelcontextprotocol/server-memory`
- 仓库：https://github.com/modelcontextprotocol/servers（`src/memory`）｜**⭐ 91,742**，fork 11,903；仓库 license 字段 "Other/NOASSERTION"，但 README 明示该 server 为 **MIT**；Docker 镜像 `mcp/memory`
- 数据模型：知识图谱三要素 — Entities（name / entityType / observations）、Relations（from / to / relationType，主动语态）、Observations（原子事实字符串）
- 工具 9 个：`create_entities`（重名忽略并列入 structured result 的 `skipped`）、`create_relations`（重复跳过，端点不存在则失败）、`add_observations`、`delete_entities`（级联删关系）、`delete_observations`、`delete_relations`、`read_graph`、`search_nodes`（name/type/observation 全文匹配）、`open_nodes`
- Resource：`memory://knowledge-graph`（application/json），mutation 发 `notifications/resources/updated`；协议双栈：2026-07-28 客户端用 `server/discover` + `subscriptions/listen`，2025 客户端用 `initialize` + `resources/subscribe`
- 存储：**单 JSONL 文件**（`MEMORY_FILE_PATH`，默认 server 目录 `memory.jsonl`），启动时自动迁移 legacy `memory.json`
- **多客户端共用（README 有专章）**：每个客户端起自己的进程，多进程写同一文件靠 `<memory file>.lock` 排他锁；崩溃残留锁在确认进程退出后立即清除，否则 30s 未刷新（持锁方每 15s 刷新）由 `<memory file>.lock.break` 守护打破；60s 拿不到锁则工具报错；依赖本地文件系统的排他创建，**不支持不遵守该语义的网络文件系统**
- 检索：无向量、无 embedding，纯子串/全文 + 全图读取
- 自我维护：**基本没有**——仅关系去重跳过；无过期、无整合、无冲突检测；人工可删
- 运行要求：Node ≥24

### 8.2 `knowledge-graph-memory`
- npm registry 查询 `@modelcontextprotocol/knowledge-graph-memory-server` → **404 Not found**；该名字只出现在第三方 MCP 目录站（mcp.opclaw.me / shyft.ai / getlulu.dev）
- **结论：未查到官方 knowledge-graph-memory 包。官方只有 `server-memory`（其本身即知识图谱实现）**

### 8.3 Memory Bank 的 MCP 化
- `alioshr/memory-bank-mcp`、`Sato-Isolated/memory-bank-mcp-mongo`：把 Cline 的六文件约定搬到 MCP + 远端/DB 存储（star 未核实）

### 8.4 框架 / 商业层（仅列形态，本轮未逐项核实 star 与 license）
- **mem0 / OpenMemory**：SDK + MCP，向量 + 图，托管与自托管并存；mcp-memory-service 提供 mem0 迁移导入
- **Letta（MemGPT 系）**：agent 运行时内置记忆层级，MCP 之外自成体系
- **Honcho（plastic-labs）**：entity-centric peer 建模 + 推理层，被 mcp-memory-service 的 RFC #732 列为对标
- **supermemory**：发布 xAFS 检索评测（tokens per correct answer）；**MemoryLake / HydraDB** 等以 DSH 插件形态出现
- 这些共同点是「记忆即服务（SaaS）」，与「本地离线」诉求冲突

---

## 9. 跨 agent 的通用记忆标准 / 协议进展

### 9.1 AGENTS.md（事实标准，已成型）
- 站点：https://agents.md ｜托管方：**Agentic AI Foundation（aaif.io，Linux Foundation 下）**，原话 "AGENTS.md is now stewarded by the Agentic AI Foundation under the Linux Foundation"
- 规模：宣称 **60k+ 开源项目**使用（GitHub code search `path:AGENTS.md NOT is:fork NOT is:archived`）
- 采用者：Codex(OpenAI)、Jules(Google)、Factory、Aider、goose、opencode、Zed、Warp、VS Code、Devin(Cognition)、UiPath、Junie(JetBrains)、Amp、Cursor、RooCode、Gemini CLI、Kilo Code、Phoenix、Semgrep、GitHub Copilot coding agent、Ona、Windsurf、Augment Code
- 规则：无必填字段、纯 Markdown；嵌套就近优先（OpenAI 主仓当时有 88 个）；冲突时最近的胜；显式用户 prompt 覆盖一切
- 本质：**指令/约定的可移植，不是记忆数据的可移植**

### 9.2 MCP 层：没有记忆语义，只有工具约定
- MCP 规范不定义「记忆」原语；W3C CG charter §4 明确把 tool-routing / tool-invocation 语义划归 MCP，把 memory portability 划归自己 → 说明**至今没有 MCP 级记忆语义标准**
- 事实约定来自参考实现：`create_entities` / `add_observations` / `search_nodes` 这套知识图谱工具名，被大量第三方 server 模仿（如 `memory_*` 家族）

### 9.3 W3C「AI Agent Memory Interoperability Community Group」
- 主页：https://www.w3.org/community/ai-agent-memory-interop/
- 章程 v1.0 于 **2026-06-19 通过**（2026-06-05 发起 consensus，无持续反对），**2026-07-16 公布**
- 目标：让 agent 记忆「跨厂商、跨模型、跨框架、跨工具生态**可移植且可验证**」；产出**互操作 profile + 用例目录 + 一致性判据/测试向量/测试套件**
- 定位：**在协议之上做一层**，不重新定义协议；normative reference 是 IETF 的 `draft-saihm-memory-protocol-01`
- 覆盖的协议要素：memory-cell 形状与编码、密码学信封与密钥派生（per-cell HKDF）、身份/签名绑定（**ML-DSA-65**，FIPS-204）、audit-anchor receipt、共享合约、密码学擦除
- 合规 crosswalk（informative）：GDPR Art.17、EU AI Act (2024/1689)、NIST AI RMF 1.0、ISO/IEC 27001:2022、ISO/IEC 42001:2023，以及 HIPAA/PIPEDA/PIPL/LGPD
- 明确 out of scope：向量库/embedding 语义、agent runtime 语义、tool routing
- 效力：CG 只出 Community Group Report，**不是 W3C Recommendation**
- 生态位：AAIF（Linux Foundation）托管参考实现，实现为 **Apache-2.0**

### 9.4 IETF：`draft-saihm-memory-protocol`
- https://datatracker.ietf.org/doc/draft-saihm-memory-protocol/
- **2026-07-29 状态更新**：ISE（Independent Submissions Editor）已结束审议并把该 draft 移出 ISE 队列，datatracker stream 置为 None；方向是**转入 IETF 正式流程**
- 同期 **IETF 126（Vienna，2026-07）** 开了 **agentproto BoF**，讨论 agent-to-agent / agent-to-tool 协议需要标准化什么、是否成立 WG
- CG 章程 §2.1 的「不得另立竞争性规范」时限约束因 ISE 流程结束而自动解除；CG 姿态不变（仍只做 profile 与测试）

### 9.5 判断
- 2026 年**可落地的跨 agent「记忆」只有两层**：AGENTS.md（指令层）+ MCP memory server（工具层，需自己选实现并共享存储）
- 真正带密码学擦除、可验证审计、跨厂商迁移的「记忆数据标准」仍在 IETF/CG 阶段，**尚无任何编码 agent 产品原生支持**
- 评测侧也在动：BEAM（ICLR 2026，arXiv:2510.27246）显示所有记忆系统（长上下文 / RAG / 商业方案）最弱项是**矛盾消解**，其次是时序推理与知识更新——正好对应各家「冲突/过期」能力的普遍缺失

---

## 对比表

| 方案 | 形态 | 存储 | 检索 | 多客户端共用 | 自我维护 | 本地离线 | license | 活跃度（2026-11-02） |
|---|---|---|---|---|---|---|---|---|
| **claude-mem** | Claude Code 插件 + hooks + MCP（4 工具） | SQLite + Chroma 向量，`~/.claude-mem/` | hybrid 语义+关键词，三层渐进披露 | 部分：同 worker 多 harness，需 `..._INCLUDE_ALL_SOURCES=true`；TeamBrain 为云付费 | 部分：AI 压缩/摘要/隐私标签/项目 merge；无去重、无冲突消解、无过期、无审核队列 | 是（但默认引导在线登录） | Apache-2.0 | ⭐109,548；push 2026-11-02；v15.8.1；176 open issues |
| **basic-memory** | MCP server（+ Claude Code 插件 / skills） | Markdown 文件 + SQLite 索引；可选 Postgres + Milvus | FastEmbed 本地向量 + 全文 hybrid，可选 rerank | **强**：文件即真相，Obsidian 与任意 MCP 客户端同时读写；Cloud 做跨设备/Teams | 部分：schema infer/validate/diff、doctor 一致性、checksum 防覆盖；无自动去重/冲突/过期 | **是** | AGPL-3.0 | ⭐4,445；push 2026-11-02；v0.24.x；92 open |
| **mcp-memory-service** | MCP + REST + dashboard + OAuth 远程 MCP | SQLite / Cloudflare / Hybrid / Milvus | ONNX 向量 + BM25 hybrid，ranked 加权，tag/时间/partition | **强（设计目标）**：`X-Agent-ID` scoped、SSE 通知、hybrid delta-sync | **最强**：consolidation、beliefs+置信度、矛盾检测(superseded)、harvest、entity extraction、quality scoring、controlled forgetting | **是** | Apache-2.0 | ⭐2,058；push 2026-11-01；36 open；单人维护 |
| **Cline Memory Bank** | 文件约定（rules 注入） | 项目内 `memory-bank/*.md`（6 文件） | **无**（每次全量读入上下文） | 弱：文件可读，但注入依赖各客户端 rules | **无**：无去重/冲突/过期/整合，靠模型自觉 | 是 | 随项目（无独立 license） | 官方文档持续维护；无仓库指标 |
| memory-bank-mcp / -mongo | MCP server（社区） | 远端存储 / MongoDB | 未查到细节 | 是（MCP 多客户端） | 未查到 | 视部署 | 未核实 | star 未核实（API 限流） |
| **Codex CLI** | AGENTS.md 文件约定 + 内置 Memories | `~/.codex/memories/`（生成态文件） | 未公开（后台生成 + 注入） | AGENTS.md 跨 agent；Memories **不共享**、不暴露 MCP | 部分：异步提炼 + consolidation + secret redaction；无冲突审核 | 是（默认关闭，需 `[features] memories=true`） | 闭源产品 | 官方文档 2026 年持续更新 |
| **Claude Code** | CLAUDE.md/rules 文件约定 + auto memory + 插件 | `~/.claude/projects/<project>/memory/`（MEMORY.md 索引 + 主题文件） | 无向量；索引注入（前 200 行 / 25KB）+ `/memory` 浏览 | CLAUDE.md 跨 agent 可读；已支持读 AGENTS.md；auto memory **私有** | 部分：自动写入/分类/索引 + `prompt-audit` 审计冲突；无去重/过期/自动消解 | 是（self-hosted 默认关） | 闭源产品 | v2.1.28x 线持续迭代 |
| **DeepSeek Harness（官方）** | 无内置；cookbook 定义接缝（section provider + 工具） | 无 | 无 | 由所选插件决定 | 无 | 是 | MIT（仓库） | ⭐268,576；push 2026-10-30；无 issue 跟踪 |
| DSH 社区 memory 插件（639 个） | 原生 Cordis 插件（少数兼发 MCP） | 从纯 Markdown 到 SQLite/FTS5/本地向量都有 | 从全量注入到 hybrid 召回都有 | 少数（桥接 MCP / 跨实例 RULES.md） | 分化：少数有冲突审核/审批队列/版本链；多数仅存取 | 多数是 | 各异（多为 MIT） | 极活跃但碎片化，fork 刷榜严重 |
| **MCP `server-memory`** | 官方参考 MCP server | 单 JSONL 文件 + `.lock` 排他锁 | 子串/全文匹配 + 全图读取，无向量 | **强（有专章）**：多进程写同一文件，15s 续锁 / 30s 破锁 / 60s 超时 | **弱**：仅关系去重跳过；无过期/整合/冲突检测 | **是** | MIT（README）/ 仓库 NOASSERTION | ⭐91,742（整仓）；参考实现 |
| **W3C CG + IETF draft** | 标准/协议（非产品） | memory-cell（编码 + 密码学信封） | 不涉及（out of scope） | 协议目标即跨厂商可移植 | 协议内置 audit receipt + 密码学擦除 | 与实现无关 | 参考实现 Apache-2.0 | CG 2026-06 立章；IETF ISE 2026-07 结束，转 IETF |

---

## 选型建议（按诉求）

| 诉求 | 建议 | 理由 |
|---|---|---|
| 只想让 agent「记住项目约定」，零运维 | AGENTS.md（Codex/Cursor/Copilot/Gemini 通吃）+ 项目内 CLAUDE.md | 60k+ 项目验证、跨 agent、可 code review；缺点是容量与治理靠人 |
| 团队多 agent（Claude Code + Codex + Cursor）共用一份记忆 | **basic-memory**（文件即真相）或 **mcp-memory-service**（agent 维度最强） | 前者可被 Obsidian/任意客户端同时读写、离线、无 key；后者有 `X-Agent-ID`、SSE、consolidation |
| 要「自动捕获、不用手动写」 | **claude-mem**（Claude Code 生态最顺） | hooks 全自动，代价是 64%+ token 成本与进程风险（见 issue） |
| 要冲突消解 / 遗忘 / 整合 | **mcp-memory-service** | 唯一把 beliefs、矛盾检测、controlled forgetting 做成产品特性的 |
| DSH 用户 | 第三方插件；优先看带治理能力的（guardian / steward / memory-gate / flymemory） | 官方无 memory 包，只能用插件，且需自行评估质量（同名 fork 多） |
| 要「未来能跨厂商迁移、可验证擦除」 | 现在没有可用产品，关注 IETF `draft-saihm-memory-protocol` + W3C CG | 编码 agent 产品无一原生支持 |

## 共性缺口（跨方案观察）

1. **矛盾/过期处理是全场最弱**：BEAM 评测已证明所有记忆系统在 contradiction resolution 上最差；产品侧只有 mcp-memory-service 与极少数 DSH 插件做了 supersede/审批。
2. **「检索到 ≠ 应该注入」**：多数方案默认把召回内容直接塞进 prompt，只有 `dsh-memory-gate` 一类明确建模「use / verify / ignore」。
3. **成本不可见**：claude-mem 的三条 issue（+64% 花费、649M tokens、~10x 放大）说明自动记忆的 token 账目缺乏默认可见性。
4. **多 agent 共享仍是「共享一个后端」，不是「共享一套语义」**：没有方案能保证两个 agent 对同一条记忆的写入语义一致。
5. **标准与产品脱节**：AGENTS.md 已成事实标准但只覆盖指令；记忆数据协议还在 IETF，产品全部私有格式。
