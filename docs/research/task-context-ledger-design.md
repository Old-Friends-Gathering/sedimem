# 任务上下文账本（context ledger）—— 调研结论与设计修正

> 触发：用户指出「任务库的目的就是跨会话多 agent 开发，会话上下文不能丢；每个会话 30k 上下文压缩起来存，别关掉就没了」。
> 现状判断：**用户是对的**。当前任务库只存 decision/gotcha/state，close 只晋升 decision+gotcha，`session.hintTokens=30000` 是死配置（无消费者），既没有自动捕获也没有「新会话读回」的入口——它更像「记忆库的临时分区」，不像「任务上下文账本」。

## 一、三个一手事实（本机实测，可复现）

| 事实 | 数值 | 怎么测的 |
|---|---|---|
| 一个长任务会话的真实体量 | 本会话 transcript **63.9 MB**、34,184 个事件、**4,908 条 assistant 消息**、4,835 次工具调用 | 逐帧解压 `~/.dsh/sessions/<slug>/<id>/session.v4.jsonl.zstd` |
| 压缩是常态，不是意外 | 本会话压缩 **145 次**、累计挤出 **≈295.7 万 tokens**、单次最大 **12.1 万** | 统计压缩工具返回的 `~N tokens saved` |
| 宿主窗口与阈值 | DSH 的 glm-5.3 `contextWindow=1,000,000`；DSH 压缩 `thresholdRatio=0.8`、`retainRatio=0.16` | transcript 的 `request/context` 事件；`dsh-compaction` 源码 |

结论：「每会话 30k」不是宿主事实——**30k 是我们自己 policy 里一个没实现的阈值**。留着的后果是：以为有保护，其实没有。

## 二、宿主压缩各家怎么做的（调研 A，`host-compaction-2026.md`）

- **DSH**：不可变追加事件日志 + surface 投影 shadowing；压缩产物是一条普通事件（`kind:'compact-checkpoint'`，`<compacted-summary>` 包裹，固定 8 段），**transcript 永不破坏**。重载时只回放 surface，被 shadow 的区间不再进入上下文。
- **Claude Code**：auto-compact 在窗口 ~92–95% 触发；压缩后只保证重载 `CLAUDE.md` / skills / 最近 5 个文件，其余折叠成摘要；`--resume` 恢复原始 JSONL。但 issue #40352 / #63187 实证「先清 transcript 再调摘要 API」，失败即永久丢数据。
- **Codex CLI**：`/compact` 是破坏性折叠（session id 不变）；issue #29302：压缩态不跨 CLI/App 同步，长线程 resume 会死锁。
- **共同点**：压缩必然丢细节，丢掉的是**试错过程、用户纠正、半成品决定**——恰好是跨会话接力最值钱的部分。任何「新会话能否接上」的能力，都不能指望宿主压缩后还留着。

## 三、值得抄的三条（调研 B，`cross-session-handoff-2026.md`）

1. **PreCompact checkpoint**（basic-memory）：宿主压缩**之前**主动写 schema 化 checkpoint（coding 场景强制带 repo/branch/SHA）。→ 我们的版本：压缩前/会话结束时捕获上下文段。
2. **渲染-测量-递减预算**（claude-mem `ContextBudget.ts`）：注入不能按条数配预算（条目长度差 10 倍），要渲染后测长度、超了按固定顺序丢。→ 简报生成必须这么做，否则要么撑爆上下文、要么丢掉结论。
3. **渐进披露**（claude-mem）：先给索引（≤100 token/条），命中再取正文。→ 简报默认给「决策/卡点/文件」三段，详细段落按需 `--full`。

不抄：图数据库基建（Graphiti 那套）、Letta 式常驻 agent、中心化 observer 全量压缩（成本不可控，且事故都出在自动路径）。

## 四、方法论（调研 C，`context-handoff-methodology-2026.md`）

- Anthropic 官方三策略里，我们该用的是 **structured note-taking**（文件外存 + context reset 后读笔记续作），不是 sub-agent。
- Manus 的经验把「压缩耗 token」量化了：**KV-cache 命中率是生产期最重要指标**，输入:输出 ≈100:1，缓存命中与否成本差约 10 倍；每次压缩等于「缓存全量 re-pay」。→ 这也是「别频繁压缩、宁可存成文件再读」的经济依据。
- 度量：LongMemEval 的 **KU（知识更新）/ TR（时间推理）/ MR（多会话）** 三类最贴近；自建注入式断言 = 受控会话 → close → 新会话**只看晋升产物与简报** → 必须答出关键决策/卡点/文件。

## 五、设计修正（v1.2 提案）

**定位改变**：任务库 = **任务上下文账本**，不是"记忆的临时分区"。

1. **存储单元从「记忆条目」变成「会话段（segment）」**
   新 kind `context`，一条 = 一段会话的压缩结果：
   `{seq, sessionId, hostSessionId, cwd, branch, fromTs, toTs, turns, tokensIn, tokensOut, files[], decisions[], gotchas[], pending[], nextSteps[], errorsAndFixes[], summary}`
2. **捕获时机（三处，全部可追溯）**
   - `memo session capture [--auto|--transcript <path>|--file <json>]`：读宿主 transcript（已实现 `session/transcript.js`），本地规则抽段（零 token），LLM 只在显式 `--llm` 时做二次摘要；
   - `memo session close` 之前**强制**捕获一次（不捕获不允许关）；
   - `--if-needed`：按 `policy.session.captureTokens`（默认 30000，真正实现旧 `hintTokens`）判断，达到阈值才建议/执行。
3. **恢复入口（用户真正的诉求）**
   - `memo session brief --scope session:<id>` → 「任务简报」：标题、状态、最近 3 段上下文（每段 ≤400 字符）、待办、下一步、关键文件、累计 token；
   - MCP `memory_session_brief`；新会话开工第一个动作就是它；
   - `--full` 输出完整段（渐进披露）。
4. **close 语义修正**：`context` 段**永久保留**（不 tombstone），只丢 `state` 噪音；`decision/gotcha` 仍晋升主库；`--purge-context` 才删。
5. **UI**：任务页新增「上下文接力」时间线（每段可展开 8 段表格）+ 顶部「已用 token / 下一段阈值」+ 一个「生成简报」按钮（可一键复制给下一个 agent）。
6. **度量（可机械检验）**
   - I53：受控会话写入 → capture → 关闭 → 新会话**只读简报**，必须答出决策/卡点/文件（100% 匹配）；
   - 四组对照：无账本 / 只晋升 / +checkpoint / +context 段，差值进 CI；
   - 压缩经济：记录 `tokensIn/tokensOut`，算 breakeven turns（capture 成本 vs 重读 transcript 成本）。

## 六、诚实边界

- 我们**不做宿主级压缩**（那是 DSH 的事），只做「压缩前落盘 + 跨会话可读」。
- 不承诺 100% 不丢：承诺的是**关键决策、文件、卡点、下一步不丢**，并用注入式测试证明。
- 不做自动压缩触发之外的花活：捕获默认本地规则，LLM 显式开启（成本可控）。

## 七、参考文件

- `docs/research/host-compaction-2026.md`（宿主压缩机制与事故）
- `docs/research/cross-session-handoff-2026.md`（8 个开源实现的跨会话接力）
- `docs/research/context-handoff-methodology-2026.md`（Anthropic/Manus 方法论 + 评测协议）
