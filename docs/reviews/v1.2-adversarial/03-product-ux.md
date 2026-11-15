# v1.2 计划对抗性审核 · 产品与真实工作流（红队 #03）

> doc-kind: history
> doc-version: 1.2
> 说明：本文件是对特定时点计划/代码的审核快照，内容冻结（引用当时的 versions/v1.1），不随版本升级改写。

审核对象：`docs/plans/v1.2-task-context-ledger.md`（L1–106）+ 4 份 2026 调研 + v1.1 会话/记录/写路径/Web/UI/插件代码 + 本机 DSH 转录实测 + 现有 docs/06 契约。
角度：用户诉求「跨会话任务开发，上下文不丢，能快速接上」。纪律：每条给证据/影响/修法；无证据标「未验证」；未运行仓库测试（只读审核）。

**结论**：方向对（段可展开 + brief 是正解），但计划把"账本会被读"当成默认真，而入口、所有权、以及两份关键前提（transcript 可读、段装得下 8 段）都没落实。按现稿实现，最可能的结局是：捕获在真实宿主上产 0 段、close 被强制 capture 卡死、UI 无数据可展示、新 agent 仍不知道账本存在——即重复 `hintTokens` 死配置的命运。

## 发现清单

| # | 严重度 | 发现 | 证据（file:line / 计划行） | 影响 | 修法 |
|---|---|---|---|---|---|
| 1 | **高** | 计划 L57 前提不成立：`transcript.js` 读不了本机 DSH v4 转录（三重失效） | ①slug 不符：`transcript.js:86-88` 按 cwd 单横线折 slug，实测 node 算 `-Users-yeager-work-yeager-ldywoker`，实际目录 `--Users-yeager-work-yeager-ldywoker--`；②多帧：`transcript.js:93` 单次 `zstdDecompressSync`，实测该文件 30 个 zstd frame，node 只解出 **289B/1 行**，`zstd -dc` 才是 **785,569B/68 行**；③事件形状：`transcript.js:17-47` 只认 `user_message/assistant_message` 或 `payload.role`，DSH v4 是 `type:"user/message"`/`"assistant/message"` + `data.content[]` → `toTurns=0` | B1 核心在真实宿主产出 0 段或直接 `E_TRANSCRIPT_UNAVAILABLE`；叠加 L60「close 前未 capture 就拒绝」= 任务关不掉，用户被迫绕过或删库（见 #6） | L57 改为「需先修」并单列 spike：slug 扫描 `sessions/*/<id>` 再用 header.cwd 校验；按 frame 循环解 zstd；按 v4 事件形状解析。I53 fixture 换成真实 v4 转录，"已能解 zstd 多帧"删除 |
| 2 | **高** | 账本没人读：open 任务对新 agent 不可发现，唯一强制入口是手抄一段 AGENTS | 计划 L70-72（brief 需 `session:<id>`；pre-step 注入默认关；只改 `configs/AGENTS.snippet.md` 与作者本机 `~/.codex/AGENTS.md`）；`mcp/session-tools.js:65-74`（scope 非 session 直接 E_INVALID_ARG）、`:258-399`（无 list/brief 工具）、`:379-397`（sweep 只报 >14 天僵尸，不是 open 列表）；`web/scopes.js:44-46`（session 不进分库）；`plugin/dsh-sedimem/lib/pre-step.js:42`（注入默认关）、`inject-core.js:164`（只读 `brief/<scope>.md`，永远看不到任务库） | 最坏情况成立：账本存在但没人读。新会话/子 agent 不知道任务 id，"第一步 memory_session_brief" 无法执行；人类不开本机观察台就无感知 | ①`memory_session_list`（open 任务 id/标题/最后活动/未入账段数）；②`memory_brief` 末行加元数据「open 任务 N 个，最新 <id> <title>；开工先 memory_session_brief」（是元数据不是内容，不违 I56）；③有 open 任务时 pre-step 默认注入 ≤1200 字 brief（复用 `systemPrompt.context` 现成接缝）；④AGENTS 片段同时落 `~/.claude/CLAUDE.md` 与 DSH 全局指令，并进 `verify-three-clients.sh` 断言 |
| 3 | **高** | 段数据模型与 record 硬上限冲突：8 段结构化字段塞不进 `value` | 计划 L36-43（value 含 files/decisions/gotchas/pending/nextSteps/errorsAndFixes+anchor）、L36（text ≤400 字）；`record.js:18-20,42-46,85-98`（value 生效上限 = min(policy, MAX_VALUE=2000)，**只能降不能升**）；`checkpoint.js:19-21`（8 段合计允许 8000 字） | 稍详细的段直接超 2000 字被拒/被砍；若退回"只写 400 字摘要"则 files/decisions 结构化字段无处可放，brief 与 I53（3 决策/2 卡点/3 文件）都过不了 | §1 写死选择：`value` 只放 seq/区间/tokens/anchor 等元数据；8 段内容①拆成同 scope 的多条 context 子记录（`predicate=seg#N/files` 等），或②text 放宽到 ≤400 字摘要 + 关键项各 1 条独立记录。二者都不行则必须先改 `record.js` 契约（本轮计划未含） |
| 4 | 中高 | 三份摘要并存、无优先级/覆盖声明，会双重记忆互相污染 | 计划 L5「不靠宿主压缩」但 L21/§3 又要求新会话读 brief；`docs/research/host-compaction-2026.md`（DSH 压缩摘要以 `<compacted-summary>` user message 8 段注入）；`plugin/dsh-sedimem/lib/inject-core.js:164`（nightly `brief/<scope>.md` 每步注入）；计划 L84 的 I53 只测"新会话只读简报"，不含"宿主已压缩 + brief 并存" | agent 同时拿到宿主压缩摘要、nightly brief、task brief 三份口径；旧摘要可能压过账本，用户观感是"记忆又冲突了"，信任下降 | brief 头 3 行声明「账本覆盖 transcript seq X..Y（时间）；宿主压缩摘要可能更旧，冲突以账本+原文为准」；I53 增加"宿主已压缩 + brief 并存"用例；docs/06 补「三份摘要谁优先」一节 |
| 5 | 中高 | 任务库所有权/作用域没有模型：真实多 agent 下谁建、重名、同时开两个任务都会乱 | `ui/index.html:105`（"关闭走 CLI，这里负责浏览与清理"）、`ui/session-view.js:211,267`（UI 只能看/改名/删）；`mcp/session-tools.js:249-253`（`memory_scope use` 持久化切换，全客户端生效）；`lifecycle.js:55-67`（session scope 禁写 fact）；`docs/06-usage.md:515-517`（提示"请把它设为当前写库 MEMO_SCOPE=…"）；计划 L21 只说子任务继承、无机制；`listSessions` 无同名/同 repo 检查 | 一次只能有一个"当前库"：开任务后长期事实写进任务库（fact 被拒、其余 close 时 tombstone）→ 双写污染；父/子 agent 共用常驻 MCP 进程时谁切 scope 谁影响别人（"未验证 DSH 是否共享进程"，但 scope 持久化设计使其很可能）；两个 agent 可建同名任务 | ①不靠全局切 scope：capture/brief 全显式传 scope（计划已如此），`memory_brief` 输出"当前任务=X"；②`memory_session_start` 前查同名/同 repo open 任务并警告；③UI 加"当前任务"标记，不要求用户改 MEMO_SCOPE；④写 fact(session) 的错误信息直接给切回主库的一行命令 |
| 6 | 中高 | close「未 capture 就拒绝」与 UI 一键删任务并存 → 用户会选删除，账本整库进 trash | 计划 L60（拒绝并提示）、L51（remove 会让段消失）；`ui/session-view.js:267,380`（"删除任务库…不可撤销"）；`cli/session.js:329`、`mcp/session-tools.js:196`（close 时其余全部 tombstone） | 最想"不丢上下文"的人，在 close 被拒后走删除，损失大于不做；且 close 与删除都不可逆感强 | close 改为**自动先 capture 再 close**（capture 失败才拒绝，另给显式 `--discard`）；删除前检查未入账增量，提示先 capture/导出 |
| 7 | 中高 | 「段永不 tombstone」（裁决 116）与现有 close/quota 路径冲突，且跨批写盘不闭合 | 计划 L51、L60、L95-96（B1 只改 lifecycle.js，无 close 实现文件）；`cli/session.js:329`、`mcp/session-tools.js:196`（close tombstone 全部非晋升）；`write-path.js:132`（每次 created 后 `enforceQuota`）+ `policy.json:45`（maxActive=5000）；三批均不含 `src/web/*` 与 nightly | 段可能被配额/close 静默 tombstone，brief 变短而用户以为记了；"close 强制 capture"落在 B1、代码在 B2，批次互不重叠的承诺不成立 | 把 close 的段豁免与 quota 豁免写进同一批（B1 或 B1 依赖 B2 的 close 改动），nightly 过期对 context 段显式跳过；加 I 用例「quota 压顶/close 后段仍在」 |
| 8 | 中 | B3 的 UI 数据在 `/api/tasks` 里没有，且三批都不改 Web API | 计划 L76-79（段数/累计 tokens/上次 capture/下一段阈值）、L95-97（B1/B2/B3 无 `src/web/*`）；`web/api/write.js:151-154`（apiTasks 仅透传 listSessions）；`ui/session-view.js:5`（现有字段清单）；计划 L22 的 archive 状态位同样需要 API 过滤 | B3 做不出来或前端自行拼数据，又一套口径；archive/restore 无后端字段 | B1/B2 内把 `/api/tasks` 扩字段（segments/tokens/lastCaptureAt/captureThreshold/archived）并写进 batch 表，B3 只读消费 |
| 9 | 中 | brief 没有硬预算与降级顺序，且与自己的 ≤1200 字符注入矛盾 | 计划 L68（3×400+Top10+Top5，无总长上限）、L72（注入 ≤1200）；`docs/research/cross-session-handoff-2026.md`（claude-mem 教训：必须渲染-测量-递减，不能按条数配预算） | 最坏 3–7K 字符，"30 秒接上"变"扫三屏"；注入版与 CLI 版两套格式必然漂移 | brief 规格加：默认总长 ≤2000 字符，超限按固定顺序丢（段→files→decisions，保底 title/pending/nextSteps）；注入与 CLI 共用同一渲染器，`--full` 才放开 |
| 10 | 中 | brief 缺"用户已否决/纠正了什么"与"怎么验证"，而这正是压缩最先丢的 | 计划 L37-43（段字段无 userCorrections/directives）、L68（无 branch/SHA/最后验证命令）；`docs/research/task-context-ledger-design.md`（压缩丢的恰是用户纠正与试错过程） | 新 agent 重复已被否决的方案，用户第二次被纠正同一件事，信任损失比"没记忆"更大 | 段加 `directives[]`（用户原话 ≤200 字，规则抽取匹配"不要/必须/改成/否决"）；brief 头三行加「分支 / 最后验证命令 / 当前结论」 |
| 11 | 中 | 与已有 handoff 工件重复且会漂移，计划全文未提 handoff 如何处置 | `docs/06-usage.md:568-569,611`（close 写 `<memoHome>/handoffs/<id>.md` 六节）、`cli/session.js:309-310`；计划 L65-72 无 handoff | 老用户/agent 继续读 handoff，新 agent 读 brief，两份同语义产物慢慢不一致；写入成本翻倍 | handoff 降级为"brief 的 close 快照"（由 brief 渲染），或直接由 brief 取代并在 docs/06 标注；close 输出指向 brief |
| 12 | 低 | 命名与路径混淆：`memo capture`（已有候选抽取）vs `memo session capture`；`taskId` 实际就是 session id；§6 写 `src/...`/`ui/...` 但代码在 `versions/v1.2/`，且 `versions/v1.2` 尚不存在、根目录无 `src/`/`ui/` | `cli/capture.js:1-3`（D3 已有 `memo capture scan/list/accept/reject`）；`lifecycle.js:34`（id=`YYYYMMDD-HHmm-<4hex>`）；计划 L56、L95-97；`ls versions/` | 实现者按错路径写；命令行与 UI 的心智模型（任务/session/会话）三套词 | 改 `memo session fold` 或 `session capture --segment`；§6 写清相对 `versions/v1.2/`；文档统一一句"任务=session scope" |
| 13 | 低（未验证） | 单机/单人边界未声明：MEMO_HOME=~/.memo、无同步，计划未说"多 agent=同一台机器" | `configs/claude-mcp.sh`（MEMO_HOME=~/.memo）、计划全文无同步/共享说明 | 若用户按字面理解"多人协作共享账本"会落空；若只承诺单机则应写明 | §0 加一句边界：本机单用户、多 agent 共享同一 MEMO_HOME；跨机器同步不在 v1.2 范围 |

## 最小可用改进清单（按性价比排序）

1. `memory_brief` 末尾加一行 open 任务元数据（零 schema 改动，直接补上"发现入口"，成本 ≈10 行）。
2. 新增 `memory_session_list` MCP 工具（复用 `listSessions`，顺手解决"任务 id 从哪来"）。
3. 有 open 任务时 pre-step 默认注入 ≤1200 字 brief（复用插件现有 `systemPrompt.context` 接缝，改默认值，不加新机制）。
4. brief 定死 ≤2000 字符硬预算 + 固定降级顺序，注入与 CLI 共用渲染器。
5. close 改为自动先 capture 再 close（失败才拒），删除前提示未入账。
6. 段记录契约定死：`value` 只放元数据，8 段内容拆子记录或走 text 摘要（消除 #3 的 2000 字冲突）。
7. brief 头三行补「覆盖 seq/时间 / 分支 / 用户约束与否决」。
8. I53 fixture 换真实 v4 转录，并加"宿主压缩摘要 + brief 并存"用例。

## 我认为计划必须改的 3 条

1. **把 L57 降级为 spike 前提**：transcript 读取在真实 DSH v4 上是三重坏的（slug/多帧/事件形状），不先修就当 B1 已完成，等于把整个 v1.2 建在空地基上；而 L60 的 close 强拦截会让真实用户直接卡死。B1 必须含修复 + 真实 fixture，L57 改写为"需修"。
2. **把"谁读账本"从文档约定改成产品机制**：`memory_session_list` + `memory_brief` 任务元数据 + open 任务时 pre-step 默认注入。不加这条，v1.2 会精确重演 `policy.json:132 hintTokens=30000` 的死配置命运——能力做了、无人触发。
3. **四处相互矛盾的契约必须先定死再开工**：capture 时机（close 自动 capture 而非拒绝）、段字段与 `record.js` 2000 字硬顶的兼容方案、brief 硬预算/降级顺序、宿主摘要与 brief 的优先级。现在这四处计划各说各话，实现者只能各自发明，最后又变成"账本存在但没人读"。
