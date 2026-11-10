# CHANGELOG · v0.4

## [0.4.1] — 2026-11-10

补丁版：修掉一个会让成功命令看起来「失败」的入口 bug，并把 CodeQL 告警清零。

### Fixed

- **CLI 退出码崩溃**：`memo capture ...`、`memo conflicts` 等分支会把结构化 payload 当作 `main()` 返回值，
  而入口直接 `process.exitCode = await main()` —— Node 对非数字赋值抛
  `ERR_INVALID_ARG_TYPE: The "code" argument must be of type number`，于是命令**已经成功**却打印
  `memo 失败 [...]` 并以 1 退出。现在只接受整数退出码，其余保持 0（`src/cli/memo.js`），
  并新增回归测试 `tests/unit/cli-exit-code.test.js`（真 spawn CLI）。
- **CodeQL 新告警**：`inject.js` 的 brief 读取改成「open 句柄 → stat → read」（消除 stat/read 竞态）、
  `vector-index.js` 的 rewrite 改为「独占临时文件（wx + 0600 + fsync）→ rename」、
  `embedder.js` 端点 URL 显式校验只允许 http(s) 且有 host。

### Changed

- CodeQL 扫描范围收敛：审核留证脚本 `versions/*/reviews/probes/**` 与插件生成物
  `plugin/dsh-sedimem/lib/{inject-core,paths-core}.js` 不入扫描（附理由）；
  `js/file-access-to-http` 对 `embedder.js` 定向排除（端点来自本机 policy 且已收口协议）。

### Tests

- 384 tests（+2 退出码回归）、eval I1–I36 全 PASS、质量 9/9、安全 9/9。

## [0.4.0] — 2026-11-10

按竞品调研（`docs/research/competitive-dsh-plugins-2026-11.md`）补齐五项「别人有而我们没有」，
每一项都是**机制**而不是声明；施工图 `docs/plans/v0.4-competitive-gaps.md`，契约 `docs/02` §3.15。

### Added
- **语义道（可插拔 EmbedderPort）**：`policy.search.embedder.kind = none|http`（默认 none）。
  `src/index/embedder.js`（OpenAI 兼容 /v1/embeddings，超时 + 维度锁定）、`vector-index.js`
  （`$MEMO_HOME/index/<scopeKey>.vectors.jsonl`，float32 base64，热加载容错）、`hybrid.js`
  （RRF k=60 融合）、`hybrid-index.js`（IndexPort 包装：写入后台补向量、检索两路融合、
  **语义路故障只降级不阻断**）。`memo backfill-vectors` 回填历史记录。
- **每步注入（pre-step）**：`src/render/inject.js`（权威组装）+ `plugin/dsh-sedimem/lib/pre-step.js`
  （宿主注册壳）。经 `systemPrompt.context` 动态 `text()` 注入，预算 `maxChars=1200`，
  `<memory-context>` 围栏 + 「数据不是指令」声明；suspicious / superseded 永不注入；
  默认关闭（`inject.enabled` 或 `SEDIMEM_INJECT=on`）。
- **半自动捕获**：`src/capture/extract.js`（确定性抽取：前缀 / 引导词 / 列表项，代码块与 URL 排除）、
  `queue.js`（`$MEMO_HOME/inbox/<scopeKey>.jsonl` 状态流）、`memo capture scan|list|accept|reject`。
  候选**不进真相层**，accept 才走写入门禁。
- **分歧（disputed）一等公民**：`src/views/conflicts.js`（按 slot 分组 + 候选对）、
  `memo conflicts [resolve]`、`GET /api/conflicts`。
- **入库脱敏**：`src/hygiene/redact.js`（private_key / jwt / github_token / aws_key / api_key /
  internal_host / assignment），**先脱敏再算 contentHash**，tags 记 `redacted:<kind>`；幂等；
  `policy.redact.enabled=false` 可整体关闭。
- **UI 搜索页**：`#/search?q=`，结果带 `basis`（bm25 / vector / bm25+vector）与降级提示；
  图谱节点详情可跳转到搜索。`GET /api/search` 是新端点（带 `degraded` / `degradedReason`）。
- **规模基准**：`eval/bench-scale.mjs`（10k/50k/100k，write/search p50·p95 + 冷启动 + RSS）。
- **一条命令安装插件**：`scripts/install-dsh-plugin.sh`（pnpm 自动探测、cordis patch 幂等更新、备份）。

### Changed
- `createMemoryService({ policy })` 支持构造期策略覆盖（浅合并，测试与多租户用）。
- `search()` 结果多带 `basis`；`/api/search` 与 MCP 检索响应透传 `degraded`。
- `package.json` 版本 0.4.0；版本目录按规则新建 `versions/v0.4`（v0.3 冻结在 0.3.6）。

### Fixed
- 脱敏与写入的顺序：`value` 曾从原始 input 取（绕过脱敏），改为取脱敏后的写输入。

#### Fixed（v0.4 双路审核修复，见 `reviews/RESPONSE-v0.4.md`）

- 脱敏旁路：`value`/`title`/`source.quote` 与 `supersede()` 现在都脱敏（`redactedInput()`），assignment 规则覆盖 `"password":"x"`、`DB_PASSWORD=`、嵌套 JSON。
- 注入越权：围栏标记转义、按 id 折叠只注当前版本、`suspicious` 永不注入、预算不足不输出。
- 分歧超组：自由文本不再构成 slot 分歧，`resolveConflicts` 明确拒绝。
- 捕获队列并发：同步互斥锁 + 原子 rename，两进程 200 条不丢；坏行只跳过不阻断。
- 向量模型隔离：换模型后旧向量被跳过并清理；hybrid `add` 兼容单参调用（在线写入立即产向量）。
- 裁决不能复活墓碑：`curateApply` 拒绝 `tombstoned`（含 MCP 路径）。
- `/api/conflicts` 载荷上限：`limit`（默认 50/上限 200）+ 单 slot 候选对 200，带 `truncated` 标记。

## Known limits
- 语义道默认关闭，且**没有内置本地模型**（要自己给一个 OpenAI 兼容 embedding 端点）；
  未配置时所有检索 `degraded=true / semantic-disabled`，UI 如实提示。
- 每步注入只服 DSH 宿主（`systemPrompt.context`）；Codex / Claude 需靠 AGENTS.md / CLAUDE.md 指引。
- 捕获是启发式（引导词/前缀/列表），不判断语义重要性；候选仍需人/Agent accept。

## [0.3.6] – 2026-11-10

### Added
- 观察台 UI **跟随系统外观**：`prefers-color-scheme` 双主题（浅色为默认，深色自动切换）；画布配色经 `ui/palette.js` 每帧取自媒体查询，系统切换无需刷新。
- 插件 `screenshots.json` + 3 张截图（市场详情页展示）。

### Fixed
- 徽章/详情面板/错误条底色此前硬编码深色 → 全部改 `color-mix` 主题变量；SVG 图表轴/网格改 CSS 变量。

## [0.3.5] – 2026-11-10

### Added
- **DSH 插件 `plugin/dsh-sedimem`**（独立包 v0.1.0）：侧边栏「记忆中心」+ 中列 iframe 整页嵌入观察台。宿主侧优先复用已常驻观察台（`observerUrl`，必须回环），不可达才 spawn 内嵌副本兜底；`api/dsh-sedimem/ui` 前缀反向代理（同源）+ `/api/dsh-sedimem/health`；栅栏与 skill-explorer 同款（回环 socket/Host、无转发头、非跨站）。MCP `memory_*` 链路与三端配置不动。5 条宿主测试（外部纯代理 / 内嵌兜底 / 双栅栏拒绝 / 内嵌副本哈希防漂移）。

### Fixed
- 观察台 UI 的 API 基址从根绝对 `/api` 改为文档相对 `api`（`ui/app.js`、`ui/graph.js`）：根路径部署行为不变（实测 200），子路径代理（DSH iframe、反代）不再 404。服务端补 `…/ui` → `…/ui/` 301，防相对路径解析到父路径。


## [0.3.4] — 2026-11-10

### Changed
- **项目更名：strata → sedimem**（`sediment + memory`）。GitHub 上名字含 `strata` 的仓库有 7432 个（其中 `Niko1221/Strata` ⭐42537、`mjackson/strata` ⭐364 同名），npm 的 `strata` 也已被占用；`sedimem` 在 GitHub 同名仓库数为 0、npm 未占用。
- 仓库、本地目录、Pages 地址（`old-friends-gathering.github.io/sedimem/`）、三端客户端配置、launchd 标签、现有记忆分库（`repo:strata` → `repo:sedimem`）同步迁移。
- 技术标识按既有兼容策略保持不变：CLI `memo`、`MEMO_HOME`/`MEMO_*`、MCP 工具 `memory_*`、`serverName: memo`。
- 顺带修掉各版本 `package.json` 的 `repository.directory`（v0.2/v0.3 一直被历史拷贝写成 `versions/v0.1`）。

## [0.3.2] — 2026-11-09

### Fixed
- **图谱密集时标签不可读**：83 个节点的知识库 fitView 后 scale≈0.3，标签有 `scale>=0.45` 硬门槛 → 一个都不画；半径线性缩到 ~1px。改为半径 `scale**0.6` 且 ≥2.2px、标签屏幕空间绘制 + 重叠跳过（按 count/hits 优先，宽 ≤132px）、`n>40` 时斥力按 `sqrt(n/40)` 放大。同一视口：0 个标签 → ~35 个可读且无叠字。
- **今日页把「改标题」画成英文 op**：`retitle`/`retitle_apply` 未在 `OP_LABEL` 里，且 label 拼了正文。改为「改标题/回填标题」徽标，label 只给标题本身。

### Changed
- 已有记忆批量回填标题（本机 5 个分库 145 条）：标题由 Agent 读正文后写，规则只做形状校验与幂等落盘（`memo retitle --from-file`）。

## [0.3.1]

### Added

- **记录新增 `title` 字段**（裁决 59）：1–40 字符、单行，写入方给的「人能读懂的一句话」。
  `memo write --title`、MCP `memory_write.title`、`normalizeTitle()` 归一化（折单行 → 截 39+`…`）。
  没有标题就不落这个键——空串与缺失必须能区分。
- **`memo retitle` 回填**（issue #61）：按 subject 人性化生成标题（`_`/`-`→空格、剥离尾部日期 slug），
  以追加补丁行方式写回真相层（不原地改），`--dry-run` 只报告。已有库据此一次性补齐标题。

### Changed

- **label 规则 v2**（裁决 59）：`title` → 结构化退回 `subject`（下划线折空格）→ 非结构化退回正文首句
  （去「我刚刚/你看/就是」口语前缀）。`predicate` 不再进 label；label 上限 24 字符。
- **brief 行首改用 title**：更短更好扫，正文靠 `memory_search` 下钻；无 title 的旧记录行为不变。
- **图谱按 subject 聚合**（裁决 60）：同主题多条记录合并成一个点，显示 `×N`，详情面板列 `predicates`。
  `Σcount === sampled.records` 是不变式；`same-entity` 边随之消失，其它三类边做 recordId→nodeId 映射并丢弃自环。

### Fixed

- 图谱 51% 节点重名（实测 118 条库里 60 个节点同名，最狠 `×7`）：根因是 `subject/predicate` 拼串被截到 16 字符，
  且记录里根本没有「标题」这个概念。

## [Unreleased]

### Fixed

- **Windows：真相层被写成 NTFS 备用数据流**（裁决 58）。`items/<scope>.jsonl` 的 scope 恒含 `:`，
  Windows 把 `:` 当数据流分隔符，`items/repo:sedimem.jsonl` 实际是文件 `repo` 的一个数据流：
  `readdir` 看不见它（分库列表 0 条、Web 下拉缺项）、`rewriteScope` 的 `copyFile` 直接 `EINVAL`
  （`compact` 崩溃）、备份与压缩不保留数据流（真相层静默丢失）。
  新增 `config/paths.js` 的 `itemsFileName` / `briefFileName` / `scopeFromItemsFileName`：Windows 上把
  scope 的 `:` 换成 `+`（`repo+sedimem.jsonl`），POSIX 保持 `<scope>.jsonl` 字节不变。
  `JsonlStore`、`web/scopes.js`、`cli/nightly.js` 与测试一律改为引用这一处。
- 测试里 15 处硬编码的 `items/${scope}.jsonl` 改为 `itemsFileName(scope)`（POSIX 上路径等价）。

### Docs

- `docs/06` 增补 Windows 落位：计划任务 + VBS 隐藏启动，以及两个实测坑——action 直接写 `node.exe`
  会弹控制台窗口、`StopOnIdleEnd` 默认为 `true` 会在空闲时把服务停掉（退出码 0，伪装成"自己挂了"）。

## [0.3.0]

### 目录调整（按版本规则纠正）

`0.3` 属于 `X.Y`（minor）变更，**必须新建目录**：本版起代码在 `versions/v0.3/`，`versions/v0.2/` 冻结在 `0.2.1`。
规则原文：**`X.Y` 换目录，`X.Y.Z` 补丁同目录递增**（`0.3.0 → 0.3.1` 都在 `versions/v0.3/`）。
`versions/CURRENT` 已指 `v0.3`；三端客户端配置（DSH / Codex / Claude）与 launchd 入口（`scripts/sedimem-run.sh` 读 CURRENT）自动跟随。
 - 2026-11-07（分层视图：L2 场景块 / 注入分级 / L3 画像）

> 依据 `docs/research/layered-memory-2026.md` 与 `docs/plans/v0.3-layered-views.md`：
> **结构层用确定性算法、LLM 只写可重算的表述层；注入分级 + 每层硬配额；L3 固定预算 + 强制溯源。**

### Added

- **L2 场景块**（#50）：`src/views/l2.js` 把记录按 slot 分组、对无结构记录做相似度聚类，
  产出 `$MEMO_HOME/views/<scopeKey>/L2.jsonl`。`blockId = sha256(key)[0:12]`，`builtAt` 取记录最晚
  `createdAt`（不用时钟），因此**同一真相层两次构建字节相同**，删目录后 `memo view rebuild` 可逐字节复原（I21）。
- **注入分级**（#51）：`memo brief --tier0` 输出「一条一行」的目录（≤`brief.tier0Chars`=800 字符），
  每行带**完整 ULID** 供 `memory_get` 反查（证据链）；完整 brief 支持按 `brief.quota`（L2/L3 份额）分层，
  受 `brief.totalChars`=8000 总上限约束，超限按「散条 → L3 → L2」顺序砍。视图缺失时自动降级为扁平渲染。
- **L3 画像**（#52）：`src/views/l3.js` 的 `planL3/validateL3Draft/buildL3Record/traceL3`；
  `memo view l3 plan|apply --file`。强制 `sourceRefs`（空即拒）、`text ≤2000`、`confidence ∈ (0,1]`；
  预算 `policy.l3 = {maxCallsPerRun:20, batchSize:10, ttlMs:30d}`；TTL 用 `expiredAt` 表达（保 active 不变式）。
- **溯源字段 `sourceRefs`**：`core/record.js` 新增可选字段 + 强校验（非空 ULID 数组、无重复、不得自引）；
  `memo view trace <id>` 同时给出「属哪个 L2 块」与「L3 出处里的失效/缺失」。

### Changed

- `renderBrief` 支持 `blocks` 分层渲染，**旧单对象签名与输出保持字节一致**（视图是加速层不是依赖）。
- Q2 源码总量上限 8000 → **9000**（新增 4 个模块共 854 行；单文件 900 行硬线不动）。
- 版本 0.2.1 → **0.3.0**（`versions/CURRENT` 仍指 `v0.2`：小版本同目录递增，大版本才换目录）。

### Tests

- 258 tests / 258 pass；eval **I1–I23 全 PASS**（新增 I21 视图重建、I22 配额、I23 L3 预算）。

## [0.2.1] - 2026-11-06（拆分 / 数据化 / 裁决器 / 压实 / 检索指标）

### Added

- **`JudgePort` + `memo curate auto`**（#34）：`src/hygiene/judge.js` 的 `createJudge({policy})` 注入点，内置
  `ruleJudge`（确定性、无 LLM）；`service.curateAuto({limit,dryRun})` 一条命令跑完 scan→判→apply，
  幂等、可 `--dry-run`。规则：strong 且同 slot 比 hits，其余一律 keep_both（宁漏不误杀）。
- **`memo compact`**（#35）：唯一会物理删除的入口。只删「墓碑 + `purge` 标签 + 超过 grace」三重条件的记录；
  `JsonlStore.rewriteScope()` 走「备份 → tmp → fsync → rename」原子替换，`events.jsonl` 永不删。
- **检索健康指标**（#36）：`search` 事件（`hits/topScore/staleHits/qHash`，**不存 query 原文**）；
  nightly metrics 新增 `searchCount/noHitRate/staleHitRate/avgTopScore`，**无数据写 `null`**；
  卫生页趋势图加「检索空结果率」「检索命中过期率」两条线（null 点跳过，不画成 0）。

### Changed

- **`src/api/service.js` 898 → 130 行**（#32）：拆出 `lifecycle/write-path/search-path/maintenance` 四个承接模块，
  `MemoryService` 公开方法集合、签名、返回形状、错误码零变化（prototype 34 项对象 diff 为空）。
- **`kind` 成为数据**（#33）：唯一真相是 `config/policy.json` 的 `kinds` 段（`halfLifeMs/weight/color` 三合一）；
  `record.js` 不再硬编码清单，UI 配色改从 `/api/summary` 取。新增 kind = 只改 policy。
- `memo forget --purge` 现在给墓碑打 `tags:['purge']`（否则 compact 永远删不掉它）。

### Tests

- 187 → **208 tests**；新增注入用例 **I18**（curateAuto 收敛+幂等）、**I19**（compact 真删 + events 仍在）、
  **I20**（指标口径与 null≠0）；eval 扩到 I1–I20，全 PASS。
- 修掉 `--dry-run` 失效的真 bug：CLI 的 `parseArgs` 存的是 `dry-run`（连字符），旧代码读 `opts.dryRun` 永远 undefined。

### 双审核后的加固（2026-11-06）

架构 + 对抗两路审核（glm-5.3）各报严重项，逐条修掉并补了守它们的测试：

| 问题 | 处置 |
|---|---|
| 注入的 `judge` 被静默忽略（读 `svc._judge`，实际只设了 `svc.judge`） | 统一读 `svc.judge`，并补「注入即生效」单测 |
| kind 只做了清单数据化，权重/半衰期仍读旧段（两份真相） | `search-path` 走 `kindMeta`、`quota` 与 `decay` 从 `policy.kinds` 派生 |
| `--json` 两个新子命令都不出 JSON（键名 `asJson` vs `json`） | 统一键名；顺带让 compact 的 grace 缺省走 policy |
| scope 直接拼文件名，`MEMO_SCOPE=../x` 能把库写出 items/ | `isSafeScopeName()`：禁分隔符/NUL/前导点，但保留空格与大小写 |
| 备份「先删旧再写新」的空窗 | 改成先写新备份、rename 成功后再删旧 |
| `supersede` 能复活墓碑，打断 purge 语义 | 墓碑一律拒绝取代 |
| `validateKinds` 放过 `"1.3"` 字符串 | 改 `Number.isFinite` |

### 契约

`docs/02` 新增 §3.13 裁决 48–52（拆分不改语义 / kind 是数据 / 默认裁决器必须确定性 / 只有 compact 能物理删 /
指标 null≠0）。

## [0.2.0] - 2026-11-03（大版本归位：目录 versions/v0.1 → versions/v0.3）

### Changed

- **版本目录按大版本切换**：v0.2 线独占 `versions/v0.3/`，v0.1 线冻结在 `versions/v0.1/`（0.1.2 快照，见其 `FROZEN.md`）。
  约定：**大版本换目录，小版本在同一目录内递增**。
- `versions/CURRENT` 指明当前开发/门禁/评测的版本（`v0.2`），工具与 CI 都读它，不再硬编码目录名。

### Note

本次之前打在 0.1.3–0.1.6 的四个增量，实质都是 **v0.2 线的工作**（现实上按小版本发在了 v0.1 目录里）：

| 原版本 | 内容 | 归位后 |
|---|---|---|
| 0.1.3 | 只读 Web 观察台（今日/图谱/卫生）+ I13–I15 | v0.2.0 |
| 0.1.4 | SQLite FTS5 索引后端 + curate 裁决任务包 + I16–I17 | v0.2.0 |
| 0.1.5 | 观察台多分库浏览（`/api/scopes` + `?scope=`） | v0.2.0 |
| 0.1.6 | 图谱页跟随分库切换 + 测试时区助手修复 | v0.2.0 |

下面三段保留原文（历史可查），此后 v0.2 线的小版本从这里继续递增。


## [0.1.6] - 2026-11-03（图谱跟随分库）· 归入 v0.2.0

### Fixed

- `ui/graph.js` 自己发 `/api/graph` 请求时**没带 scope** → 顶栏切了分库，图谱还是启动分库的图。
  现在 `initGraph({..., scope})` 把 scope 拼进查询串。
- `ui/app.js` 的 `currentRoute()` 用 `hash.replace(/^#\/?/, '')` 解析，`#/graph?scope=repo:x`
  被解析成 `graph?scope=repo:x` → 不匹配 ROUTES → **回落成 today 页**。改为只取 path 部分。
- `loadGraph()` 里 `if (graphApi) return`：同一路由下换分库直接复用旧实例。现在记住 `graphScope`，
  scope 变了就 destroy → 重新 init。
- 测试时区助手自己的 bug：`todayInTz()` 用「减偏移」，只在 UTC 16:00–24:00（CST 00:00–08:00）暴露
  → 上午跑 CI 就会红。改成「加偏移」，并在注释里写清为什么。

### Tests

- `tests/unit/web-scopes.test.js` 增 1 项：`/api/graph?scope=` 只回该分库节点、两库节点集不混。

## [0.1.5] - 2026-11-02（观察台多分库浏览）· 归入 v0.2.0

### Added

- `src/web/scopes.js`（`listScopes`）：从 `$MEMO_HOME/items/*.jsonl` 发现分库，返回
  `{scope, records, bytes, mtime, current}`；名字必须过 `SCOPE_PATTERN`，否则当成非分库文件忽略。
- `GET /api/scopes`：分库列表（按 mtime 降序；启动分库无文件也列出）。
- 所有 `/api/*` 支持 `?scope=<scope>` 覆盖启动分库：服务端按 scope 懒建 `MemoryService` 并缓存，
  `close()` 统一关闭。**scope 直接进文件路径，因此必须过 `SCOPE_PATTERN`；非法值返回 400 `E_INVALID_ARG` 且不触盘。**
- UI 顶栏分库徽章 → `<select>`（带记录数），切换写进 URL `#/today?scope=repo:x`，三页跟随。

### Why

用户开了 Codex 会话干活，观察台看不到任何记录——查下来 `~/.memo/items/` 只有一个分库
`repo:sedimem`，说明 Codex 一条都没写；而观察台本来就只服务启动时那一个分库，
即使别的项目写了另一分库也看不见。两个问题都修：观察台能切分库（本版），
写入规则从「用户说记住才写」改成「有实质产出写 1–3 条」（`~/.codex/AGENTS.md`，本机配置非仓库内容）。

### Tests

- `tests/unit/web-scopes.test.js` 3 项：分库列表/条数/current 标记、空库仍列出、`?scope=` 覆盖 +
  五类非法 scope（含 `../etc/passwd`）一律 400。

## [0.1.4] - 2026-11-02（SQLite FTS5 索引 + curate 裁决任务包）

### Added

- **SQLite FTS5 索引后端（IndexPort 第二实现，契约 `docs/09-sqlite-index.md`）**：
  - `src/index/sqlite-index.js`（262 行）：`SqliteIndex` 与 `buildMatchExpr`。与 `InvertedIndex`
    同一套接口语义（score>0 才返回、降序、同分按 id 升序、filter 打分后过滤、`limit` undefined 不截断、
    `add` 无 id 抛 `E_INVALID_RECORD`）。写入侧与查询侧共用 `core/hash.js` 的 `tokenize()`，避免
    unicode61 对中文切词不同导致的语义漂移；BM25 负分转正（`score = -rank`）。
  - `limit` **缺省默认 10**，与 `InvertedIndex` 一致（双审核 S1 修正：两个后端默认值相反会让
    「端口可替换」在边界上失效）；要全量请显式传 `limit: index.size`。
  - 单查询最多取 `MAX_QUERY_TOKENS = 256` 个 token（审核实测 50k 词项的 OR 表达式 848ms）。
  - 绕过 `build()` 直接 `search()` 抛 `E_INDEX_STALE` 而不是静默返回空（审核 S2 修正）。
  - `src/index/create-index.js`（69 行）：`createIndex({policy, memoHome, scope, clock})` 构造点收敛，
    `service.js` 只改了 import（`src/api/service.js:10`）+ 一行调用（`src/api/service.js:53`）——
    **IndexPort 可插拔性实测成立**（docs/03 §5 补扩展点验证结论）。
  - `config/policy.json` 新增 `index.backend`：`memory`（默认，行为与 0.1.3 完全一致）| `sqlite`。
  - 落盘 `$MEMO_HOME/index/<scopeKey>.sqlite`（WAL 模式，`scopeKey` 复用 `scopeKeyOf()` 裁决 39）；
    external content FTS5 + 三个触发器同步；索引是派生层，删掉后 `memo reindex` 或下次启动重建。
  - **fail-loud 不静默降级**：`node:sqlite` 缺失或 FTS5 被裁掉 → 启动即抛 `E_INDEX_UNAVAILABLE`
    （附修法提示）；首次成功创建打一句实验特性 warning（`MEMO_QUIET=1` 静默）。
  - 损坏自愈：打开时跑 FTS5 `integrity-check`（**不能**用 `count(docs_fts)` 比对——external-content
    表的 count 读的就是 docs 表，恒相等，是假检查），失败或 `SQLITE_CORRUPT` → 删库重建空索引 +
    `IndexRebuilt` warning（不碰真相层）。
  - 测试：`tests/unit/sqlite-index.test.js` 7 项（build/add 幂等、中英文命中、注入字符
    `"` `*` `OR` `(` `-` 不抛错、filter/limit 语义、`buildMatchExpr` 纯函数、删库重建）；
    注入用例 `tests/injection/i16-index-parity.test.js`（两后端检索一致 + 删库重建 + sqlite 落盘）。
- **curate 裁决任务包（契约 `docs/10-curate-auto.md`）**：
  - `src/cli/curate.js`（342 行）：`curatePrompt` / `curateStatus` / `curateApplyFile` /
    `validateDecisions` / `pairKeyOf` / `pairsFromScan` / `readBatchPkg`。
  - CLI 新增三条子命令：`memo curate prompt [--limit N] [--json]`、`memo curate status`、
    `memo curate apply --file <任务包.json>`（旧 `curate apply <batchId> --decisions` 与
    `curate export` 保持不变）。
  - 任务包落 `$MEMO_HOME/curate/<batchId>.md`（人读裁决表 + 全文对照）+ 同名 `.json`（机读，
    Agent 只回填 `decisions[]`，避免从 Markdown 反解析）。`pairs` 直接取 `service.dedupeScan()`
    返回（不二次计算相似度）；`strength` 只映射默认建议（strong→merge、weak→keep_both），不是判决。
  - 校验 V1–V5 全过才落盘（未知批次 / 非法 decision / ids 与任务包不符 / 重复 pair →
    `E_INVALID_ARG`，一条都不应用）；V6 并发被删 → 该条 `skipped` 不整体失败。
  - **幂等**：事件流 `curate_apply` 按裁决键（排序 ids，裁决 36 语义）聚合，已裁决 pair 重复
    apply 计 `skipped`、不重复写事件；`status` 同样用事件流判定进度，不靠额外状态文件。
  - **无候选时正常退出**：`curate prompt` 打印「当前没有待裁决的近重复候选」，不写文件。
  - **prompt 会收敛**：已裁决过的 pair 不再进新批次（对抗审核 S1：不过滤会让批次文件无界增长、
    「没有候选」分支不可达）；`batchId` 随机后缀 2→4 字节（1/65536 撞名会静默覆盖旧批次）；
    任务包里的 `nearDupThreshold` 取自 `policy.json` 而不是硬编码 0.85。
  - 测试：`tests/unit/curate-prompt.test.js` 7 项（空库、字段齐全、四类校验拒绝且库未变、
    重复 apply 幂等、status 三态）；注入用例 `tests/injection/i17-curate-loop.test.js`
    （prompt → 填 decisions → apply → 收敛 + 幂等重放 + 再扫描无簇）。
- 测试总量 **179 项**：单元 147 → 161（新增 14：sqlite-index 7 + curate-prompt 7），
  注入新增 I16/I17 两个；**I16 当前失败**（`service 检索应命中连接池两条` 断言，见
  `tests/injection/i16-index-parity.test.js:75`），待索引侧修复，其余 177 项全绿。

### Changed

- `src/api/service.js` 索引构造改为 `createIndex({...})` 单点注入（import + 一行调用，不改任何检索语义）。

#### Fixed（v0.4 双路审核修复，见 `reviews/RESPONSE-v0.4.md`）

- 脱敏旁路：`value`/`title`/`source.quote` 与 `supersede()` 现在都脱敏（`redactedInput()`），assignment 规则覆盖 `"password":"x"`、`DB_PASSWORD=`、嵌套 JSON。
- 注入越权：围栏标记转义、按 id 折叠只注当前版本、`suspicious` 永不注入、预算不足不输出。
- 分歧超组：自由文本不再构成 slot 分歧，`resolveConflicts` 明确拒绝。
- 捕获队列并发：同步互斥锁 + 原子 rename，两进程 200 条不丢；坏行只跳过不阻断。
- 向量模型隔离：换模型后旧向量被跳过并清理；hybrid `add` 兼容单参调用（在线写入立即产向量）。
- 裁决不能复活墓碑：`curateApply` 拒绝 `tombstoned`（含 MCP 路径）。
- `/api/conflicts` 载荷上限：`limit`（默认 50/上限 200）+ 单 slot 候选对 200，带 `truncated` 标记。

## Known limits

- 后端切换走 `config/policy.json`（未提供 `MEMO_INDEX` 环境变量覆盖）。
- 同一 scope 的 sqlite 索引仍要求单写者（与真相层锁一致），不做多进程并发写索引。
- Q5 契约覆盖待补：本版新增导出（curate.js 7 个、create-index.js、sqlite-index.js 等）尚未登记进
  `docs/02` §3.x，由文档契约侧统一补齐。
- Q7 待发布时同步：`package.json` 仍是 0.1.3，需 bump 到 0.1.4 与本段一致。

## [0.1.3] - 2026-11-02（只读 Web UI「记忆观察台」）

### Added

- **CLI 子命令 `memo serve [--port N] [--no-ui]`**：只读 Web 服务，只绑 `127.0.0.1`（默认 7788），
  无鉴权（用户决策 D1，因此不提供任何写端点）；SIGINT/SIGTERM 优雅关闭，端口占用明确报错不静默换端口。
- **两个只读查询 API（`MemoryService`）**：`events({since,until,ops,limit})` 与
  `exportRecords({since,until,status,kind,limit})`；`[since,until)` 半开区间，`truncated`/`limited`
  显式提示禁止静默截断，suspicious 默认遮蔽 `[suspicious withheld]`（裁决 30）。
- **7 个只读 HTTP 端点**：`/api/summary` `/api/brief` `/api/today` `/api/records` `/api/graph`
  `/api/hygiene` `/api/timeline`（`tzOffset` 由调用方给，服务端不猜时区，裁决 32）；
  非法参数 400，错误统一 `{ok:false,code,message}`。
- **三页静态 UI（`ui/`，零构建零依赖零外链）**：今日变化 / 记忆图谱（力导向，可拖可缩放，
  边开关存 localStorage）/ 卫生洞察（待裁决候选 + 清理史 + 30 天百分比趋势）。
- **metrics 序列暴露 `activeRatio = active/maxActive`**，UI 趋势三条线统一百分比坐标（裁决 38）。
- 文档：`docs/02` §3.10（裁决 35–38 + web 层导出清单）、`docs/06` §7（Web UI 怎么看）、
  `docs/08` §12（实现说明与偏差）、计划执行结果。
- 测试：新增 30 个（`events-query` / `nightly-metrics` / `web-server` / `web-handlers` / `graph-layout` 单测
  + 注入 `i13-static-security` / `i14-cross-section` / `i15-live-refresh`），共 **147 tests 全绿**；7 端点形状
  与 tzOffset 边界断言在 `web-server.test.js`。
- **双审核整改（arch 5 严重 + adversarial 4 严重，均无阻断）**：
  - 常驻进程截面撕裂 → `MemoryService.refreshView()`（水位置刷新 + 在途去重），`/api/*` 每请求前刷新；
    新增 **I15** 跨进程用例（真实 CLI 子进程写入 → 下一次请求可见，label 不退化）。
  - suspicious 遮蔽只罩 text/value → `subject`/`predicate`/`source.quote` 一并遮蔽，实现下沉 `src/api/mask.js`（裁决 42）。
  - `disputed-with` 边恒悬空 → 图谱节点准入加 `disputed`（裁决 40）。
  - `memo serve` 关闭吞 `flushHits` 错误 → stderr + exit 1（裁决 21）。
  - metrics 命名四处重复 → `src/config/paths.js`（`scopeKeyOf`/`metricsFileName`/`legacyMetricsFileName`，裁决 39）。
  - 回环绑定与超时 → 运行时回环断言 + `headersTimeout/requestTimeout/keepAliveTimeout` + `closeIdleConnections()`（裁决 41）。
  - 导出顺序不稳定使 `q` 过滤失真 → `exportRecords` 截断前按 `createdAt`+`id` 排序（裁决 44）。
  - Q9 声明的阈值此前没实现 → 零构建 + 单文件 ≤600 行 + 总量 ≤2500 行落地；`ui/graph.js` 拆为
    `ui/layout.js`（纯布局）+ `ui/graph.js`（渲染交互）；`// q9-allow` 必须带理由（裁决 43）。
  - `read-only.js`/`paths.js`/`mask.js` 导出与私有耦合登记进 `docs/02 §3.11`，Q5 覆盖率 95.2%。

### Changed

- **metrics 快照按 scope 分文件**：写 `metrics/<date>.<scopeKey>.json`，读路径先新名后旧名
  （裁决 31）——修复多分库同日互相覆盖的静默数据丢失。
- **图谱 same-entity 边由「同 subject 全连」改为按 `createdAt` 升序的相邻时间链**（裁决 35：
  17 节点全连 136 条重叠边不可读，链式 O(n) 表达实体时间序列）。
- **事件流统计按裁决键聚合**：一次 `curate_apply` 的 loser+winner 两条事件在 today/timeline/hygiene
  三处计为一次动作（裁决 36）。
- **label 一律服务端生成**（裁决 33/37）：图谱节点 `subject/predicate`，时间线/清理史
  `subject/predicate：值前 40 字`；UI 不拼接语义。

### Fixed

- 并发漏读（`_reload` 水位序）已在 **[0.1.2]** 修复，本版不重复；此处仅引用——Web 层只读路径因此可信。

#### Fixed（v0.4 双路审核修复，见 `reviews/RESPONSE-v0.4.md`）

- 脱敏旁路：`value`/`title`/`source.quote` 与 `supersede()` 现在都脱敏（`redactedInput()`），assignment 规则覆盖 `"password":"x"`、`DB_PASSWORD=`、嵌套 JSON。
- 注入越权：围栏标记转义、按 id 折叠只注当前版本、`suspicious` 永不注入、预算不足不输出。
- 分歧超组：自由文本不再构成 slot 分歧，`resolveConflicts` 明确拒绝。
- 捕获队列并发：同步互斥锁 + 原子 rename，两进程 200 条不丢；坏行只跳过不阻断。
- 向量模型隔离：换模型后旧向量被跳过并清理；hybrid `add` 兼容单参调用（在线写入立即产向量）。
- 裁决不能复活墓碑：`curateApply` 拒绝 `tombstoned`（含 MCP 路径）。
- `/api/conflicts` 载荷上限：`limit`（默认 50/上限 200）+ 单 slot 候选对 200，带 `truncated` 标记。

## Known limits

- **不做导出**（PDF/分享链接）、**不做写操作**（页面无任何写按钮，写入入口仍只有 CLI 与 MCP）、
  **不做远程访问**（仅 `127.0.0.1`，无鉴权故不监听局域网）。
- 图谱节点采样上限默认 300（`limit` 1–1000），大库看到的是采样图（页眉显示 `shown/total`）。
- `quality-check` Q2 待达标（`src/api/service.js` 949 行 > 900 上限）、Q7 待发布时 bump `package.json`
  版本号；覆盖率门禁未达阈值（lines 80.20% < 85、functions 89.93% < 90、branches ✓），见计划「执行结果」遗留清单。

## [0.1.2] - 2026-11-02（质量/安全门禁 + 开源品牌）

### Fixed
- **并发漏读（I8 偶发红的根因）**：`src/api/service.js` 的 `_reload()` 先 `loadScope()` 全量读、后取 `fileSize()`，
  若他进程在这两步之间追加一行，该行"读时没看到 + 水位已越过"→ 永久漏读 → 同一事实被判两次 created。
  改为**先取 `sizeBefore` 再读**，`_readOffset = sizeBefore`；`_refreshIncremental()` 对重复消费的快照做去重
  （`validTo/status/contentHash/hits` 全等则跳过），避免版本链与索引被污染。新增 `tests/unit/reload-race.test.js`（2 用例）。
  修后 117 tests 连跑 3 次全绿，I8 带覆盖率连跑 10 次全 PASS。

### Added
- **四道门禁**（本地与 CI 同源、零依赖）：`tools/quality-check.mjs`（8 项：零依赖/源码规模/测试清单/评测对齐/
  契约覆盖/文档链接/版本自包含/编码卫生）、`tools/security-check.mjs`（8 项：个人路径/凭据/内部域名与内网 IP/
  配置可移植/.gitignore/许可证/大文件/历史面）、`tools/coverage-gate.mjs`（lines ≥85 / branches ≥70 / functions ≥90）。
- **四个 GitHub workflow**：`ci.yml`（Node 22/24 双跑 + I1–I12 评测 + 覆盖率）、`quality.yml`、`security.yml`
  （secrets + CodeQL `security-and-quality`）、`issue-link.yml`（**MR 必须关联 open issue**，仅 `no-issue` 标签可豁免且需写理由）。
- `.github/` 模板与治理：issue 模板（feature 强制可机械检验的验收标准/契约影响/安全影响）、PR 模板、
  `CODEOWNERS`、`dependabot.yml`；`CONTRIBUTING.md`、`SECURITY.md`、`docs/07-quality-and-security.md`
  （指标定义、阈值理由、谁能改阈值、当前基线）、`docs/05-process.md` §6 issue→MR 强制流程与 §7 角色→门禁映射。
- `docs/02-data-model-and-contract.md` **§3.8 内部模块导出清单**（15 个内部导出登记，Q5 契约覆盖从 62% 提到 100%）。

### Changed
- 目录 `memory-system/` → **`sedimem/`**（产品名 sedimem；技术标识保持 `memo`/`MEMO_*`/`memory_*`/`serverName: memo`，
  v0.2 再做带兼容期的重命名）。仓库 https://github.com/Old-Friends-Gathering/sedimem 。
- `package.json`：name → `@old-friends-gathering/sedimem`，version → 0.1.2，`test` 脚本改 glob 形状
  （`node --test tests/` 在 Node 24 会 MODULE_NOT_FOUND），补 `license`/`repository`/`homepage`/`bugs`。
- `README.md` 重写为品牌页（为什么叫 sedimem、地层表、门禁表、迭代纪律）。

## [0.1.1] - 2026-11-02（三端接入后补强：中文去重）

### Added
- `signatureSimilarity(a,b)` / `charBigrams(s)`：汉字二元组 Dice（裁决 26）。**不含汉字的文本返回 0**，
  英文改写继续走 containment；用于召回「内容词全换」的中文改写（containment = 0 的场景）。
- `dedupeScan` 双路候选：`containment ≥ 0.45` 或 `dice ≥ 0.15`（`policy.dedupe.scanDiceThreshold`，可设 1 关闭）。
- 每个候选簇新增 `pairs: [{aId,bId,containment,dice,score,basis,strength}]`（裁决 27）+ `metrics:{maxContainment,maxDice}`。
  `strength='weak'` 表示仅同主题词重合，**默认动作建议 `keep_both`**（并查集是传递闭包，光看 items 会误判）。
- `memory_curate` 的 `decisions[]` 支持 `ids:[aId,bId]` 形状（`memory_dedupe_scan` 的产物没有 batchId，
  之前只能走 `curate export` 批次，闭环缺一环）。
- 评测：I12（中文改写 4 条同义 → 双路召回 → Agent 裁决 → 非破坏收敛 → 再扫清零）+ 3 个单测。

### Added（运行期分库，裁决 28）
- `memory_scope` 工具（第 10 个 MCP 工具）：`get` 看当前分库与来源，`use({path|scope})` 运行期切换。
  修的是实测事故：DSH 的 MCP server 是常驻进程、cwd 固定 `~/.dsh/profiles/desktop`，
  导致 DSH 写入落在 `dir:desktop`、Claude/Codex 在项目里读 `dir:<项目>` —— 三端共享分库被进程生命周期破坏。
- `src/mcp/scope-state.js`：`SCOPE_PATTERN` / `readScopeOverride` / `writeScopeOverride` /
  `initScopeState`（`MEMO_SCOPE` > `$MEMO_HOME/.scope.json` > cwd）/ `resolveUseTarget`（纯函数，可单测）。
- server 内 `Map<scope, MemoryService>` 懒建缓存 + 服务门面代理：切换 scope 后所有工具立即跟随，无需重启。
- 覆盖文件**按客户端隔离**：`.scope.<clientKey>.json`（clientKey 来自 `initialize` 的 `clientInfo.name`），
  scope 状态改为连接级初始化；否则 DSH 的切换会污染 Claude/Codex 在别的项目的分库。
- `memo scope [--json]`（CLI）：打印本目录 scope + `memoHome` + 各客户端覆盖文件（排障第一条命令）。
- 16 个单测（`tests/unit/mcp-scope.test.js`）+ 真实库演示：两条同义记录由 Agent 判 `merge` → `active 3→2`、真相层全留。

### Changed
- `dedupeScan` 返回增加 `diceThreshold`；`mcp.memory_dedupe_scan` schema 增加 `diceThreshold`，文本输出带 `basis`/`metrics`。
- MCP server instructions 补一句：`strength=weak` 时默认 `keep_both`。

### Rejected（有实测数据，故不做）
- **全字符二元组 Dice**：无关英文对误聚 13.68%（@0.15），`th/he/ing` 碎片到处都有 → 只保留 CJK-only。
- **IDF 加权 Dice**：真中文改写 0.19–0.26 vs 同域无关事实 0.22–0.29，区间重叠，无可分阈值。
- **把 Dice 阈值降到 0.10 追求召回**：无关中文对误聚升到 2.31%，且仍抓不到内容词全换的极端改写（0.063）。


## [0.1.0] - 2026-11-02（通过验收）

### Added（首版实现）
- 真相层 `items/<scope>.jsonl`（append-only，last-write-wins fold；`loadScopeIncremental` 增量读）
- 派生层 `InvertedIndex`（BM25，纯 JS，可替换为 sqlite/hybrid；`size` 入契约）
- 写入门控：contentHash 判等 / 同 slot 同值 / 近重复（containment ≥0.85）/ 同 slot 异值 supersede / disputed
- bi-temporal 字段与 tombstone 删除；`asOf` 查询（Date.parse 归一 UTC ms）
- `MemoryService` 唯一 API；CLI（write/search/get/stats/brief/doctor/supersede/forget/curate/dedupe/migrate/nightly）
- MCP stdio server（9 工具：write/search/get/brief/supersede/forget/curate/stats/dedupe_scan）
- `renderBrief` 确定性渲染（≤80 行，suspicious 行占位）
- `curate export/apply` 裁决批次协议（支持 `decisions:[{ids,decision,note}]`，非破坏）
- `dedupeScan`：只读候选簇发现（阈值 0.45，倒排桶取候选，5000 条 45ms）
- `config/policy.js`：策略唯一加载点（`policy.json` 深合并 + deepFreeze）
- 投毒检测：NFKC/零宽/CJK 空格/异体字归一化 + base64/拆字/拼音启发式 + 读路径默认遮蔽
- 评测：`tests/unit` + `tests/injection` I1–I11 + `eval/run.js`（指标快照与门禁）

### Fixed（第二轮审核后）
- **阻断**：常驻服务陈旧快照致写入判定跨进程失效 → 判定与追加在同一 scope 锁内
- **阻断**：默认 slot `text/text` 导致第 2 条起全 disputed → unstructured 近重复语义
- **阻断**：10 进程并发同文本 → 7 条 active → 现 `active=1`
- 换措辞重复变 disputed 垃圾 → 在线不误杀 + Agent 裁决闭环（`dedupeScan` + `curateApply`）
- 投毒 10 变体只拦 4 个、原文进 brief → 10/10 拦截、brief 0 泄露
- `asOf` 按字典序比较 → 时间戳比较，非法抛 `E_INVALID_ARG`
- `doctor` 遇坏 JSONL 裸崩 → 结构化 `corrupt_jsonl`（file/line）exit 1
- MCP 静默默认 agent / 丢 `source` 对象 / 响应乱序 / 校验空转 → 全部修复（`-32002`、`E_SOURCE_CONFLICT`、串行化、严格 schema 校验）
- `nightly` 写死 `QUOTA_MAX_ACTIVE` 并重复实现淘汰 → 统一走 `enforceQuota()`（墓碑带 `quota` tag）
- `close()` 吞 `flushHits` 错误 → 错误传播 + `doctor` 报 `hits_unflushed`
- `source.agent` 从枚举放宽为自由标签（保留名黑名单），新客户端可直接接入

#### Fixed（v0.4 双路审核修复，见 `reviews/RESPONSE-v0.4.md`）

- 脱敏旁路：`value`/`title`/`source.quote` 与 `supersede()` 现在都脱敏（`redactedInput()`），assignment 规则覆盖 `"password":"x"`、`DB_PASSWORD=`、嵌套 JSON。
- 注入越权：围栏标记转义、按 id 折叠只注当前版本、`suspicious` 永不注入、预算不足不输出。
- 分歧超组：自由文本不再构成 slot 分歧，`resolveConflicts` 明确拒绝。
- 捕获队列并发：同步互斥锁 + 原子 rename，两进程 200 条不丢；坏行只跳过不阻断。
- 向量模型隔离：换模型后旧向量被跳过并清理；hybrid `add` 兼容单参调用（在线写入立即产向量）。
- 裁决不能复活墓碑：`curateApply` 拒绝 `tombstoned`（含 MCP 路径）。
- `/api/conflicts` 载荷上限：`limit`（默认 50/上限 200）+ 单 slot 候选对 200，带 `truncated` 标记。

## Known limits（明确延期到 v0.2，见 reviews/RESPONSE.md §五）
- 无向量检索、无跨机同步、无自动摘要
- 语义去重依赖「Agent 当裁判」，尚无 `JudgePort` 注入点（无法夜间无人 LLM 裁决）
- `kind`/`status` 仍非数据化注册表
- 资源类 OS 错误未归一为 `E_MEMO_HOME_UNWRITABLE`
- JSONL 无 compact / 墓碑无物理清理
