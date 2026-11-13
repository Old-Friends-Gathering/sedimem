# Session 级临时记忆 vs 长期记忆：读取优先级与收尾交接调研（2026-11）

sedimem「开发期临时记忆库（session:<id>）」设计输入。标注：✅=我打开核过原文；📖=据搜索结果/README 描述（引文详实但未逐页打开）。

## 1. 读取优先级：常驻层 / 按需层的通用切法

- **Letta (MemGPT)** 📖 https://docs.letta.com/v1-sdk/memory/context-hierarchy/
  - **core memory blocks**：常驻、每 turn 注入、agent 可用 `memory_rethink/replace/insert` 自编辑；单块建议 <50k 字符（实操 persona/human 常用 limit 2000–5000，见 https://docs.letta.com/v1-sdk/memory/memory-blocks/ 的 `limit: 5000` 示例）、<20 块/agent（另一份 letta-ai/skills 文档建议 5–15 块最稳）📖 https://github.com/letta-ai/skills/blob/main/letta/letta-api-client/memory-architecture.md。
  - **archival memory**：不驻留，`archival_memory_search` 按语义检索，单条约 300 token 起。分工结论：块里放「身份/当前任务态/高频工作知识」三类；其余全进 archival。
  - 衍生模式（oh-my-hermes 对 Letta 的复述）：块=「label + 字符上限 + 渲染时显示填充率」；system tier 每 turn 渲染、reference tier 只列 label 被问到才读 📖 https://github.com/rlaope/oh-my-hermes/blob/ac0b5b5e/src/plugin_bundle/omh/memory_blocks.py。这正是「常驻层 / 按需层」的通用切法：**常驻层有硬 char 预算并显示水位，按需层无限但必须检索**。
- **Zep/Graphiti** 📖 https://help.getzep.com/v2/sessions ：session 只是消息序列；知识统一进 **user/group 级图谱**，`get session memory` 返回的不是"本 session 的记忆"，而是**与该 session 最相关的 user 级记忆**（相关性聚合，不按 session 隔离）。group = 跨用户共享命名空间。即：**会话是数据入口，不是记忆的存储边界**——与 sedimem「session 分库」相反的设计选择，值得对照。
- **Claude Code** ✅ https://code.claude.com/docs/en/memory ：CLAUDE.md 按目录树**串联**（root→cwd 顺序、越近 cwd 越后读=越近越"最后读到"；CLAUDE.local.md 同级追加在后面），**全部常驻注入、不覆盖**；auto memory（`~/.claude/CLAUDE.md`，`#` 快捷写入）也是常驻。无自动按需层（靠 `/memory` 与用户手工）。
- **Cline memory-bank** ✅ https://docs.cline.bot/best-practices/memory-bank ：固定 6 文件。**activeContext.md（当前工作焦点）+ progress.md（状态）= 战役层**；**projectbrief/systemPatterns/techContext/productContext = 长期约定层**。加载机制：靠 rules 指令要求 Cline 每次开工先读全部 memory-bank 文件（常驻、全读、无预算控制——这是它被诟病之处）。
- **通用归纳**：
  - 常驻层预算参考值：Letta 单块 2k–5k char、总量 ≤20 块；Letta 官方上限 50k char/块。落到 sedimem：**临时库常驻 checkpoint（8 段 state）总预算 ≤4k–8k char，仅 3 类内容：任务目标/当前进度/关键约束**。
  - 按需层：decision/gotcha 走 memory_search，不常驻。

## 2. 冲突与优先级（长期约定 vs 当前状态不一致时）

1. **CLAUDE.md 目录树串联**（✅）：不裁决，全注入，靠「越靠近 cwd 越后读」的顺序让局部约定在注意力上占优。模型自行判断。
2. **Letta 块 label 分区**（📖）：human/persona/自定义块各自独立预算，物理上不允许"约定"和"状态"挤进同一块互相覆盖；冲突留给模型。块有 read_only 标志，可把长期约定设为只读、状态块可写——**写权限分层是它真正的冲突机制**。
3. **Zep/Graphiti 双时标**（📖 https://github.com/AviAvni/database-learning-path/.../reading-zep-graphiti.md ）：每条 fact 边带 valid_at/invalid_at + created_at（bi-temporal），新事实不覆盖旧事实而是**失效旧边**，查询时可按时间点回放；且有 provenance（episode 节点原文可溯）。检索路径对"更新型问题"仍弱于全上下文（Zep 论文自认）。
4. 结论：成熟系统几乎不做语义合并，靠 **(a) 物理分区 + (b) 写权限分层 + (c) 时间戳/provenance + 模型裁决**。sedimem 应给临时库条目带 `session:<id>` provenance + created_at，读取时按"临时库更新 > 长期库"的显式顺序规则声明。

## 3. 继承（长期库 → 当前会话注入约定/习惯）

- **拷贝派**：Cline memory-bank（✅）——长期文件物理拷进每个项目仓；Claude Code CLAUDE.md（✅）——按目录层级拷贝注入。缺点：**多份拷贝漂移**（airulegen 这类工具的存在本身就是漂移证据 📖 https://github.com/deepdevy/airules ）。
- **引用派**：Letta shared blocks——多 agent 挂同一 block id，一改全改（📖 docs.letta.com blocks API，block 可脱离 agent 单独创建再 attach）。缺点：多一次读取、跨会话要管理 attach。
- **查询派**：Zep——不注入，每次 `memory.get` 按当前 session 相关性查 user 图谱（📖 help.getzep.com）。缺点：占检索预算、可能漏（相关性召回问题）。
- 落到 sedimem：**常驻层用"拷贝快照 + 主库条目 id 引用"双写来源字段**（快照 ≤1k char 的项目约定摘要常驻；正文用 id 指回 `repo:<name>` 主库，需要时 memory_get 展开），漂移由"关闭临时库时不回写主库约定"避免。

## 4. 收尾与交接文档

- **Claude Code /compact**（📖）：压缩写成摘要续在上下文里，`--continue/--resume` 重载整个会话；已知痛点：`--continue` 重新载入全部对话导致 token 膨胀（claude-handoff README 明说 📖 https://github.com/andresleecom/claude-handoff ）。
- **claude-handoff**（📖）：每 session 蒸馏 `HANDOFF.md`（**decisions / dead ends（已排除的死路）/ next steps** 三段），resume 时自动重注入。死路段是关键创新——防重走老路。
- **claudetto Handoff wiki**（📖 https://github.com/xsyetopz/claudetto/wiki/Handoff ）：handoff = 短笔记（任务/已完成步骤/下一步）+ `/clear` + 重启；hook 无模型调用直接写文件。
- **Aider**（📖 GitHub issue #2219 / deja-vu docs）：`.aider.chat.history.md` append-only，summarizer 把旧消息压成 summary 消息留在上下文；痛点：历史文件巨大难复用。
- **工程惯例**：handoff doc / runbook / ADR。ADR（Nygard 模板：Context/Decision/Status/Consequences）对应长期库 decision；handoff doc 对应临时库 checkpoint。放哪：**交接文档放仓库内（可 review、可 grep），长期结论晋升主库**。
- 建议段结构（综合）：目标与范围 / 已完成+证据链接 / 未完成 next steps / decisions / dead ends / 环境与恢复命令（怎么再跑起来）。

## 5. 自动化开关

- Letta core blocks：默认常在（agent 创建即挂），archival 默认可用——**常驻层默认开**。
- Zep session：消息一进来就自动进图谱，无显式"开"；无自动 TTL（按查询时间过滤）——**写入自动、过期靠查询侧**。
- Claude Code CLAUDE.md：默认自动加载；auto memory 需 opt-in。/compact 自动触发于上下文将满。
- claudetto：handoff 由「session 结束」这一显式事件触发；claude-handoff 由 hook 触发。
- 共性：**开=事件驱动自动（首个压缩事件/首个任务指令），关=显式收尾动作 + 软过期（不再被查询即沉底）**。几乎没有系统做硬 TTL 删除；Zep 用 invalid_at 软失效。落到 sedimem：临时库在**首个 compaction/summary 事件**时自动创建；关闭=用户显式 `session close`（或任务完成检测：state.checkpoint 的 next_steps 为空）；30 天未更新标 `stale` 但不物理删（append-only 真相层友好）。

## 6. 反模式与规避

- **双写真相分裂**：Cline memory-bank 与 .cursorrules/.clinerules 并存、airulegen 一次生成 11 份规则文件（📖）——同一约定 N 份拷贝必然漂移。规避：临时库**只写战役态，不复制主库约定正文**；约定仅存 id 引用+短快照。
- **临时库污染长期库**：Zep 论文承认 knowledge-update 场景图谱检索劣于全上下文（📖 HF 论文笔记）——未消化的临时事实直接进长期层会放大噪声。规避：关闭临时库时**逐条人审或按 kind 白名单晋升**（只升 decision/gotcha，不升 state）。
- **两边都注入导致自相矛盾**：Claude Code 多级 CLAUDE.md 全串联、无裁决，靠位置顺序（✅）——文件多时确有冲突困惑（社区大量"CLAUDE.md 太长/矛盾"讨论）。规避：sedimem 读取顺序显式化——注入时固定「主库约定快照在前、临时库 checkpoint 在后」，并在 prompt 里声明"临时库时间戳更新，冲突时以临时库为准"。
- **交接文档腐烂**：claude-handoff 的问题描述本身就是"没人维护就过期"；MEMORY/HOARD 类系统用 **TTL + ts 字段自动过期**（📖 skillhub HOARD：每条带 ts/ttl，写侧 agent-only 写门禁防工具污染）。规避：HANDOFF.md 带 generated_at + git commit hash，重新生成而非手工维护；过期交接文档在下次 session 开启时被新 checkpoint 替代。

## 对 sedimem 的 6 条具体建议（对上用户 6 问）

1. **开关**：开——监听 DSH `compaction/summary` 事件，首次触发即自动建 `session:<id>`（id 可用 `战役slug+日期`）；关——显式 `session close` 命令 + 软过期（30 天无更新标 stale，不物理删）。半自动：开自动、关手动为主。
2. **避免读冗长上下文**：能。常驻注入临时库的 1 条 state（8 段 checkpoint，≤8k char）+ 主库约定快照（≤1k char），换 session 开发时读这个而不是上次全量会话；decision/gotcha 按需 memory_search。等价于 Letta「块常驻 + archival 检索」结构。
3. **开发完成后关闭**：支持。close = 冻结写入 + 触发晋升流程（见第 6 条）+ 产出 HANDOFF.md；之后该库只读。
4. **与记忆中心分库的关系**：不矛盾，定义读取顺序：**临时库（活跃时）优先且常驻；主库常驻的只有约定快照 + 按需检索**。给临时库条目带 `scope: session:<id>` provenance；冲突规则显式声明「临时库时间戳新者胜」。绝不把主库 decision 拷贝进临时库——只放 id 引用。
5. **长期库注入习惯/约定**：建临时库时执行一次「继承查询」：从 `repo:<name>` 拉 kind=decision/pref 的项目约定 top-N，拷 ≤1k char 快照进临时库 state 的 `conventions` 段，每条附主库 id。漂移由单向流（主库→临时库，永不回写约定）避免。
6. **收尾晋升 + 交接文档**：close 时按 kind 白名单晋升（decision/gotcha 可升主库，state 不升，逐条或抽查人审），并从 state 自动生成 `docs/handoffs/<session-id>.md`（放仓库，git-ignored 亦可但建议入库）：目标/已完成+证据/next steps/decisions/dead ends/恢复命令 六段 + generated_at + commit hash。下一个 agent 通过主库一条 state 记录指向该文件路径找到它。

## 未验证清单

- Letta 官方「50k char/块、20 块」上限与实操 2k–5k 的差距（两份来源数值不一致，未逐一核官方页面全文）。
- Zep group 级图谱与 user 图谱的合并细节、get session memory 的 min_tokens/facts 参数默认值（仅据 help.getzep.com 摘要）。
- Claude Code auto memory 的具体加载预算/是否计入 system prompt 上限（docs 页被截断，未核到数值）。
- claudetto / claude-handoff 的 hook 实现细节（仅 README/wiki 描述）。
- DSH compaction/summary 事件里 summary: ContentBlock[] 的实际长度分布——建议实测后再定 8k char 预算是否需调。
