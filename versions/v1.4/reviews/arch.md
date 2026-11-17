# reviews/arch.md — memo v0.1 架构与可演化性审核

审核人：review-arch。范围：`src/` 全量 + `config/policy.json` 对照 `docs/00–05`（含契约 02 §3.1 裁决）。
所有结论均以代码行号 + 可复现 probe 为证；probe 脚本在 `reviews/probes/`。
Node：DSH 内置 runtime 的 node（v24.21.0），工作目录 `versions/v0.1`。

---

## 意见

### [阻断] 常驻服务的写入门控基于进程内陈旧快照，跨进程写入完全不可见 → 重复/冲突判定系统性失效
- 位置：src/api/service.js:73-88（`_init` 只在启动时 `_reload` 一次）、src/api/service.js:146-150（`write()` 用 `this._records` 当 candidates）、src/storage/jsonl-store.js:26-32（`withLock` 只包住单次 `appendFile`）
- 现象：`node reviews/probes/arch-stale-cache.mjs` 输出：
  ```
  A writes exact duplicate of B fact -> action: created (expected noop_duplicate)
  A search total (stale view): 1
  active values in truth layer: [ '443', '8443', '443' ]
  ```
  服务 A（模拟 MCP 常驻进程）启动后，另一进程 B 写入两条；A 未重载，随后写入与 B **逐字节相同**的事实，判定为 `created` 而非 `noop_duplicate`，真相层出现同一 slot 三条 active（含内容完全相同的两条）。A 的 search/stats 也只有自己写的 1 条（陈旧视图）。
- 为什么是问题：违反 C2「三端同一份记忆」与 C3「重复不增长」（docs/00 §2）——部署形态就是 CLI（每命令一进程）+ MCP（常驻）并行，多进程写是**常态而非边界**。docs/01 §4 只说「跨进程用 .lock」，但锁的粒度是单次 append，`decideWrite`（读-判）与 `append`（写）不在同一临界区；也没有任何陈旧检测/重载机制（`reindex()` 存在但没有任何调用方自动触发）。原则 4「机器只做确定性判断」被架空：判定输入本身就不是最新真相。附带后果：并发两进程写同 slot 异值也会双双 `created`（无 superseded/disputed，`conflictRate` 反而报 0），见 `reviews/probes/arch-race.mjs`。
- 修法（最小）：把「刷新 → 判定 → 追加」放进同一把 `withLock` 临界区：`service.write()` 先在锁内增量重读 `items/<scope>.jsonl`（记录已读字节偏移，只读新增尾部并 fold 进 `_records`），再 `decideWrite`，再 append；MCP 长驻进程在每次 `tools/call` 前做一次尾部增量刷新亦可（入口层一行）。锁由 api 层持有（storage 暴露 `withLock` 复用），不违反分层。
- 复现：`node reviews/probes/arch-stale-cache.mjs`；并发版 `reviews/probes/arch-race.mjs`（两个后台进程同 slot 异值 → 双 `created`）。

### [严重] IndexPort 有契约外的隐藏依赖（`.size`、asOf 硬编码 InvertedIndex、默认构造），按 docs/03 §2 的判定标准换 sqlite 索引不合格
- 位置：src/api/service.js:48（默认 `new InvertedIndex`，且全仓无任何 `MEMO_INDEX`/注入切换入口）、src/api/service.js:261-263（asOf 路径 `const tmp = new InvertedIndex(...)` 直接硬编码具体实现）、src/api/service.js:265 与 :440-441（依赖契约未定义的 `index.size` 属性——docs/02 §3 对 InvertedIndex 只冻结 `build/add/remove/search`）
- 现象：`node reviews/probes/arch-index-port.mjs`（注入一个完全符合契约签名的假索引）：
  ```
  SEARCH_OK [...]                        # 恰好未崩（limit=undefined 被实现宽容处理）
  DOCTOR_OK {"ok":false,"issues":[{"code":"index_inconsistent","severity":"error","detail":"index=undefined records=1"}]}
  ASOF_OK items= 0                       # asOf 静默换了检索引擎，语义与主索引不一致
  ```
  合法端口替换后 `doctor` 报假阳性 error（直接打挂 G3 门禁），asOf 查询则绕过注入的端口用另一个引擎打分。
- 为什么是问题：docs/03 §2 明文「如果某个改动需要在 api/service.js …里写 if（impl===…）那它设计错了——应该是适配器+注入」，且 v0.2 路线第 1 位就是 sqlite-index。现在换成 sqlite FTS5 需要改：`index/sqlite-index.js`（新增）+ `api/service.js`（`.size`×2、asOf 临时索引、默认构造、`limit: this.index.size` 的"取全部"语义）+ 三个入口（cli/mcp/nightly 各自要加 `MEMO_INDEX` 分发）≥ 5 处，>2 个即不合格。
- 修法：契约补 `size`（或 doctor 改用 `this._records.size` 单侧比较）；asOf 不再自建临时索引——把 picked 版本喂给已注入端口的一个 `searchMany`/临时 `build`（由端口自提供）；默认实现在入口层按 env 选择后注入。
- 复现：`node reviews/probes/arch-index-port.mjs`

### [严重] api/ 编排层内嵌四块策略细节，JudgePort/PolicyPort 实际不存在
- 位置：src/api/service.js:126-134（suspicious 投毒打标策略）、:193-213（配额淘汰执行策略）、:269-283（检索打分公式 `bm25 × kindWeight × recencyDecay × confidence`）、:508-529（curateApply 的 a_wins/b_wins/merge/keep_both 落盘语义）
- 现象：grep 证实这四块都在 service.js 内联；`hygiene/` 里没有 JudgePort 实现，docs/03 §2 承诺的 `MEMO_JUDGE=` 切换没有任何注入点——裁决语义长在唯一对外 API 里。
- 为什么是问题：docs/01 §1 规则「api/ 不得包含策略」。v0.2 路线 2（LLM judge）按现状必须改 service.js 本体；打分公式调整（PolicyPort 按 docs/03 §2 是数据驱动 A/B 的对象）也要动编排层。这会让每次策略演化都触碰最不该频繁改的文件。
- 修法：最小拆分——打分公式移入 `hygiene/score.js`（纯函数 `(score, record, clock, policy) => number`）；suspicious 判定移入 `hygiene/poison.js` 或复用 brief 的 `isSuspicious`（当前 service.js 与 brief.js:87-91 各有一份模式匹配，已经是两处实现）；curateApply 的裁决落地语义移入 `hygiene/curate-apply.js`，service 只编排。
- 复现：`grep -n "kindWeight\|suspicious\|curate_apply\|_enforceQuota" src/api/service.js`

### [严重] kind/agent/status 枚举硬编码散落，新增一种 kind 要改 ≥4 个文件，违背「kind 取值是数据」
- 位置：src/core/record.js:7-9（KINDS/STATUSES/AGENTS）、src/render/brief.js:20（KIND_ORDER）与 :47-48（counts 按枚举初始化）、src/mcp/server.js:72/97（inputSchema enum，write 与 search 各一份，共 ≥3 处）、config/policy.json（halfLifeMs/kindWeight 键）
- 现象：推演新增 kind `snippet`：必须改 policy.json、core/record.js（否则 `E_INVALID_RECORD`）、render/brief.js（否则排序落 `?? 9` 且计数行不显示）、mcp/server.js 的 2 个 enum（否则 MCP 端根本写不进来）。共 4-5 个文件、分散在 4 个员工的写权限 scope（policy 归谁改都说不清）。
- 为什么是问题：docs/03 §6「`kind` 取值……都是数据（配置），不是代码常量」。现状是配置里有一份、代码里有四份，必然漂移（改了 policy 不改 record.js 就是全线拒绝写入）。
- 修法：枚举单一来源放 policy.json，`core/record.js` 与 brief.js 启动时从 policy 读（读不到再回退冻结集）；MCP inputSchema 的 enum 从同一来源生成。
- 复现：`grep -rn "'fact'" src/ | wc -l` → 6 处。

### [严重] cli/nightly.js 含业务逻辑与写死策略常量，且淘汰路径与写路径行为不一致（doctor 检测盲区）
- 位置：src/cli/nightly.js:117（`const QUOTA_MAX_ACTIVE = 5000;` 写死，注释自认对应 policy）、:68-83（在 CLI 里重新实现一遍配额淘汰选择）、:125-127（走 `service.forget` 淘汰）；对照 src/api/service.js:203-204（写路径淘汰打 `quota` tag）、:446-447（doctor 靠 `tags 含 'quota'` 检测配额淘汰）
- 现象：probe 证实 `forget()` 落的墓碑 `tags=[]`（无 `quota` tag，事件 op=`forget`）：nightly 的配额淘汰永远不会被 doctor 的 `quota_exceeded`/`(quota evictions present)` 逻辑看见；`QUOTA_MAX_ACTIVE` 与 policy.json `quota.maxActive` 是两份独立真相，改 policy 后 nightly 按错误阈值淘汰。
- 为什么是问题：docs/01 §1「cli/ 不得含业务逻辑」；docs/03 §6「配额都是数据（配置）不是代码常量」；策略双实现正是六原则要防的漂移源。observability 上「为什么这条被忘了」在 nightly 路径只剩 events reason 字符串，无结构化标记。
- 修法：nightly 删掉本地淘汰逻辑，改为调用 service 暴露的公开整合入口（如 `service.enforceQuota()` / `service.compact({ttl:true, quota:true})`），`_enforceQuota` 从私有提为公开方法；淘汰统一打 `quota` tag。`QUOTA_MAX_ACTIVE` 删除，读 `service.quota.maxActive`。
- 复现：见 arch.md 本条现象段（`tags []` 墓碑输出，探针命令在审核记录中：注入 `QuotaPolicy({maxActive:2})` 触发写路径淘汰 vs `service.forget` 对比）；`grep -n QUOTA_MAX_ACTIVE src/cli/nightly.js`

### [严重] `close()` 空吞 `flushHits()` 错误——hits 增量静默丢失，违反「禁止吞错」
- 位置：src/api/service.js:536（`if (!this._closed) await this.flushHits().catch(() => {});`）
- 现象：一行 `grep` 可见唯一一处空 catch 吞掉落盘失败；flushHits 内部任何一次 `_commit`（validate/append/appendEvent）抛错都会被吞，`_extraHits` 已在 flushHits 开头清空（:306）→ 该批 hits 永久丢失且无任何事件/日志。
- 为什么是问题：docs/02 §3 错误约定「禁止吞错（这是对 #530 的直接防线）」；docs/05 §4 架构清单第 6 条「错误是否都被显式抛出（有没有空 catch）」。讽刺的是防线本身被空 catch 咬了。
- 修法：`try { await this.flushHits() } catch (e) { /* 保留增量不清空 + 写一条 op='hit_flush_failed' 事件后 rethrow 或至少 stderr */ }`——至少不得既吞错又丢增量。
- 复现：`sed -n '535,538p' src/api/service.js`

### [建议] policy.json 四处独立加载 + 代码内兜底常量与配置重复
- 位置：src/api/service.js:18-20、src/hygiene/decay.js:8-24、src/hygiene/quota.js:7-17 及 :21（`?? 5000`）、:28（整份 kindWeight 兜底对象）、:30（`?? 7776000000`）、src/render/brief.js:7-17
- 现象：四个模块各自 `readFileSync(new URL('../../config/policy.json'))`，quota.js 还内置一份与 policy 相同数值的字面量兜底。改 policy 结构（如 `search.recencyHalflifeMs` 改名）要同步改 4 处；兜底字面量与配置漂移无检测。
- 为什么是问题：docs/03 §6 单一来源原则；§3.1.5 只要求「不写死」，但兜底字面量事实上构成第二份写死值。
- 修法：抽 `src/core/policy.js` 单次加载 + 冻结对象导出，其余模块 import；quota.js 的数值兜底删除（加载失败就 fail-loud，与其余三处一致）。
- 复现：`grep -rn "config/policy.json" src/ | wc -l` → 4。

### [建议] 契约磁盘布局中的 `brief/<scope>.md` 从未落盘，nightly 的「brief 重建」只数行数
- 位置：docs/02-data-model-and-contract.md §1（布局含 `brief/<scope>.md`）；src/cli/nightly.js:130-132（`brief` 只 `split('\n').length`）；probe 证实全量读写后 `MEMO_HOME` 只有 `events.jsonl` 与 `items/`，`brief/`、`index/` 均不存在
- 现象：`node reviews/probes/arch-rebuild.mjs` 输出 `brief/ exists: false`、`top-level after writes: [ 'events.jsonl', 'items' ]`。
- 为什么是问题：契约-实现漂移（G5 逐条核对会发现）；下游若按布局读 brief 文件（例如其它 agent 约定）会扑空。brief 按需渲染本身没问题（派生可弃），那布局就该在 v0.1 标注「不落盘」。
- 修法：二选一：nightly 真正写 `brief/<scope>.md`（写前删除旧文件，属派生层允许覆盖）；或 Lead 在 docs/02 §1 给 `brief/` 打「v0.1 不落盘，按需渲染」注记（属契约 scope，报 Lead 改）。
- 复现：`node reviews/probes/arch-rebuild.mjs`

### [建议] `curate_apply` 事件不含记录 id，queue/ 删除后无法从审计流定位被裁决的记录
- 位置：src/api/service.js:513-527（事件 detail 仅 `{batchId, decision, pairIndex, side}`，无 a/b 记录 id）
- 现象：probe 事件流输出 `event op curate_apply detail {"batchId":...,"decision":...,"pairIndex":...,"side":"loser"}`；记录 id 只在 queue 批次文件的 `audit.a/b` 里（hygiene/curate.js:151-156）。queue 是派生层（可弃），删掉后仅凭 events 无法回答「哪条记录因哪个裁决被 supersede」。
- 为什么是问题：docs/03 §6「任何自动整合都必须可回放：events.jsonl 记录每个决定，`memo replay` 能回答『为什么这条被忘了』」——当前 curate 路径回放链断裂一半。
- 修法：`_event('curate_apply', record.id, detail)` 已带 id（第二参），把 detail 再补 `{winnerId, loserId, batchId, decision}` 即可，一行改动。
- 复现：`grep -n "curate_apply" src/api/service.js`

### [建议] MCP 入口不传 cwd，scope 静默由 server 进程 cwd 决定——三端可能各自分库
- 位置：src/mcp/server.js `createServiceOrFail()`（调 `createMemoryService({memoHome})` 不传 `scope/cwd`）→ src/api/service.js:45 落到 `resolveScope({cwd: undefined, env})` → `process.cwd()`（src/core/scope.js:10）
- 现象：同一 `MEMO_HOME`，两个不同 cwd 的进程写同一句话，probe 得到 `items/` 下出现 `dir:tmp.jsonl` 与 `dir:memo-arch4b-*.jsonl` 两个 scope 文件——记忆按 server 启动目录静默分库，无任何告警。
- 为什么是问题：C2「三端同一份记忆」取决于各客户端启动 MCP 时的 cwd 是否恰好等于项目目录；不成立时写进去就找不回，且没有任何 doctor 项能发现。
- 修法：MCP initialize params 里的 client cwd（或要求客户端设 `MEMO_SCOPE`）转发给 service；至少在 server 启动时 stderr 打印解析出的 scope，并让 doctor 报告 `listScopes()` 里 scope 数量异常增长。
- 复现：见审核记录（两个 `cd` 不同目录的 `node -e` 写入同一 MEMO_HOME，`ls items/` 出现两个 scope 文件）

---

## 必查清单逐条结论

1. **依赖方向**：✓ 基本单向。`hygiene/` 未 import `storage/`（只 import node:fs/path/crypto 与 `../core/hash.js`、`./conflict.js`）——注意 hygiene/curate.js 自己直接写 `queue/` 文件（契约允许，属其 scope）。cli/memo.js、mcp/server.js 是薄入口 ✓。违规点：api/service.js 内嵌策略（见严重 #3）、cli/nightly.js 含淘汰业务逻辑（见严重 #5）。完整 import 图已在审核中逐文件列出（grep `from '`），无循环依赖，无上行依赖。
2. **Port 可替换性（sqlite FTS5 推演）**：✗ 不合格。改动清单：`index/sqlite-index.js`（新增）+ `api/service.js`（`.size` ×2 处、asOf 硬编码 InvertedIndex、默认构造、limit 语义）+ cli/mcp/nightly 三入口加 `MEMO_INDEX` 分发 ≈ 5 处，>2。probe 实证：契约完备的假索引使 doctor 报假阳性 error、asOf 静默换引擎（arch-index-port.mjs）。
3. **策略常量散落**：`src/cli/nightly.js:117`（QUOTA_MAX_ACTIVE=5000，写死）；`src/hygiene/quota.js:21`（??5000）、`:28`（kindWeight 兜底字面量）、`:30`（??7776000000）；BM25 K1/B（inverted-index.js:6-7，算法常量，可接受）；lock stale/timeout（lock.js:14，docs/01 §4 冻结值，可接受）；其余（MAX_TEXT、AGENT 枚举）为契约冻结值。真正违规是前四处（policy 是配置唯一源）。
4. **真相层不可变性**：✓。全 src 无任何 `writeFile/truncate` 触及 `items/*.jsonl`，唯一写路径是 `appendFile`（jsonl-store.js:30）；`reindex()` 只读（probe 实测前后字节不变：`items bytes unchanged after reindex: true`）；`writeFile` 只用于 queue/、metrics/、.lock（均派生/临时）。
5. **可重建性**：✓（node 实测）。建库→写 5 条（含 supersede/disputed/墓碑/hits flush）→删 queue/、metrics/、events.jsonl 只留 items→重开→stats 完全一致（REBUILD_STATS_EQUAL: true）。**未发现无法从真相层重建的派生态**——因为派生态几乎不落盘（brief/、index/ 从不存在，见建议 #8）。两个边角：未 `close()` 崩溃时内存 hits 增量丢失（读路径派生，可接受）；queue 的 applied 状态删后只能从 events 半重建（见建议 #9）。
6. **枚举/状态机硬编码**：✗。新增 kind 需改 ≥4 文件（policy.json、core/record.js:7、render/brief.js:20+47、mcp/server.js ×2 enum）；新增 status 需改 core/record.js:8 + service.js 各 status 分支 + brief/doctor 过滤。详见严重 #4。
7. **可观测性**：events 覆盖写/裁决/淘汰/hit flush 且带 id+detail，坏行 fail-loud 带 `file:line` ✓；缺口：`close()` 吞 flushHits 错误（严重 #6）、curate_apply 事件缺记录 id（建议 #9）、nightly 淘汰无 quota tag 导致 doctor 盲区（严重 #5）、MCP 分库无告警（建议 #10）。错误码总体一致（E_INVALID_RECORD/E_NOT_FOUND/E_LOCK_TIMEOUT/E_BATCH_NOT_FOUND 均按契约），另见 E_POLICY/E_INVALID_ARG/E_CORRUPT_JSONL 等未入契约 §3 清单（小漂移，报 Lead 知悉即可）。
8. **v0.2 演化推演**：
   - sqlite index：如上，≈5 处改动，IndexPort 抽象当前不达标（严重 #2）。
   - LLM judge：无 JudgePort 注入点，裁决语义长在 service.js:508-529，需先做严重 #3 的拆分才能挂 `judge-llm.js`；curate 批次格式已可用。
   - compact（物理清理）：storage 无删除原语（append-only 是对的），需 ADR 定义「purge 墓碑的物理清除 = 重写 items 文件？」——这会第一次触碰真相层不可变原则，属 Lead 决策；`loadScope` fold「最后一行胜出」已为墓碑保留语义，演化面是干净的。
   - 另：多进程一致性（阻断 #1）不修，v0.2 任何长驻能力（watch、自动 curate）都会放大该缺陷。

## 结论

| 级别 | 数量 | 条目 |
|---|---|---|
| 阻断 | 1 | 跨进程陈旧快照致写入门控失效（C2/C3 破坏） |
| 严重 | 5 | IndexPort 隐藏契约；api 内嵌策略；kind 枚举散落；nightly 业务逻辑+魔法数+doctor 盲区；close 吞错 |
| 建议 | 4 | policy 四处加载；brief 不落盘与契约漂移；curate 事件缺 id；MCP scope 随 cwd 静默分库 |

BLOCKING: yes
