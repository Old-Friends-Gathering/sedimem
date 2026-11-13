# v0.6 三件事 vs 网上同类方案（2026-11）

对比对象：sedimem v0.6.0 施工图（`docs/plans/v0.6-memory-quality-and-session.md`）的 A 写侧契约、B 临时记忆库、C 分库粘性。
标注约定：「✅已核」= 打开了文档/仓库/源码；「据描述」= 依据二手资料未打开原文。

## 1. A 写侧契约 vs 各家粒度规范

我们：`value` ≤300 字超限报错、`text` >600 打 `long-form` 标签、`title` 必填、不再静默截断（I37 验收）。

### Mem0 fact extraction（✅已核 docs.mem0.ai + GitHub issues）

- 他们的做法：LLM 从对话抽取 fact，无 300 字这种写侧硬限；靠 prompt 引导简短。抽取有门槛（据描述 ≥35 轮对话才稳定出记忆）；[issue #5428](https://github.com/mem0ai/mem0/issues/5428)（✅已核）显示抽取输出被 max_tokens 截断时**静默丢掉全部 facts**——正是我们「静默截断」要消灭的失败模式。
- 我们优在哪：确定性校验不依赖 LLM 输出质量；错误码 + 拆分示例可直接指导 agent 自我修正；`long-form` 可统计可查询。
- 我们劣在哪：没有语义抽取，一条 600–4000 字的模糊长文只能打标签放行，Mem0 至少会试着拆。

### basic-memory 一行一事实（✅已核 docs.basicmemory.com）

- 他们的做法：Markdown 列表一行 = 一条 observation，语义靠 `[category]` 前缀标签（`[decision]`/`[status]`…），文档明确"checkbox/时间戳前缀不算 category"。
- 我们优在哪：同样"一行一事"精神，但我们有字符级硬限 + 机器可验收（I37），且 kind 是 schema 字段不是文本约定；他们的粒度纪律全靠写作者自觉。
- 我们劣在哪：他们人类可直接用编辑器写，格式宽容；我们必须走 MCP 工具，人工补录体验弱。

### mcp-memory-service belief 粒度（✅已核 GitHub issues + newreleases）

- 他们的做法：memory 之上派生 `belief`（`derived_from`/`contradicted_by`），矛盾值交换进 quarantine 而非当近重复丢弃（v11.14.0 release notes，✅已核）；但 [issue #1857](https://github.com/doobidoo/mcp-memory-service/issues/1857)（✅已核）显示删 memory 后 belief 与 consolidation 摘要不联动——派生层一致性是欠账。
- 我们优在哪：append-only 真相层 + supersede 版本链天然可回溯，派生物（索引）可从真相层全量重建，不存在"删了源留了派生物"。
- 我们劣在哪：没有 belief 这种矛盾推理层；冲突只有 `disputed` 标记 + curate 人工裁决，自动化程度低。

### Cline memory-bank 6 文件约定（✅已核 docs.cline.bot）

- 他们的做法：固定 6 文件（projectbrief / productContext / activeContext / systemPatterns / techContext / progress），projectbrief 是"塑造其它一切文件的基础文档"。
- 我们优在哪：不限定模板，kind 分类 + 8 段 checkpoint 结构是 schema 而非文件名约定；跨三端（DSH/Codex/Claude）可执行。
- 我们劣在哪：6 文件对人类新会话"翻一眼就懂"的 affordance 强；我们靠 brief 渲染，可读性取决于渲染器。

### Claude Code CLAUDE.md 风格建议（✅已核 code.claude.com docs）

- 他们的做法：官方文档建议 CLAUDE.md 用 bullet、简洁、命令优先；结构靠人工维护，无强制上限。
- 我们优在哪：上限是机器校验的不是风格建议；有 `p90TextChars`/`titleCoverage` 指标（Q11 门禁）可证明纪律生效。
- 我们劣在哪：CLAUDE.md 每次全量注入无需检索，冷启动成本为零；我们要 search/brief 两跳。

## 2. B 临时记忆库 vs 会话级记忆方案

我们：`session:<id>` 独立分库、1 条 state（8 段 checkpoint ≤8k）+ N 条 decision/gotcha、L0 约定快照 ≤1k、close 时按 kind 白名单晋升 + 生成 `docs/handoffs/<id>.md`；触发 = 首次 `compaction/summary` 自动建库，close 必须显式。

| 方案 | 自动/手动 | 触发阈值（✅已核除注明） | 对比结论 |
|---|---|---|---|
| Claude Code /compact 与 auto-compact | 手动 `/compact` + 自动 auto-compact | 自动按上下文窗口余量触发（200K 模型压到窗口内；据描述阈值为窗口占满前的固定余量，版本间有调整） | 压的是**当前会话**；我们省的是**跨会话重述**，正交 |
| Cline activeContext | agent 自主更新 | 无阈值，每轮自主决定写 | 同为"当前状态单文件"，但我们有字符预算 + 版本链 + 禁 fact 白名单 |
| Cursor rules | 纯手动 | — | 只管约定不管战役状态；相当于我们只做 L0 不做 L1 |
| Letta memory blocks + archival | 自动：agent 每轮可改 core blocks | 无阈值，block 有 char limit（据描述可配） | block≈我们的 L1，archival≈L2；他们靠模型自改，我们 supersede 不可变链更安全但更新更重 |
| Zep session summary | 自动 | 每次调用 Memory API 实时更新 Fact Table + summary（✅已核 zep docs overview） | 服务端自动、需 API；我们离线零依赖，但无实时 fact 表 |
| 工程界 handoff 文档惯例 | 手动 | — | 我们的六段模板 + `generatedAt/branch/headCommit` 头（Q12）把惯例机械化，优于自由格式 |

**核心问题：改成完全手动（用户说建库/存快照才动）的风险与兜底**

- 最大风险：①漏 checkpoint——用户忘记说"存快照"，宿主 compaction 已把中间态压掉，state 停留在旧版本，新会话拿到过期状态；②遗忘交接——会话结束了没人喊 close，晋升不发生、handoff 不生成，decision/gotcha 随 TTL 一起湮灭（这是真正的数据丢失路径，auto 模式下 close 也靠人但至少建库是自动的）。
- 低成本兜底（不恢复自动写）：**阈值提示而非自动压缩**——插件照旧订阅 `compaction/summary`，但事件到达时只做两件事：(a) 若无活跃战役，注入一条一次性提示"本会话已被压缩 N 次，建议 `memory_session start`"（N≥1 或 ≥2 才提示，防噪音）；(b) 若有活跃战役但 state 超过 X 次压缩未更新，提示"checkpoint 已陈旧"。写入动作仍等用户指令。这保留了「开可自动、关必须显式」的硬约束，只是把"开"也降级为提示。再配 TTL 到期前 brief 警告 + `memo session sweep` 批量捞未 close 的 stale 库，堵住交接遗忘。

## 3. C 分库粘性 vs 「工作区 = 记忆边界」

我们：UI 三级回落 hash → localStorage → server `current`，`resolveUiScope` 纯函数 6 用例锁定。

- Cline（✅已核 docs）：每工作区一个 memory bank，目录即边界，无跨库切换 UI——简单但换个目录就"失忆"。
- Letta（据描述）：agent 绑定 source/blocks，边界在 agent 不在工作区——多 agent 各自记忆，人工难全局看。
- Claude Code（✅已核 docs）：CLAUDE.md 按 project 目录 + 父目录向上查找，enterprise policy 可注入——目录树即层级，但无用户级切换。
- 我们优在哪：**显式 scope 概念**（`repo:`/`dir:`/`session:`）+ UI 粘性，一个界面看所有库；三级回落保证删库/多标签页不炸。
- 我们劣在哪：scope 是我们自己发明的维度，宿主（DSH/Codex/Claude）不会替我们传 scope，跨端要靠各插件自行推断 cwd → scope，推断错了记忆就记错库（这正是本次 memo server 的已知坑）。

## 4. 结构性优劣（诚实版）

强项（多数是设计取舍的回报）：
- append-only 真相层 + as-of 回查：Mem0/mcp-memory-service 的派生层一致性问题（#5428、#1857）在这不存在——索引可重建。
- 三端共用 + 离线零依赖 + 无 API key：上表所有对标物都不满足（Zep 需服务端、Mem0 需 LLM 抽取、Letta 需 server）。
- 验收机械化（I37–I41、Q11/Q12）：把"记忆质量"变成 CI 可拦的数字，同行几乎没人做。

设计取舍（接受代价，不必追）：
- 无语义检索：零依赖约束下 BM25 是天花板；换语义检索必须引 embedding，破坏核心承诺。属取舍。
- 自动化靠 agent 自觉（写短、拆分、检索）：MCP 工具描述 + hints 软信号是零依赖下能做到的极限。属取舍。

真欠账（不是取舍，该还）：
- UI/生态弱：无人类直接编辑入口、无导入（CLAUDE.md/basic-memory 迁移器）、可视化只到 mockup。这是投入问题不是约束问题。
- 跨端 scope 推断缺统一真源：三个客户端各自猜 cwd，错了静默记错库——C 修的是 UI 粘性，但写入侧的 scope 对齐仍是欠账。
- 冲突处理停在 `disputed` 标记：对比 mcp-memory-service 的 belief quarantine（自动归档矛盾对），我们裁决全靠人跑 curate，量大后会堆积。

## 5. 结论：v0.6 应改的设计（≤5 条）

1. **B 的自动建库建议降级为"阈值提示 + 一键 start"**：完全静默建库与「自动化靠 agent 自觉」的批评自相矛盾，且首次 compaction 即建库对短会话太激进；提示 ≥2 次压缩再建，保留零打扰回退（理由见 §2 兜底分析）。
2. **close 增加"孤儿打捞"命令**（`memo session sweep` 批量列出 stale 未 close 库并交互式晋升）：纯显式 close 的设计在真实使用中必然漏交接，这是数据丢失路径（理由：TTL tombstone 会吃掉未晋升的 decision/gotcha）。
3. **A 的 300 字上限先 rc 观察是对的，但应把 `hints` 多事实拆分做成可直接重放的**——返回建议拆分数组而不只是 `factsSuspected:N`，降低 agent 二次写坏的概率（理由：错误信息可操作性 > 计数）。
4. **补"CLAUDE.md 导入器"进 v0.6 或 v0.6.1**：迁移成本是采纳门槛里最便宜能拆的一堵墙，且是 §4 欠账里唯一不破坏零依赖的（理由：一次性格式转换工具，非运行期依赖）。
5. **写入侧 scope 推断统一到一个可测模块**：C 只修了 UI 读侧粘性，写入侧各客户端还在各自猜；至少把「cwd → scope」规则抽成纯函数并加进 eval（理由：记错库是最难发现的静默数据污染）。

## 参考

- Mem0：[issue #5428 截断静默丢 facts](https://github.com/mem0ai/mem0/issues/5428)（✅已核）；[docs.mem0.ai](https://docs.mem0.ai)（据描述部分：35 轮门槛，via theneuralbase.com，未开原文）
- basic-memory：[observations-and-relations（一行一观察 + category）](https://docs.basicmemory.com/raw/concepts/observations-and-relations.md)（✅已核）
- mcp-memory-service：[issue #1857 删源留 belief](https://github.com/doobidoo/mcp-memory-service/issues/1857)（✅已核）、[v11.14.0 belief quarantine](https://newreleases.io/project/github/doobidoo/mcp-memory-service/release/v11.14.0)（✅已核）
- Cline：[Memory Bank 六文件](https://docs.cline.bot/best-practices/memory-bank)（✅已核）
- Letta：memory blocks / archival 机制（据描述，未开 letta.com 原文）
- Zep：[Memory API overview：Fact Table + summary 实时更新](https://github.com/fern-api/fern/blob/76ac5deed794955e5bc759e49c5592644b095fe9/packages/cli/docs-importers/mintlify/src/__test__/outputs/zep/fern/chat-history-memory/overview.mdx)（✅已核镜像，未开 zep.ai 原文）
- Claude Code：[model-config 文档（auto-compact 窗口语义）](https://code.claude.com/docs/fr/model-config)（✅已核）；CLAUDE.md 风格建议（据描述）
- 我们：`docs/plans/v0.6-memory-quality-and-session.md`（本地，✅已核全文）

## 未验证

- Mem0「35 轮抽取门槛」：仅第三方课程页陈述，未开 Mem0 官方文档核实具体阈值。
- Letta memory block 的 char limit 配置项与默认值。
- Zep 官网原文（读的是 Fern 镜像的 overview.mdx）。
- Claude Code auto-compact 的精确触发余量数字（官方文档只说"按窗口压"，未给百分比）。
- Cursor rules 的最新分片机制（.cursor/rules 目录变化快，本文按"纯手动"旧模型描述）。
