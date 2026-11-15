# 编码 agent 宿主的上下文压缩与恢复机制调研（2026-11）

> 调研目的：为 sedimem「任务库」（scope `session:<id>`）设计跨会话上下文延续，先摸清主流宿主自己怎么压、怎么恢复、丢什么。
> 纪律：每条结论标注来源；区分【官方文档】与【源码/issue 实证】。未验证之处明确标注。

---

## 1. Claude Code

### 1.1 触发点与压缩方式 【官方文档】
来源：[探索上下文窗口](https://code.claude.com/docs/zh-CN/context-window)、[context-window.md](https://code.claude.com/docs/en/context-window.md)

- 接近上下文上限时**自动压缩**（auto-compact），机制与手动 `/compact` 相同。
- `/autocompact <token数>` 可设置提前压缩的窗口占用点（如 `/autocompact 500k`）。
- `/compact [指令]` 可带焦点指令，如 `/compact focus on the auth bug fix`——摘要保留你指定的内容而非自动推测。
- `/rewind` 支持从某条消息起做部分压缩（Summarize from here / up to here）。

### 1.2 压缩后到底保留什么 【官方文档】（这是全文档最有价值的部分）
来源同上：

- **重新读取最多 5 个**会话中读过/编辑过的文件（选最近修改的）；超过 5,000 token 的文件只保留路径引用（"Referenced file"）。
- **CLAUDE.md**：项目根 CLAUDE.md 会作为启动内容自动重载；但带 `paths:` frontmatter 的嵌套规则文件是随消息历史一起被摘要的——压缩后**不再保证完整**，官方自己建议"如果规则必须在压缩后存活，把它移到根 CLAUDE.md 或去掉 paths"。
- **Skill**：压缩后重新注入 skill 主体，但大 skill 会被截断（保留文件开头），超过总预算后删最旧的。
- 其余对话内容 → 一条结构化摘要。

### 1.3 三层压缩实现 【第三方源码分析，未直接验证上游闭源代码】
来源：[claude-code-best/claude-code docs/context/compaction.mdx](https://github.com/claude-code-best/claude-code/blob/main/docs/context/compaction.mdx)、[openedclaude/claude-reviews-claude architecture/11-compact-system.md](https://github.com/openedclaude/claude-reviews-claude/blob/main/architecture/11-compact-system.md)

| 层 | 触发 | 是否需要 API |
|---|---|---|
| MicroCompact | 单个工具输出过长，清旧工具输出内容（白名单：Read/Bash/Grep 等结果） | 否 |
| Session Memory Compact | auto-compact（feature flag） | 否 |
| 传统 API 摘要 | 手动 `/compact` 或回退 | 是 |

- 阈值实证（第三方反编译分析）：`getAutoCompactThreshold() = effectiveContextWindow − AUTOCOMPACT_BUFFER_TOKENS`，buffer ≈ **13,000** token；effective window = contextWindow − min(maxOutput, 20,000)。对 200K 模型 ≈ 167K 触发。社区多引述 auto-compact 在 ~92–95% 窗口占用触发（[agentmux SPEC](https://github.com/agentmuxai/agentmux/blob/720177ac129bab25644387d6bb710e61aa122867/docs/specs/SPEC_CONTEXT_COMPACTION_NOTIFICATION_2026_06_20.md) 写 ~95%）。

### 1.4 恢复：`--resume` / `--continue` 与 transcript 【官方文档】
- transcript 是逐会话 JSONL，路径 `~/.claude/projects/<project>/<session>.jsonl`，包含消息、工具调用/结果、system prompt、工具定义和发给模型的请求参数（[Explore the .claude directory](https://code.claude.com/docs/en/claude-directory)）。
- **关键设计：压缩不改写 transcript**。Agent SDK 文档明确"双重写入"架构：subprocess 先把每批转录写到本地磁盘，SDK 再转发给外部 store；`--resume` 恢复的是**完整原始 JSONL**，不是摘要（[session-storage](https://code.claude.com/docs/pt/agent-sdk/session-storage)）。
- CLAUDE.md 是层级文件（企业/用户/项目/目录四级），作为持久指令在每次会话启动注入——这是"跨会话规则层"，与压缩正交。

### 1.5 踩坑 issue（宿主压缩丢信息的实证）【issue 实证】
- [#40352 Compaction race condition](https://github.com/anthropics/claude-code/issues/40352)：压缩时先清空 JSONL 消息内容、压缩 API 调用再失败 → 4300+ 条消息全变空字符串、无摘要替换，~1M token 会话永久丢失。
- [#63187](https://github.com/anthropics/claude-code/issues/63187)：auto-compact 在确认摘要子任务成功**之前**就删除/截断主 session JSONL；摘要 API 失败（如图片尺寸限制）→ 原对话没了，`--resume` 也不可用。
- **教训：即使有完整落盘 transcript，压缩路径仍可能破坏性写坏；且 JSONL 是机器格式，恢复靠宿主，第三方无法保证。**

---

## 2. Codex CLI（OpenAI）

### 2.1 `/compact` 与压缩语义 【官方命令描述 + 社区整理】
来源：[Codex CLI Cheat Sheet（对照官方文档）](https://ai.impaxsys.com/cheatsheets/codex-cli/)、[codex-context-sheriff slash_commands.md](https://github.com/marcohefti/codex-context-sheriff/blob/main/docs/slash_commands.md)、[六种方法综述（数据截至 v0.164.0）](https://news.qiniu.com/archives/1792985246452)

- `/compact`："summarize conversation to prevent hitting the context limit"。执行后：**会话 ID 不变**，历史被折叠成一条摘要，后续消息接在摘要后。**破坏性**——细节不可回溯（原始 transcript 仍在磁盘，但模型侧回不去）。
- `/compact --preview` 先看摘要不落盘；`--compact --apply` 原样应用预览。
- **v0.164.0 起 background compaction 接入 turn 生命周期**，临界点有概率自动触发。
- 压缩失败保护：v0.164.0 修复了"压缩失败后留下残缺摘要"的 bug。

### 2.2 逃离压缩的替代命令（值得注意的设计空间）
- `/fork` 分支保留原始历史；`/worktree` 独立 git worktree 新会话；`/side` 旁白对话；`/new` 干净起点；`/memories` 关键信息跨会话持久化。
- `/resume` 打开旧会话选择器，**原始 transcript 保持完整**。

### 2.3 AGENTS.md 【官方】
- `/init` 生成 AGENTS.md 脚手架，作为仓库级持久指令提交入库——角色等同 Claude Code 的 CLAUDE.md：**规则放文件、跨会话不进压缩**。

### 2.4 踩坑 issue 【issue 实证】
- [openai/codex#29302](https://github.com/openai/codex/issues/29302)：**压缩状态不跨端同步**——Desktop App 里已压缩的长线程在 CLI resume 时，CLI 重新加载原始历史而非最新压缩态；再 `/compact` 直接报 "ran out of room in the model's context window"，陷入"必须压缩才能继续、但压缩本身跑不动"的死锁。
- **教训：压缩态与原始 transcript 双轨并存时，resume 端必须明确"从哪个状态恢复"；否则恢复器选错入口。**

---

## 3. DSH（DeepSeek Harness）【全部为源码实证】

来源：本机 checkout `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/`（asar 解包到 `/tmp/dsh-asar` 后阅读 TS 源码），版本 `@deepseek-ai/dsh-desktop-runtime 0.2.2-rc.3`。

### 3.1 压缩后端分层
- `@deepseek-ai/dsh-compaction`：抽象 `CompactionEngine`（`src/index.ts:136`），触发类型 `CompactionTrigger = 'pressure' | 'context-overflow'`（`src/index.ts:32`）。
  - `compactIfNeeded(agent, trigger, signal)`：自动压缩；pressure 用最近一次 durable routed request 的 token 计量。
  - `compactNow(...)`：手动压缩，先 append 独立 `compaction/start` 事件作为**持久化压缩锁**，直到 `compaction/end`；失败可见地留在日志里。
  - `compactRange(start, end)`：强制压缩指定区间，**要求区间边界 tool-pairing 平衡**（assistant tool call 必须与其结果成对，`toolPairingBalancedBefore/After`）。
- `@deepseek-ai/dsh-compaction-basic`：默认实现（replay-aware）。
  - 默认阈值（`src/config.ts:20-23`）：**`DEFAULT_THRESHOLD_RATIO = 0.8`**（窗口占用 80% 触发，扣除 reserved output 与 headroom），**`DEFAULT_RETAIN_RATIO = 0.16`**（保留最近上下文 ≈ 可用窗口的 16%）；支持按 provider/model 的 exact-target 覆盖表。
  - `compactIfNeeded` 注册三处触发：step 间 pressure、model-switch pressure（换模型压不动会拒绝切换）、request overflow 恢复（`src/index.ts:143-228`）。
- `@deepseek-ai/dsh-compaction-tool-result-pruner`、`dsh-compaction-image-offload`：工具结果修剪 / 图片卸载（MicroCompact 类似物）。

### 3.2 摘要生成（与 Claude Code 最大的差异：前缀缓存复用设计）
来源 `dsh-compaction-basic/src/summarizer.ts`：

- 摘要指令作为**最后一条 user message** 追加在被回放的对话**之后**，而不是独立的 summarizer system prompt——使辅助调用成为上一次路由请求的**真前缀**，provider 的 KV cache 复用不被作废（`summarizer.ts:33-41` 注释明确这一点）。
- 摘要结构是固定的 8 段 Markdown：`Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context`，规则要求保留精确路径/命令/错误串/数值/签名，已有 `<compacted-summary>` 块时合并而非照抄。
- 落成的 checkpoint 用 `<compacted-summary>...</compacted-summary>` 包裹（`summarizer.ts:24-25`），checkpoint 源标记 `kind: 'compact-checkpoint'`（`dsh-compaction/src/checkpoint.ts:19`），替换为**一条 user message**，带 preamble："This is an automatically generated checkpoint…build on it without restating it"。

### 3.3 session transcript 落盘格式与路径 【源码 + 本机实证】
- 后端：`@deepseek-ai/dsh-session-persistence-jsonl`；文件名带代际：`session.jsonl`（gen 0）→ `session.vN.jsonl`（`dsh-session-format/src/filename.ts:16`），磁盘上以 **zstd 压缩**（`session.v4.jsonl.zstd`，`zstd.ts`）。
- 目录布局（`format.ts` `projectKey()`/`projectDir()`）：`<root>/<--项目路径slug-->/<session-uuid>/session.vN.jsonl.zstd`。本机实证 root = **`~/.dsh/sessions/`**，例如：
  `~/.dsh/sessions/--Users-yeager-work-yeager-ldywoker--/session-21eb0890-…/session.v4.jsonl.zstd`
- 事件格式（实测解压）：首行 header `{"type":"session","version":4,"id":…,"cwd":…,"agentPreset":…}`，之后每行一个带 `seq` 的事件（`permission/preset`、`sandbox/mode`、`agent/inbox/spliced`、`turn/start`…）。**追加式事件日志，压缩不删除历史事件**——压缩产物是新的 checkpoint 事件节点，surface 视图把被压缩区间 shadow 掉（`CompactionResult.shadowedSeqs`）。
- `@deepseek-ai/dsh-session-format-v0-to-v1` … `v3-to-v4`：格式代际迁移链，老 transcript 可升级。

### 3.4 DSH 小结
DSH 的设计 = **不可变追加式事件日志（transcript 永不破坏）+ surface 投影层做 shadowing + checkpoint 作为普通事件持久化**。这直接规避了 Claude Code #40352/#63187 那类"压缩写坏 transcript"的故障模式。

---

## 4. Cursor / Windsurf / Cline

### 4.1 Cursor 【官方博客，2026-01】
来源：[Dynamic context discovery](https://cursor.com/en-US/blog/dynamic-context-discovery)

- 方向是"**动态上下文发现**"：减少预注入，让 agent 自己拉取；长轨迹优化手段包括——**过长工具响应转存为文件**（不截断，避免丢信息）、摘要时引用聊天记录、按需加载 MCP 工具、终端会话视为文件。
- 手动压缩命令 `/summarize`（社区口径，[NVIDIA remix docs](https://docs.omniverse.nvidia.com/kit/docs/rtx_remix/1.4.2-1/docs_dev/tools/ai-agents.html) 与多篇社区文档交叉印证）；社区实践推荐 50% 主动压、80% 作为硬保险。压缩是有损摘要，与 Claude Code 同型。【官方对压缩细节的公开文档较少，此节部分依赖社区整理——未验证处已标注】

### 4.2 Windsurf 【官方文档 + 社区分析】
来源：[Cascade Memories](https://docs.windsurf.com/ro/plugins/cascade/memories)、[第三方竞品研究（含官方文档转述）](https://github.com/NinjaSln-labs/dsh-plugins/blob/main/dsh-context-compass/docs/RESEARCH-COMPETITORS.md)

- 走 **RAG 检索式 Context Engine**：每次交互按管线组装——rules（global→workspace）→ memories → 编辑器活跃状态 → @ 命令 → flow context（近期编辑/终端/导航）→ 按模型窗口裁剪。
- 跨会话靠 **Memories（自动生成）+ Rules（手写，global/workspace/system 三级）**，本质是"持久化笔记"而非压缩。
- 无窗口占用百分比指示器（长期被用户抱怨）；曾出现 v0.112 死亡螺旋故障模式：高 reasoning effort + 压缩反馈循环 → 反复压到剩 12% → 无限循环烧 token。【社区实证】

### 4.3 Cline Memory Bank 【官方文档】
来源：[Memory Bank](https://docs.cline.bot/best-practices/memory-bank)

- 纯**约定式方案**：项目里放 `memory-bank/` 六个核心 Markdown 文件——`projectbrief.md`（奠基）、`productContext.md`（为什么存在）、`activeContext.md`（当前工作焦点）、`systemPatterns.md`（架构）、`techContext.md`（技术栈）、`progress.md`（里程碑，**每次会话后更新**）；可加可选上下文文件。
- 通过 `.clinerules/memory-bank.md` 规则强制：**每个任务开始必须全量读所有 memory bank 文件**；"clear context 后完全依赖 memory bank 继续"。
- 实现成本极低（就是提示词纪律 + md 文件），但每次全量读所有文件有 token 成本，且靠模型自觉维护，无结构化校验。

---

## 5. 值得抄 / 不值得抄 / 对我们意味着什么

### 值得抄
1. **DSH 的"事件日志不可变 + 压缩只是投影"**：transcript 永不破坏性改写，压缩产物是追加的 checkpoint 事件。sedimem 的记忆库本来就是 append-only + supersede——与这个模型天然同构。
2. **DSH 的 8 段 checkpoint 结构**（intent/concepts/files/errorsAndFixes/pendingJobs/currentState/nextSteps/criticalContext）与 sedimem 会话临时库的 checkpoint 段完全同源；DSH 还要求"合并旧 checkpoint 而非照抄"，值得写进 sedimem 的 close/压缩语义。
3. **Claude Code "压缩后保留清单"的显式化**：官方明确列出哪些东西压缩后自动重载（CLAUDE.md、skill、5 个最近文件）。sedimem 应该给任务库同样明确的"close 时什么晋升/什么 tombstone/什么只留在交接文档"，现在只有 decision/gotcha 晋升一条规则，粒度不够。
4. **Codex 的 `/memories` + AGENTS.md 分层**：易变任务态进 memories，稳定规则进文件。对应 sedimem：任务库（易变 state）与项目主库（稳定 fact/decision）分库是对的。
5. **Cline 的 `activeContext.md` + `progress.md`**：两个文件分别承载"当前焦点"和"里程碑"。sedimem 的 `state` kind 记录可以借鉴这种"一个当前态 + 一个进度账"的双轨。
6. **Codex #29302 的教训反向利用**：恢复端必须明确"从原始 transcript 还是压缩态恢复"。sedimem 任务库恢复时应显式声明基准（checkpoint at seq N），避免新旧混合。

### 不值得抄
1. **Claude Code 的"压缩时先清 transcript 再调摘要 API"路径**：两个 issue 证明这是数据丢失源头。任何"先删后写"都不要。
2. **Windsurf 的纯 RAG 检索式记忆**：无确定性、无可见信号，用户抱怨"何时忘了什么都不知道"。sedimem 的结构化记录（可检索、有 supersede 链）更可审计。
3. **Cline 每次"全量读所有 memory bank 文件"**：token 成本随文件数线性涨。sedimem 按 BM25 检索按需取，方向更对。
4. **Cursor 把长工具输出转存文件**作为宿主内建：这是宿主职责，记忆库不必做。

### 对 sedimem 任务库的直接含义：宿主压缩会不会丢、丢哪些、我们补什么

**宿主压缩必然有损，且丢的恰好是跨会话开发最需要的东西：**

| 宿主压缩丢什么 | 证据 | sedimem 能补什么 |
|---|---|---|
| 对话细节、被否决的方案、试错过程 | 所有宿主的压缩都是"摘要替换历史"（Claude `/compact`、Codex `/compact` 破坏性折叠） | 任务库里以 `state`/`gotcha` 记录试错与死胡同；transcript 本体留在宿主落盘路径，任务库记**指针**而非复制 |
| 用户原话/纠正（"不是我说的这样"） | 摘要模型自行取舍；Claude Code 官方规则只强调保留路径/数值，用户纠正靠运气 | `decision` 记录带 user quote + session id，close 时晋升主库——这正是现有晋升规则的扩展点 |
| 跨会话的"当前做到哪、下一步" | 宿主 checkpoint 的 Current Work/Next Step 只在本会话 surface 里，resume 同一会话才可见；**新会话拿不到** | 这是 sedimem 任务库的核心价值：close 时把 pendingJobs/nextSteps 写进交接文档 + 主库 decision/gotcha |
| 文件级上下文（读过的文件为什么读） | Claude Code 压缩后只重读 5 个最近文件；>5k token 的只剩路径 | 记录 `files` 段（path + 为什么相关），比宿主"猜 5 个最近文件"更准 |
| 多宿主/多端一致性 | Codex #29302：压缩态不跨 CLI/App 同步 | sedimem 是宿主外独立存储，天然跨宿主——但**必须自己维护 checkpoint 基准**（恢复时声明从哪条记录起） |

**具体设计建议（供维护者改设计）：**
1. `session.hintTokens=30000` 目前无消费者。参照 DSH（0.8/0.16 可配）与 Claude Code（`/autocompact` 用户可调），把它做成**有真实语义的参数**：任务库达到约 N token 提示"该 checkpoint 了"，或者干脆删掉，别留死配置。
2. close 晋升规则（只晋 decision/gotcha）过窄：DSH 的 8 段 checkpoint 里 `pendingJobs/nextSteps` 才是跨会话开发最关键的，建议 close 时把它们以 `state` kind 晋升或写入交接文档头部，而非随临时库 tombstone。
3. 恢复协议：给任务库 checkpoint 加单调序号/时间戳，恢复时明确基准，避免 Codex #29302 式"新旧状态混装"。
4. 不做自动压缩：各家踩坑（Claude #40352/#63187、Windsurf 死亡螺旋）都发生在自动触发路径上；sedimem 的"完全手动 + 只提示"纪律反而是踩坑最少的位置——保持，但把"提示"真正实现出来。

---

## 附：主要来源清单
- Claude Code 官方：context-window（zh-CN/en）、claude-directory、agent-sdk/session-storage
- Claude Code issue：anthropics/claude-code#40352、#63187
- 第三方 Claude Code 源码分析：claude-code-best/claude-code、openedclaude/claude-reviews-claude（未验证上游闭源代码，标注为分析）
- Codex：官方命令描述（cheatsheet 对照）、openai/codex#29302、v0.164.0 综述
- DSH：本机 asar 源码 `dsh-compaction*`、`dsh-session-persistence-jsonl`、`dsh-session-format`、`dsh-compaction-basic/src/{config,summarizer,types}.ts`；本机 `~/.dsh/sessions/` 实测
- Cursor：官方博客 Dynamic context discovery
- Windsurf：官方 Cascade Memories 文档 + 第三方管线转述
- Cline：官方 Memory Bank 文档（docs.cline.bot）
