# sedimem 会话临时库：LLM 自动写 checkpoint 方案调研

日期：2026-11-14 · 调研范围：transcript 来源 / 压缩比例 / prompt / 增量策略 / 验证 / 成本。
基准代码：`versions/v0.6/src/session/checkpoint.js`（8 段、每段 ≤2000 字、合计 ≤8000 字，`CHECKPOINT_SECTION_MAX_CHARS=2000` / `CHECKPOINT_TOTAL_MAX_CHARS=8000`，见该文件第 19–21 行）。

## 1. 输入从哪来：三家客户端的 transcript

| 客户端 | 本机路径（已验证） | 结构 |
|---|---|---|
| DSH | `~/.dsh/sessions/<cwd-slug>/<session-uuid>/session.v4.jsonl.zstd` | zstd 压缩的 JSONL。首行 `{"type":"session","version":4,...,"cwd":...}`；后续行 `{"type":...,"seq":N,"time":...,"data":{...}}`，含 `subagent/descriptor`、`sandbox/mode` 等（实测 `zstd -dc` 可读）。目录按 cwd slug 分组，session id 即目录名。 |
| Codex CLI/Desktop | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` | JSONL。首行 `{"timestamp","ordinal","type":"session_meta","payload":{"session_id","cwd","cli_version":"0.153.4",...}}`，之后按 ordinal 递增的消息行（实测样本 2026-09-09）。 |
| Claude Code | `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl` | JSONL。行含 `"type":"queue-operation"`、`sessionId`、`timestamp`、`content`（用户排队消息）等；assistant 行结构未逐一核对——**未验证**（仅抽样首行）。 |

取数策略推荐（按优先级）：
1. **DSH 宿主**：继续订阅 `compaction/summary` 事件（payload 含 `{compactionId, summary, shadowedRange, provider, model, usage}`，出处：`docs/plans/v0.6-memory-quality-and-session.md:65`），零额外输入成本；需要原始轮次时直接解压当前 session 的 `session.v4.jsonl.zstd`。
2. **非 DSH 宿主（Codex/Claude）**：由 CLI 侧 `memo session checkpoint --from <file>` 读上述 JSONL 尾部 N 条（按 token 预算截断），拼成 prompt 输入。
3. **兜底**：Agent 主动贴「最近 N 轮」——最通用但最贵、易漏，仅作逃生口。

## 2. 压缩工序：多少对话压成多少 checkpoint

参照系：
- DSH `compaction-basic`：`thresholdRatio 0.8`（窗口 80% 触发）、`retainRatio 0.16`（尾部 16% 逐字保留），即被摘要区间约占窗口 64%（出处：`docs/research/scratch-memory-2026.md:40-42`）。
- MemGPT：不设固定比例，用「内存压力告警 + 硬阈值」两档触发 LLM 自主 evict/summarize（arXiv:2310.08560；https://langchain-ai.github.io/langmem/guides/summarization/ 亦为阈值触发式）。
- LangMem `summarize_messages`：达到阈值后把更早消息替换为摘要，摘要递归复用上一版（https://github.com/langchain-ai/langmem/blob/main/docs/docs/guides/summarization.md）。

建议（Sedimem 规则）：
- **触发**：新增对话 ≥ **16k token**（约 0.8×128K 窗口的 1/6，相当于「每 5–8 个重工具轮」）或 DSH compaction 事件到达。
- **输入**：本次新增轮次 + 上一版 checkpoint（约 5–6k token），上限 20k token；超出时截断最旧工具输出优先。
- **输出**：8 段合计 ≤8000 字（现有硬约束），实际目标 2–4k 字（≈ 压缩比 5:1–10:1，与 retainRatio 0.16 量级一致）。
- **绝对上限**：输入 50k（超长会话兜底档），再大说明应先依赖 DSH 原生 compaction。

## 3. Prompt 设计（可直接用，中文）

抽取规则（8 段，顺序同 `checkpoint.js` 冻结清单）：
- **intent**：用户本轮目标 + 已发生的目标漂移（「最初 X → 现在 Y」）。≤3 句。
- **concepts**：涉及的模块/协议/术语，一行一个，附定位（如 `session/checkpoint.js`）。
- **files**：真实被读/改的路径，带行号 `path:line`；只列仍相关的。
- **errorsAndFixes**：`错误现象（含报错原文关键字）→ 根因 → 修法` 一行一条；修法必须可复现。
- **pendingJobs**：已声明未做完的事，附 owner/阻塞点。
- **currentState**：现在代码/环境/任务处于什么状态（分支、测试是否绿、构建是否过）。
- **nextSteps**：下一步动作清单，每条必须是**可独立执行且可验证**的动词短语。
- **criticalContext**：不记就会丢的非显性信息：约束、决策及理由、用户原话关键句（带消息 ref）。

必须保留：文件路径+行号、错误原文、修法、待办、决策及「因为」。
必须丢弃：寒暄/确认语、重复内容、工具原始输出（只留结论与错误行）、已被推翻的中间假设（只留结论）。

System prompt 草稿：
```
你是会话 checkpoint 抽取器。输入是 AI 编码会话的新增对话片段与上一版 checkpoint。
任务：产出最新一版 8 段 checkpoint（JSON：intent/concepts/files/errorsAndFixes/pendingJobs/currentState/nextSteps/criticalContext；前五段与 nextSteps 为字符串数组，currentState/intent/criticalContext 为字符串）。
规则：
1) 只写有证据的内容，禁止编造路径、错误、数字；引用用户原话时附消息 ref。
2) 文件路径必须带行号（path:line），只保留本轮后仍相关的。
3) errorsAndFixes 每条=「现象→根因→修法」，现象保留可 grep 的报错关键字。
4) nextSteps 每条是可独立执行、可验证的动作；已完成的事从 pendingJobs/nextSteps 移除。
5) 决策必须带理由（"选 X 因为 Y"）；丢弃寒暄、重复、工具原始输出。
6) 每段 ≤2000 字，合计 ≤8000 字；数组段每条一行、不加编号装饰。
7) 上一版 checkpoint 中仍然成立的内容要继承，被本轮推翻的必须更新而不是并存。
输出：仅一个 JSON 对象，无其他文本。
```

## 4. 增量 vs 全量

| | 增量（现状：追加 + supersede 上一版） | 全量重写单条 |
|---|---|---|
| 一致性 | 段间可矛盾，需靠 supersede 语义收敛 | 单一事实源，无版本冲突 |
| 成本 | 输入=新增+上一版（低） | 输入=新增+上一版（相同）；输出=整版重写（略高） |
| 审计 | 有历史链可回溯（对比 diff 可看演化） | 只有最后版，历史靠 tombstone 丢 |
| 实现风险 | 需保证「旧版真被 supersede」，否则双写 | 简单，但一次坏抽取会整体覆盖好版本 |

**推荐：保持「追加 + supersede」，不改全量重写**。理由：① prompt 第 7 条已要求「继承+更新」，语义上等价于全量重写但保留审计链；② close 晋升/交接文档需要演化证据；③ 成本差异仅在输出端、不足输入的 1/3。前提是补一条硬检查：同 scope 内未 supersede 的 checkpoint >1 时告警（可挂在 `session checkpoint` CLI 落库处，`src/cli/session.js:159` 附近）。

## 5. 验证：两个可跑的检查

1. **files 路径真实性检查**：遍历 checkpoint 的 `files` 段，`path:line` 去掉行号后 `fs.existsSync`（相对路径按 session cwd 解析）。脚本 ~15 行，可直接挂进 `tests/unit/session-checkpoint.test.js` 风格的单测：对真实会话回放时路径存在率应 ≥95%，低于阈值报警。
2. **nextSteps 后续引用率检查**：会话结束后，对每条 nextStep 关键词在「该 checkpoint 之后至 close 之前的 transcript」里做子串/正则匹配（文件名、命令、issue 号）。输出「被引用条数 / 总条数」。离线脚本跑 `~/.dsh/sessions` 解压文本即可；持续低于 50% 说明抽取太抽象，需要把 nextSteps 约束改成「含具体文件或命令」。

（均为离线校验，不进热路径；建议放 `tools/` 下，如 `tools/checkpoint-audit.mjs`。）

## 6. 成本

单价假设：GLM-5.3-Flash 输入 ¥0.8/M、输出 ¥2.8/M（任务给定）。单次输出按 8 段合计 ~2500 中文字 ≈ 3k token 计（≤8000 字上限的常态占用）。

| 输入档 | 输入成本 | 输出成本 | 单次合计 |
|---|---|---|---|
| 8k token | ¥0.0064 | ¥0.0084 | ≈¥0.015 |
| 20k token | ¥0.016 | ¥0.0084 | ≈¥0.024 |
| 50k token | ¥0.04 | ¥0.0084 | ≈¥0.048 |

8 小时开发会话：按 §2 触发规则（每 ~16k 新增 token 一次），重度使用约 8–12 次 checkpoint，全按 20k 档算 ≈ **¥0.2–0.3/天**；即使全部按 50k 档也不超过 ¥0.6。结论：成本可忽略，优化方向应放在质量与触发时机，不在省钱。

## 出处清单

- DSH session 存储：`~/.dsh/sessions/<slug>/<uuid>/session.v4.jsonl.zstd`（实测 zstd -dc 首行 `type:session,version:4`）。
- Codex：`~/.codex/sessions/2026/09/09/rollout-*.jsonl`（实测首行 `session_meta`，cli_version 0.153.4）。
- Claude Code：`~/.claude/projects/<slug>/<uuid>.jsonl`（实测含 `queue-operation` 行；assistant 行结构未验证）。
- compaction 参数：`docs/research/scratch-memory-2026.md`、`docs/plans/v0.6-memory-quality-and-session.md:65`。
- 8000 字约束：`versions/v0.6/src/session/checkpoint.js:19-21`。
- LangMem summarization：https://langchain-ai.github.io/langmem/guides/summarization/
- MemGPT（arXiv:2310.08560）压力阈值思路：https://github.com/langchain-ai/langmem/blob/main/docs/docs/guides/summarization.md 及论文原文（未直接核对论文 PDF，比例性结论以 DSH 实现为准）。
