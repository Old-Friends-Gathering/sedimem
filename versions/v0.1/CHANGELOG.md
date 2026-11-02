# CHANGELOG · v0.1

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

### Known limits

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
- 目录 `memory-system/` → **`strata/`**（产品名 strata；技术标识保持 `memo`/`MEMO_*`/`memory_*`/`serverName: memo`，
  v0.2 再做带兼容期的重命名）。仓库 https://github.com/Old-Friends-Gathering/strata 。
- `package.json`：name → `@old-friends-gathering/strata`，version → 0.1.2，`test` 脚本改 glob 形状
  （`node --test tests/` 在 Node 24 会 MODULE_NOT_FOUND），补 `license`/`repository`/`homepage`/`bugs`。
- `README.md` 重写为品牌页（为什么叫 strata、地层表、门禁表、迭代纪律）。

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

### Known limits（明确延期到 v0.2，见 reviews/RESPONSE.md §五）
- 无向量检索、无跨机同步、无自动摘要
- 语义去重依赖「Agent 当裁判」，尚无 `JudgePort` 注入点（无法夜间无人 LLM 裁决）
- `kind`/`status` 仍非数据化注册表
- 资源类 OS 错误未归一为 `E_MEMO_HOME_UNWRITABLE`
- JSONL 无 compact / 墓碑无物理清理
