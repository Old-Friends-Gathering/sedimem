# 对抗性审核处置（v1.2 任务上下文账本）

> doc-kind: history
> doc-version: 1.2
> 说明：本文件是对特定时点计划/代码的审核快照，内容冻结（引用当时的 versions/v1.1），不随版本升级改写。

五路红队：`01-data-consistency` / `02-cost-perf` / `03-product-ux` / `04-security-privacy` / `05-eval-validity`（报告同目录）。
本文是**处置结论**：哪些确认、哪些驳回、计划怎么改。凡标「已复核」的，是我本人跑代码/读源码复现过的，不是转述。

## 一、确认并已复核的阻断项（计划 v2 必改）

| ID | 问题 | 我的复核证据 | 计划处置 |
|---|---|---|---|
| B1 | transcript 目录 slug 对不上 | 真实目录 `~/.dsh/sessions/--Users-yeager-work-yeager-ldywoker--/<uuid>/`，而 `src/session/transcript.js:86` 生成 `-Users-yeager-work-yeager-ldywoker`（DSH 两侧各多一个 `--`） | B0：slug 改为按 `--<cwd 折横>--` 生成 + 遍历兜底匹配 |
| B2 | 多帧 zstd 只解首帧 | 实测该文件 **30 个帧**，`zstdDecompressSync(整个 buffer)` 只还原 **289 字节 / 2 行** | B0：按 magic `28 b5 2f fd` 切帧逐段解（实测 7 帧的旧会话可解出 21 行） |
| B3 | 事件 schema 不符 | 真实事件是 `{type:'user/message', seq, time, data:{content:[{type:'text',text}], role}}`、`turn/start{data:{turn}}`；`recordToTurn` 只认 `user_message`/`role` → **0 turn**（实测可解析记录数 = 0） | B0：按真实 schema 重写 `recordToTurn`，并加「本机真实会话 fixture」测试 |
| B4 | 8 段 JSON 装不进 `value` | `src/core/record.js:20` `MAX_VALUE=2000`，`:46` `Math.min(policy, MAX_VALUE)` **只能调小** | **改存储**：段不进 memory record，落 `$MEMO_HOME/tasks/<taskId>/segments.jsonl` |
| B5 | `halfLifeMs:null` 会让 policy 加载崩 | `src/config/policy.js:47` 要求 `Number.isFinite(meta.halfLifeMs) && > 0` | 同上：段不需要 kind 注册，彻底绕开 kinds 契约 |
| B6 | capture 绕过写门禁与脱敏 | `write-path.js:30-45` 才调 `redactText`；`checkpoint.js:174` 直接 `_commit`，是既有洞 | B1：capture 写段前显式 `redactText` + `detectSuspicious`，可疑段 `quarantined:true` 且不进简报 |
| B7 | close 强制 capture 会卡死用户 | 与 B1–B3 叠加时，transcript 读不到 → `session close` 永远失败 | B1：**默认不阻塞**——capture 失败只告警并记 `capture:"failed"`；`--require-capture` 才强制 |
| B8 | 账本没有发现入口 | `memory_brief` 与插件注入均不含任务；唯一办法是手抄 AGENTS | B2：`session brief --open` 自动挑最近 open 任务 + MCP `memory_session_brief` + `/api/tasks` 打「待接管」标 |

## 二、确认但降级（高 → 中）

| ID | 问题 | 处置 |
|---|---|---|
| H1 | `expand` 原文出口无脱敏，且与「逐字节还原」冲突 | `expand` 只走**本地 CLI**、默认写文件（`--to-file`），MCP 永不给原文；I54 对「原文切片」断言字节一致，对「简报/注入」断言必须已脱敏——两条路径分开测 |
| H2 | I53 自证（ground truth 由 capture 产物推导） | 期望答案由 Lead **在 capture 之前**从原始 transcript 手工摘出，存 `eval/cases/i53-expect.json`，capture 看不到它 |
| H3 | 多次 capture 与 transcript 增长的区间 | 段用 `[fromSeq,toSeq)` 半开区间，只在文件中**追加**新帧时 capture 尾部；`coveredSeqs` 由 `index.json` 给出，缺则从段重建 |
| H4 | `/api/tasks` 在 100 任务 / 1000 段的负载 | 列表只回摘要字段（不读全部段）；段按需 `GET /api/tasks/:id/segments` 分页（`limit` 默认 50） |
| H5 | trash/archive 里的敏感数据 | `trash` 保留 30 天后由 nightly 提示清理；`segments.jsonl` 里的敏感内容在写入时已脱敏（B6） |
| H6 | LLM 预算闸未接 | `src/llm/budget.js:70` 的 `chargeBudget` **无生产调用**（已复核）→ B2 在 `--llm` 路径显式接入，超预算直接拒绝 |

## 三、驳回 / 部分驳回

| 意见 | 为什么不做 |
|---|---|
| 「把段存成 SQLite / 双写索引」（04、02 各提一次） | 与「零运行时依赖 + 真相层可读明文」冲突；1000 段规模下 JSONL 够用，实测 bench 未触及瓶颈。若 v1.3 真到万段再评估。 |
| 「自动每轮 capture」 | 五路一致反对，BC 与宿主数据也表明自动路径是事故高发区；保持手动 + 阈值提示。 |
| 「让模型判断段落边界作为默认」 | 默认 off，只保留 `--ask`。 |
| 「brief 里放完整 8 段」 | 与「30 秒接上」冲突；`--full` 才展开。 |

## 四、计划 v2 相对 v1 的实质变化

1. **新增 B0（阻塞批）**：先修 transcript 读取（slug / 多帧 / schema），带真实会话 fixture；不修完 B1 不许开工。
2. **存储位置变了**：段从「memory record + kind=context」改为「任务目录下的独立 append-only 文件」，memory record 只保留晋升项。好处：不撞 `MAX_VALUE`、不进 kind 注册、不参与衰减/配额/去重判 disputed、回滚到 v1.1 时只是被忽略。
3. **close 不阻塞**；捕获失败降级告警。
4. **脱敏与投毒检测进写段路径**，可疑段隔离、不进简报、不进注入。
5. **评测拆两路**：原文一致性（CLI expand）与简报脱敏/可用性（MCP brief）分开断言；ground truth 前置。


## 五、与 future-architecture 的六处口径冲突（v2 已解决）

| 冲突 | future 计划口径 | v1.2 v1 的问题 | 处置 |
|---|---|---|---|
| 目录撞名 | §5.4 `~/.memo/tasks/*.jsonl` = **P3 审批队列** | 我把账本也放 `tasks/` | 账本改 `sessions/<taskId>/`；`tasks/` 留给审批 |
| 晋升白名单 | §5.2 session 晋升只允许 `decision/gotcha` | 我曾提议把 `fact` 加进白名单 | **驳回**，维持 decision/gotcha |
| 注入边界 | I-11 T2 默认不注入原文，只注入结构化抽取 + 围栏 | brief/pre-step 直接注入段文本 | 段带 `trust/taint`；被污染段只出结构化字段 |
| 锁 | I-3 数据锁统一 `<memoHome>/.lock` | 未写；有自开锁风险 | B1 复用 `storage/lock.js` |
| 路径解析 | B6 只经 `config/paths.js#resolveMemoHome` | 计划里直接拼 `$MEMO_HOME` | 新增 `sessionSegmentsPath` |
| 工具面 | §5.5 默认面 ≤4（search/write/brief/pack） | 新 MCP 工具会挤进默认面 | `memory_session_brief` 归 `--session-tools` |

另两条借它顺手修：brief 渲染改成**纯函数 + clock 注入**（为 P1 pack 的 I-6「同 asOf 逐字节相等」留位），`meta-check` 把新代码里的 `versions/vX.Y` 字面量纳入检查（P0a-3）。
