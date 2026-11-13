# 开发期临时/会话记忆库调研（每 ~30k token 压缩一次）

日期：2026-11-13。标注约定：【核】= 本人核对过原文/二进制；【听】= 二手信息，未核原文。

用户原话：「做开发零食记忆库（临时记忆库），就比如我开发一个项目，一个会话开了多 agent 开发，那能不能做临时记忆库，每次经过 30k 就经历一次压缩总结，这样就避免跨会话丢失和读过多上下文的时候导致消耗过多的 token」。

## 1. 现成做法盘点

### 1.1 编码 Agent 内置压缩

| 系统 | 触发 | 压缩后保留 | 状态 |
|---|---|---|---|
| Claude Code `/compact` + auto-compact | auto 在逼近模型窗口时自动触发；`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 可改窗口大小【核：[model-config 文档](https://code.claude.com/docs/en/model-config)提到 auto-compact 按 200K 假设窗口压缩】；具体触发百分比未核 | 官方摘要结构未公开文档化；社区普遍报告保留"当前任务/决策/文件"类结构【听】 | 部分核 |
| Codex CLI auto-compact | 压缩发生在记录新输入之前，尾部 user 消息不进摘要、置于摘要之后；压缩后以新 baseline 继续【核：第三方实现 [uah/internal/compaction](https://pkg.go.dev/github.com/viktordanov/uah@v1.8.4/internal/compaction) 的行为描述，与 Codex 行为对齐】 | 同上"尾部保留、头部摘要"模式 | 部分核 |
| Cursor / Cascade 上下文折叠 | 折叠旧块、保留近窗 | —【听，无一手出处】 | 未核 |

### 1.2 记忆系统

- **MemGPT / Letta**【核：[MemGPT 论文 arXiv:2310.08560](https://arxiv.org/abs/2310.08560) 的转述笔记 [letta.md](https://raw.githubusercontent.com/dmccreary/agents-course/refs/heads/main/docs/concepts/letta.md)】：OS 式虚拟上下文；主上下文压力 **70% 警告 / 100% 强制换页**，eviction 时对被逐出消息做 **recursive summary**（旧摘要再摘要，层级化），召回靠检索。深检索准确率 GPT-4 32.1%→92.5%。
- **Mem0 session summary**【核：[Mem0 OpenCode Plugin v0.1.3 release note](https://newreleases.io/project/github/mem0ai/mem0/release/opencode-v0.1.3) + [火山引擎 Mem0 文档](https://docs.volcengine.com/docs/mem0/modifying-long-term-memory-retrieval-strategy?lang=en)】：stop hook 触发结构化 `session_summary` 记忆，固定四段：**request / decisions / learnings / next steps**；prompt 模板可自定义。
- **Zep session episode 边界**【核：[Context Graph overview](https://help.getzep.com/v3/graph-overview)】：以 **episode**（一次会话/消息批次）为原始事实单元入图，事实带 bi-temporal 有效期，从 episode 派生三元组；会话边界=episode 边界。与 sedimem 的 append-only + bi-temporal 同构。

### 1.3 阈值与保留物的共性

- **阈值**：主流不用绝对 token 数，用 **窗口占比**：MemGPT 70%/100%；DSH `thresholdRatio` 默认 0.8（见 §2）。用户提的"30k 一次"≈在 128K 窗口下约 23%，比业界明显激进——好处是每步输入便宜、坏处是压缩调用频繁且信息损失累积快。建议做成占比而非绝对数，30k 只是默认值的一种表达。
- **保留白名单**（跨实现高度一致）：用户原始意图（逐字）、决策与理由、精确文件路径/命令/错误串/签名、未完成项、当前进行中工作、下一步；同时保留"最近 N 条消息逐字"（Codex、DSH 的 retain 尾部）。DSH 的冻结摘要 prompt 是最完整的清单（§2.3）。

## 2. DSH 宿主已有能力（重点，全部【核】）

证据来源：本地 app.asar（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内 `/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/`，含 README.md 273 行与 src/index.ts 476 行，已提取核对）+ GitHub `deepseek-ai/deepseek-harness` master 分支 docs。

### 2.1 `dsh-compaction-basic`（随 dsh base 默认启用）

来源：asar 内包 README（同内容见 [packages/compaction/compaction-basic](https://github.com/DeepSeek-Harness/deepseek-harness/tree/master/packages/compaction/compaction-basic)，以 asar 内副本为准）。

可配置项（README "Tuning when condensation starts" 全表）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `thresholdRatio` | `0.8` | 触发占比，`floor(min(W×r, W−O−B))` |
| `headroomTokens` | `65536` | 压力余量 B |
| `retainRatio` / `retainTokens` | `0.16` | 尾部逐字保留量（二选一） |
| `summarizationProvider`/`summarizationModel` | 空 | 摘要模型路由（空=跟随当前会话模型） |
| `maxTokens` | =headroom | 摘要输出上限 |
| `compactionRetries` / `maxOverflowRetries` | `1`/`1` | 收敛重试 / 溢出恢复重试 |
| `modelPolicies` | `[]` | 按 `{provider,model}` 覆盖上述全部 |
| `auto` | `true` | 自动+溢出恢复开关（false=仅 `/compact` 手动） |

扩展点：**`summarize()` 是唯一的子类 hook**（README "Design philosophy" 第 4 条原文："`summarize()` is the sole subclass hook. A template- or remote-summarizer subclass can override it…"）。**没有"自定义摘要 prompt"的配置项**——冻结的 compaction instruction 写死在包内；要换 prompt 只能子类化覆盖 `summarize()`。配套还有 `dsh-compaction-tool-result-pruner`（压缩前先无模型裁剪超大工具输出）与 `dsh-command-compact`（`/compact` 命令）。

### 2.2 事件与 token 统计

- 插件可订阅事件：compaction-basic 源码（asar 内 src/index.ts）注册了 `ctx.on('agent/pre-step')`、`ctx.on('agent/request')`、`ctx.on('agent/status')`、`ctx.on('session/event')`、`ctx.on('agent/request-error')`。【核：asar 源码 157/177/183/207/213 行】
- `step/end`：**log-only，payload 只有 `{turn, step}`，不带 usage**。【核：[persistence-catalog.md](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/persistence-catalog.md) `{ type: "step/end" }` 节】
- token 用量的真实载体是 **`assistant/message` 事件的可选 `usage?: TokenUsage`**（"model output and its accounting travel together (there is no separate usage record)"）；`compaction/summary` 也带 `usage?`。【核：同上 persistence-catalog.md】
- `TokenUsage` 结构（`packages/llm/llm/src/types.ts:182`）：`inputTokens*`、`outputTokens*` 必填；`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`、`totalTokens` 可选。**没有 `uncachedInputTokens` 字段**——任务描述里的字段名与实际不符；未缓存输入 ≈ `inputTokens`（各家 adapter 口径需再核，标未验证）。【核：persistence-catalog.md TokenUsage 节】

### 2.3 三档结论

| 能力 | 档位 | 证据 |
|---|---|---|
| 占比阈值自动压缩 + 尾部保留 + `/compact` 手动 | **可直接用** | asar 内 README 配置表 + 默认随 dsh base 启用 |
| 插件订阅会话事件（`session/event` 拿到含 `assistant/message.usage` 的事件流） | **可直接用**（事件可订阅；累计求和要自己加） | compaction-basic 源码 `ctx.on('session/event')`；events.md 列出 `session/event` 的消费者名单含 compaction-basic |
| "本会话已用 token" 累计 | **需要自己算**：订阅 `session/event`，对 `assistant/message.usage` 求和；`step/end` 拿不到 | persistence-catalog.md：usage 只挂在 assistant/message |
| 自定义压缩摘要 prompt | **拿不到（配置层）**：无 config 字段；只能子类化 `summarize()` 或写自己的 compaction 插件实现 seam | README "sole subclass hook" |
| 压缩摘要的持久化读取 | **可直接用**：`compaction/summary` 事件含 `summary: ContentBlock[]`、`shadowedRange`、`shadowedTokenCount`、provider/model、`usage` | persistence-catalog.md `compaction/summary` 节 |

附带：DSH 冻结的压缩指令要求的输出结构（这是"压缩后保留什么"的最成熟答案，也是白名单基准）：`Primary Request and Intent / Key Technical Concepts / Files and Code（精确路径）/ Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context（决策+理由、约束、用户偏好、开放问题）`，并要求逐字保留路径、命令、错误串、标识符、数值、签名。【核：asar 内 README "Compaction instruction" 节】

## 3. 设计空间：临时记忆库放哪层

数据模型复用 sedimem 现有 MemoryRecord；临时库 scope 命名 `session:<deterministic-id>`（一次项目开发战役一个库，非一个 DSH session 一个——多 agent 共享才是痛点）。

### 选项 1：DSH 插件侧（推荐起步）

插件订阅 `session/event`，自己累计 `assistant/message.usage.totalTokens`，每过 30k 调 `ctx.llm` 生成 checkpoint（或干脆挂钩 `compaction/summary` 事件——DSH 已经在压缩了，插件把现成 summary 写进 sedimem 即可，**零额外压缩 token**），通过 sedimem CLI/MCP `memory_write` 落库。

- 数据形状：1 条 `state` 记录（title="战役当前状态"，value=最新 checkpoint 全文，每次 supersede 自己）+ N 条 `decision`/`gotcha`（从 checkpoint 的 Critical Context/Errors and Fixes 拆出，kind 复用现有枚举）；`source.agent` 填 DSH agent 名，`tags: ["scratch", "session:<id>"]`。
- 恢复流程：新会话系统提示或用户说"继续 X"时，调 `memory_brief`/`memory_search`（限定 scope）把最新 state + 未完成 Pending Jobs 注入。恢复是拉取式，不自动重放全部历史。
- 过期清理：战役结束（显式 `memo session close` 或 TTL，如 7 天无写入）对整库 `memory_forget`（tombstone）。临时库是派生物，可整体丢弃。
- 优点：触发与 token 计量天然在宿主内；缺点：绑定 DSH，Codex/Claude Code 会话享受不到。

### 选项 2：sedimem 侧 `memo session snapshot`

CLI 子命令，读入（a）DSH 会话 JSONL 日志文件，或（b）任意 agent 导出的对话文本，跑一次压缩（走 sedimem 自己配的 LLM），产出与选项 1 相同的 1 state + N decision。

- 优点：宿主无关（Codex/Claude Code 也能事后跑）；缺点：事后批处理救不了"会话中省 token"——只解决跨会话丢失，不解决读过多上下文。

### 选项 3：两边都做（插件触发+存储，CLI 做导入/清理）

插件管实时触发与增量写入；`memo session snapshot` 管非 DSH 宿主导入与显式收口（战役结束时把临时库中有长期价值的 decision 晋升到项目主库 `repo:<name>`，其余 tombstone）。这是与 sedimem "真相层 append-only + 派生物" 架构最贴合的终态。

三种选项共同的恢复契约建议：临时记忆 **永远可从真相层原始日志重建**（DSH JSONL / 各 agent 日志在），因此临时库明确定义为派生数据、允许丢失，丢了大不了重放日志再压一次。

## 4. 风险

1. **压缩丢信息**：白名单必须逐字保留——文件路径、命令、错误串、函数签名、数值、用户纠正性反馈（各实现一致，见 §1.3/§2.3）；递归摘要（摘要的摘要）会滚雪球式失真，MemGPT 的教训是要带"仍为真的保留、过期的删除"的合并指令（DSH 冻结 prompt 已含此规则）。
2. **多 agent 并发写同一临时库**：sedimem 真相层是 append-only JSONL，追加本身无冲突；风险在 state 记录互相 supersede 形成颠簸——缓解：state 记录按 agent 分键（`subject=session:<id>/state/<agent>`）或只追加不 supersede、读取时取最新；decision 层用现有 dedupe_scan 消重。
3. **压缩本身耗 token（用谁的钱）**：DSH 路径下摘要调用复用会话 provider 的 warm prefix（asar README：replay 逐字节前缀，只有尾部指令与输出未缓存），成本记在宿主配置的模型上；若挂钩 `compaction/summary` 复用现成摘要则边际成本≈0。选项 2 的成本走 sedimem 自配模型。要在文档里写明这一点让用户选。
4. **与真相层 append-only 的关系**：临时记忆是**派生数据**（可从宿主会话日志重建），不进 `repo:<name>` 主库，不参与长期 brief；战役收口时人工/半自动晋升少数 decision 进主库。丢了不心疼是设计目标而非缺陷。

## 参考链接

- DSH compaction-basic（asar 内 README/src，本地核验）：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` → `dsh/node_modules/@deepseek-ai/dsh-compaction-basic/`
- DSH persistence-catalog（step/end、assistant/message.usage、TokenUsage、compaction/summary）：https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/persistence-catalog.md
- DSH event-producer-consumer（session/event 消费者矩阵）：https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/event-producer-consumer.md
- MemGPT 论文：https://arxiv.org/abs/2310.08560 ；课程笔记（70%/100% 阈值）：https://raw.githubusercontent.com/dmccreary/agents-course/refs/heads/main/docs/concepts/letta.md
- Mem0 session summary：https://newreleases.io/project/github/mem0ai/mem0/release/opencode-v0.1.3 ；https://docs.volcengine.com/docs/mem0/modifying-long-term-memory-retrieval-strategy?lang=en
- Zep Context Graph / episode：https://help.getzep.com/v3/graph-overview
- Claude Code model-config（auto-compact/窗口变量）：https://code.claude.com/docs/en/model-config
- Codex 压缩行为（第三方对照实现）：https://pkg.go.dev/github.com/viktordanov/uah@v1.8.4/internal/compaction

## 未验证清单

- Claude Code auto-compact 的精确触发百分比与摘要保留结构（官方未文档化，只有社区转述）。
- Cursor / Cascade 上下文折叠的触发与保留细节（无一手出处）。
- DSH 各 adapter 对 `TokenUsage.inputTokens` 是否已扣除 cacheRead（"未缓存输入"口径）。
- OpenAI 官方 codex 仓库中 auto-compact 的原文（本文 Codex 结论来自第三方 Go 实现的转述）。
- compaction-basic `summarize()` 子类化在打包发行版（asar）里能否被用户插件实际继承扩展——API 稳定性未在文档承诺。

## 对 sedimem 的三条建议

1. **别自建压缩触发器，搭 DSH 的车**：临时库的增量写入直接消费 `compaction/summary` 事件（现成摘要、现成 usage、零额外 token），30k 阈值通过 `modelPolicies.thresholdRatio/retainTokens` 调；自研触发器只服务非 DSH 宿主（选项 2 的 CLI）。
2. **临时库 = 独立 scope + 派生数据契约**：`session:<id>` 分库、state 记录按 agent 分键避免 supersede 颠簸、明文声明"可从宿主会话日志重建、可整体丢弃"，收口时晋升少数 decision 进主库——这保持真相层 append-only 语义不被临时数据污染。
3. **把 DSH 冻结的 8 段 checkpoint 结构定为 sedimem session snapshot 的规范输出格式**（Intent/Concepts/Files/Errors/Pending/Current/Next/Critical Context），它与 Mem0 四段、白名单共识同构，且已在一个生产宿主里验证过。
