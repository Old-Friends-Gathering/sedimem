# 记忆条目如何做到「明确、简要」：调研与方案（2026-11）

> 用户原话：「记忆如何总结的更加明确，每个记忆点总结的要明确简要，而不是冗杂的一长段，这样第一就是负担小，第二就是 ai 读取更加快速明确」。
> 本文回答四件事：① 现成系统的「原子事实 / 短条目」怎么做；② 「一条记忆一个事实」怎么落地到 schema/写入/展示/读取四层；③ 有没有可机械检验的简洁度指标；④ sedimem 的三个候选方案与推荐。
> 口径：只写本次真实打开核对过的源码 / README / 论文 / 本仓代码；二手结论（本仓既有调研文档）单独标注；拿不到的进「未验证清单」。

## 1. 现成系统怎么做「原子事实」与「短条目」

### 1.1 Mem0（OSS v3，2026-11 打开的 main 分支）

- **抽取形状**：一次 LLM 调用输出 `{"memory": [{"id", "text", "attributed_to", "linked_memory_ids"?}]}`，**只做 ADD**（`ADDITIVE_EXTRACTION_PROMPT`，`mem0/configs/prompts.py`）。
- **单条长度有硬数字**：输出格式规范原文 —— `text (string, required): A contextually rich, self-contained factual statement (**15-80 words**)`。这是目前最明确的「生产 prompt 级长度上限」：**下限 15 词防碎片、上限 80 词防长段**。
- **一条一个事实**：prompt 明文 "Extract every piece of memorable information as a separate memory object"，并用 12 个 few-shot 示例演示「一段话拆 N 条」（如 5 条消息拆 5 条记忆；会议例子拆 "Had a meeting with John at 3pm" + "Discussed the new project" 两条）。
- **防泛化规则**（与「明确」直接相关）：`NEVER generalize "Gamecube" to "gaming console"…every concrete noun, number, and descriptor in the source should survive`（注意：这句同时出现在 Mem0 的 ADDITIVE prompt 与 Graphiti 的 edge prompt 里，两家措辞几乎相同）。
- **输入侧截断**：`PAST_MESSAGE_TRUNCATION_LIMIT = 300` 字符/条历史消息。
- 旧四操作 prompt（ADD/UPDATE/DELETE/NONE）仍在同文件但默认路径不用（与本仓 `agent-memory-projects-survey-2026-11.md` 的结论一致）。

### 1.2 Zep / Graphiti（episode → fact）

- 模型：`episodes`（原始输入，保留 provenance）→ `entities` + `edges/facts`（带 valid_at/invalid_at 双时间窗）→ `communities`。
- **一条 fact = 一条边**，源码字段（`graphiti_core/prompts/extract_edges.py` 的 `Edge` 模型）：`source_entity_name`、`target_entity_name`、`relation_type`（SCREAMING_SNAKE_CASE）、`fact`（自然语言一句）、`valid_at`、`invalid_at`、`episode_indices[]`（溯源）。
- **原子性规则**（抽取 prompt 明文）：① 每条 fact 必须连接**两个不同实体**；② "Do not emit semantically redundant facts"；③ 后续 episode 增加细节时提取**更详细版本作为新 fact**，同精度的才算重复；④ fact 文本必须保留专有名词/数量/颜色等具体值，禁止泛化。
- 无数字长度上限；原子性靠「双实体三元组」结构约束，而非字符数。

### 1.3 A-MEM（agiresearch/A-mem，MIT）

- note 字段（`agentic_memory/memory_system.py` 的 `AgenticMemory` 类，本次核实）：`content`、`id`、`keywords[]`（LLM 抽取）、`context`（LLM 生成，默认 "General"）、`links`、`retrieval_count`、`timestamp/last_accessed`、`evolution_history[]`、`category`、`tags[]`。
- 「简要」手段：content 不限长，但**检索与演化走 keywords + context 摘要**，正文只在按 id 读取时出现。
- 已知代价（本仓 `layered-memory-2026.md` 结论，本次未重开 issue 核实）：每次 add 让 LLM 分析历史并回写链接，写入成本随库大小无上界增长。

### 1.4 Mem0g（图变体，论文 arXiv:2504.19413）

- 摘要核实：在 Mem0 之上加「graph-based memory representation 捕获会话元素间的关系结构」，LOCOMO 上比基础版高约 2%，比全上下文省 >90% token、p95 延迟低 91%。
- 具体 schema（实体/关系字段名）在正文，本次只核了摘要与 OSS 现状（v3 OSS 已移除图记忆，`graph_memory.py` 404，见本仓 survey）→ **三元组形状参照 Graphiti 即可，Mem0g 自身字段未验证**。

### 1.5 mcp-memory-service（doobidoo，Apache-2.0）

- README 核实：「从 observation 派生**带置信度的 belief**；启发式矛盾检测把旧记忆标 superseded，默认检索隐藏、可显式查」。即存储原子单位是 observation（短观察句），belief 是派生聚合层。
- 另有 autonomous consolidation（聚类 + 压缩 + 受控遗忘）、`get_bootstrap_profile` 在 **token 预算内**组装新 agent 行为上下文。
- belief 的具体字段/长度上限在 `docs/guides/memory-consolidation-guide.md`，本次未打开 → 标未验证。

### 1.6 basic-memory（AGPL-3.0）

- README 核实的 note 结构：Markdown 文件 = Entity；frontmatter `{title, type: note, permalink, tags}`；正文 = `## Observations`（**每行一条事实**：`- [类别] 事实 #tag (context)`，类别如 method/technique/principle/fact/resource/question）+ `## Relations`（`- relates_to [[另一笔记]]`）。
- **「简要」的核心机制就是 Observations 一行一事实**：单行无硬字符上限（示例行都 <80 字符），粒度由行拆分而非长度约束保证。
- 机制与 sedimem 重合度高且 AGPL，只借鉴粒度模型不借鉴实现（本仓 layered-memory 结论一致）。

### 1.7 读取侧参照（按需展开）

- **claude-mem**：README 核实「会话以 compact index 开场，分层注入，agent 只在需要时打开全文」；搜索三步 `index → timeline → details`；docs 有专页 "Progressive Disclosure"。每层具体 token 数（50–100 / 500–1000）出自本仓 `memory-ecosystem-2026.md`（2026-11-02 核实），本次 docs 页面只拿到目录 → 数字标二手。
- **dsh-auto-memory（Aik358）**：README 本次核实，数字齐全：Tier-0 目录 ≤800 tokens（一条一行：标题·结论·层·状态·日期，~30 条）；Tier-1 digest **每条 ≤140 字符**、top 8；Tier-2 原文 chunk ≤2400 字符/次；单轮注入总预算 `injectBudgetChars` 默认 8000。实测依据：原生语料源文本 **p90 = 1196 字符、max 1692**；project 层 77 chunks 曾吃光 800-token 预算 → 加每层硬配额。

## 2. 「一条记忆一个事实」的工程约束怎么落地

### 2.1 schema 层

- **结构化强制**：Graphiti 的启示——原子性最稳的保证是**结构**（source+relation+target 三元组天然装不下两个事实），比字符数限制更根本。sedimem 已有 subject/predicate/value 三元组 + text 冗余字段，问题在于 `subject/predicate` 允许缺省回落 `'text'/'text'`（`core/record.js` `createRecord`），unstructured 记录没有任何原子性约束。
- **数字上限**（业界实测组合）：正文单事实 15–80 词（Mem0）≈ 中英文混排约 **≤160 字符**可用作结构化 value 上限；一行摘要 ≤140 字符（dsh-auto-memory Tier-1）；标题 ≤40 字（sedimem 已有，`MAX_TITLE=40`）。源文本 p90 ~1200 字符说明「长记忆」存在但应属例外。
- **多事实禁入**：basic-memory 用「一行一 Observation」承载；Mem0/Graphiti 靠 prompt 拆分。schema 层可加软校验（见 2.2），但**拒写硬门槛只放在长度上，多事实放写入层提示**——纯 schema 无法可靠判定「几个事实」。

### 2.2 写入层

- **超长：拒写还是截断？** sedimem 现状是**静默截断**（`text > 4000` 截断 + 打 `truncated` tag，`core/record.js:56`）。业界没有一家对用户输入静默截断后入库：Mem0/Graphiti 的抽取层天然控制长度（LLM 输出 15–80 词）；dsh-auto-memory 的 1196/1692 是语料实测而非门限。**建议改为「警告 + 要求拆分」而非静默截断**：截断破坏事实完整性，比长更糟。
- **自动切分**：Mem0 的做法是在**抽取 prompt 内拆**（一次调用产多条，每条自包含、带上下文），不是写入后机械切——机械按句切会丢指代（「他」「该方案」）。若 sedimem 加切分，应发生在 capture/extract 层（有原文上下文时），且每条切分产物必须自包含（Mem0 prompt："self-contained, contextually rich"）。
- **去重衔接**：切分会放大重复——Mem0 用 "Recently Extracted Memories(≤20)" 做抽取期去重；Graphiti 用「同精度才算 duplicate，更详细版本是新 fact」。sedimem 的 write-gate（contentHash + 近重复 0.85）在切分后每条独立走判定即可，机制已备。

### 2.3 展示层

- **brief（≤80 行）**：已是聚合视图；行内文本应取 title/value 截断而非全量 text。
- **Tier-0（≤800 字符）**：sedimem 已实现（`render/tier0.js`，`DEFAULT_TIER0_CHARS=800`，一条一行 + 完整 ULID 证据链 + 投毒行跳过）——与 dsh-auto-memory 同构。
- **MCP 返回 / UI 卡片**：search 结果默认回 `title + value(截断) + id`，全文仅 memory_get 按 id 取。UI 卡片同规则：卡片只展示 title + 一行 value，点开看全文。

### 2.4 读取层（渐进披露）

成熟范式三家一致：**默认注入一行索引，按 id 下钻**。claude-mem `index→timeline→details`；dsh-auto-memory `Tier-0 目录 → Tier-1 digest(140 字) → Tier-2 原文`；sedimem `tier0(800 字符) → brief(80 行) → memory_get(全文)`。关键是**每一级都带 recordId**（证据链），且层级间跨度不要太大——dsh-auto-memory 实测 140 字 digest → 1200 字 chunk 的跨度可接受，删掉了 2k 中间层。

## 3. 可量化的「简洁度」指标

| 指标 | 机械定义 | 参考阈值 / 对标 |
|---|---|---|
| 平均正文长度 | `mean(len(text))`、`p90(len(text))` | 结构化 value ≤160 字符（=80 词英文的上限折算）；dsh-auto-memory 语料 p90 1196 / max 1692（「长记忆」的实证分布） |
| 单条事实数 | 每条 text 的分句数（按 `。；;.` 切）或 LLM 判定的事实计数 | 目标 =1；>2 的记录占比 <10%（自定，无外部对标——**各家都只在 prompt 里要求、无线上统计数字，未验证**） |
| title 覆盖率与长度 | 有 title 的记录比例；`mean(len(title))` | sedimem 已有 MAX_TITLE=40；目标覆盖率 ≥90%（无外部对标） |
| 注入 token 数 | brief / tier0 输出的字符数（÷≈2 折 token） | tier0 ≤800 字符（已有）；brief ≤80 行（已有）；dsh-auto-memory 单轮 `injectBudgetChars` 8000 |
| 检索返回 token 数 | search 默认返回（截断后）字符数 / 命中数 | claude-mem 自称三级披露省 ~10x（二手）；Mem0 论文：比 full-context 省 >90% token、p95 -91%（LOCOMO，论文自报） |
| 信息密度 | 检索命中并注入的事实数 / 注入 token 数 | 可直接算，但无生产对标；建议只做**自身前后对比**基线 |
| 冗余率 | superseded+duplicate 占全库比例 | sedimem stats 已有 dupRatio；写侧收紧后应下降 |

可机械检验的最小集：`p90(len(text))`、`facts/record`、`tier0 字符数`、`search 返回字符数/命中数`。前两个测「写得短」，后两个测「读得省」。LoCoMo-Refined 提醒：端到端分数先校准 judge（人机一致率 <80% 不采信），简洁度指标只测形状、不测质量，质量另走 eval。

## 4. 对 sedimem 的建议（三方案）

现状（源码核实）：`MAX_TEXT=4000` 静默截断、title 可选（≤40）、subject/predicate 可缺省成 `'text'/'text'`、value 无独立上限、Tier-0/brief/memory_get 三级披露已就位。**读侧已经「简要」，短板全在写侧**：一条记录可以塞 4000 字符的长段 + 多个事实，且截断是静默的。

### 方案 A：只改写入契约（推荐）

- 改动面：`config/policy.json` 加 `maxValueChars`（建议 300）与 `warnTextChars`（建议 600，超出打 `long-form` tag 而非拒绝）；MCP `memory_write` 工具描述改写——「一条记忆一个事实；多事实请拆多次调用；value ≤300 字；title 必填（结构化记录）」；超限返回**明确错误**（E_TEXT_TOO_LONG + 提示拆分）替代静默截断（保留 4000 硬顶防滥用）。write-gate 加软信号：unstructured 且 text 分句 >3 时在返回 reason 里提示「疑似多事实」。
- 风险：低。不改存储格式、不迁移、真相层兼容；旧客户端只是多收到错误提示。
- 可测收益：`p90(len(text))` 下降；`noop_duplicate` 率不升（拆细后 contentHash 粒度变细，理论上重复检测更准）；search 默认返回字符数下降。
- 测试量：小——record 校验 ~10 例、write-gate ~10 例、MCP 工具描述快照 1 例，约 0.5 天。
- 为什么推荐：与业界共识一致（Mem0 15–80 词、basic-memory 一行一事实都是**写侧定粒度**），且 sedimem 读侧（tier0/brief/get）已经把「读得省」解决；只补写侧就把闭环补齐。A-MEM/Graphiti 的教训也说明：与其让长段入库后再靠演化/图来整理，不如入口就短。

### 方案 B：契约 + 自动切分 + 回填迁移

- 改动面：A 的全部 + capture/extract 层加 LLM 切分（一次原文 → N 条自包含记录，参照 Mem0 抽取 prompt 的 few-shot 形状）+ 存量长记录回填脚本（`cli/backfill.js` 扩展）。
- 风险：中高。① 切分需要 LLM（sedimem 零运行时依赖、离线优先，违背架构约束）；② 回填改写真相层违反 append-only 精神（只能追加新记录 + supersede 旧记录，迁移语义要重新裁决）；③ 切分错误比长记录更难发现（事实断裂、指代丢失）。
- 可测收益：`facts/record`→1；但收益依赖 LLM 质量，不可确定性验收。
- 测试量：大——切分 eval 集 + 迁移幂等性 + 双写对照，≥3 天。Graphiti/A-MEM 的抽取每条都过 LLM，成本模型与 sedimem 不匹配。
- 结论：**不推荐现在做**；若未来 capture 层本来就要接 LLM（extract.js 已有雏形），可顺势升级。

### 方案 C：加「摘要层」派生视图

- 改动面：每条记录派生一行 digest（≤140 字符）存 `views/`，search/brief 默认用 digest，原文按 id 取；长 text 不再是问题因为默认不展示。
- 风险：中。digest 生成若用规则截断则丢失语义（截断点可能正好切断事实）；若用 LLM 则同 B 的依赖问题；views 可重建所以不违反真相层，但 `views/l2.js`、`l3.js` 已经在做同方向的聚合，再加一层 digest 边际收益递减。
- 可测收益：注入字符数下降——**但 tier0（800 字符、一条一行）已经在注入侧达到同样效果**。
- 测试量：中——digest 生成 + 重建一致性 ~1 天。
- 结论：**收益与现有 tier0 重叠**，仅在「希望 search 结果比 title+value 截断更语义化」时才有增量。

**推荐：A**。理由浓缩：短板定位在写侧（读侧三级披露已就位且与 dsh-auto-memory/claude-mem 同构）；A 用纯规则、零依赖、零迁移解决「写得短、写得单」，B 引入 LLM 依赖与迁移语义风险，C 与既有 tier0 重复。A 落地后用第 3 节指标建基线，若 `facts/record` 仍高再考虑 B。

## 参考链接

- Mem0 prompts（本次打开，main 分支）：https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py（`ADDITIVE_EXTRACTION_PROMPT`、15-80 词规范、`PAST_MESSAGE_TRUNCATION_LIMIT=300`）
- Mem0 论文：https://arxiv.org/abs/2504.19413（LOCOMO、>90% token 节省、91% p95 降低）
- Graphiti edge 抽取（本次打开）：https://github.com/getzep/graphiti/blob/main/graphiti_core/prompts/extract_edges.py（Edge 模型字段、防泛化/去重规则）
- A-MEM（本次打开）：https://github.com/agiresearch/A-mem（README + `agentic_memory/memory_system.py` 的 AgenticMemory 字段）；论文 arXiv:2502.12110
- mcp-memory-service：https://github.com/doobidoo/mcp-memory-service（README：beliefs/置信度/superseded/consolidation/bootstrap profile）
- basic-memory：https://github.com/basicmachines-co/basic-memory（README：frontmatter + Observations 一行一事实 + Relations）
- claude-mem：https://github.com/thedotmack/claude-mem（README：compact index、index→timeline→details）；https://docs.claude-mem.ai/progressive-disclosure（本次仅取得目录页）
- dsh-auto-memory：https://github.com/Aik358/dsh-auto-memory（README：Tier-0 ≤800 tokens、Tier-1 140 字符×8、Tier-2 ≤2400 字符、injectBudgetChars 8000、语料 p90 1196）
- 本仓二手调研（前次核实，本文引用处已标注）：`docs/research/agent-memory-projects-survey-2026-11.md`、`docs/research/memory-ecosystem-2026.md`、`docs/research/layered-memory-2026.md`
- sedimem 源码（本次核实）：`versions/v0.5/src/core/record.js`（MAX_TEXT=4000、MAX_TITLE=40、静默截断）、`versions/v0.5/src/render/tier0.js`（DEFAULT_TIER0_CHARS=800）、`versions/v0.5/src/hygiene/write-gate.js`（近重复 0.85、supersede/disputed）

## 未验证清单

- Mem0g 的实体/关系具体字段与长度规则：只核了论文摘要，正文 schema 未打开。
- mcp-memory-service belief 的字段定义与置信度算法：在 `docs/guides/memory-consolidation-guide.md`，未打开。
- claude-mem 三级披露的每层 token 数（50–100 / 500–1000）：出自本仓 2026-11-02 调研记录，本次 docs 页面只拿到导航目录，未重核正文。
- 「单条事实数」「信息密度」的生产环境阈值：各家 prompt 有要求、均未见线上统计数字，本文阈值为自定建议。
- Mem0 论文的 90%/91% 数字：论文自报（LOCOMO 基准），无第三方复现。
- A-MEM 写入成本随库增长的 issue 细节：引自本仓 layered-memory 调研，未重开上游 issue。
