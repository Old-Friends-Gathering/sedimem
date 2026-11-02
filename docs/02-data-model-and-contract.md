# 02 · 数据模型与实现契约（唯一权威）

> 本文件是 v0.1 的**编码契约**。任何实现不得偏离导出的名字与签名；如需变更，先改本文件 + 写 ADR（`docs/adr-*.md`）。

技术基线：**Node ≥ 22，ESM，零第三方运行时依赖**，只用 `node:fs` / `node:path` / `node:crypto` / `node:os` / `node:process` / `node:test`。
目录根：`MEMO_HOME`（默认 `~/.memo`）。

## 1. 磁盘布局

```
<MEMO_HOME>/
├── items/<scope>.jsonl     # 真相层：每次状态变更追加「完整记录快照」；同一 id 最后一行胜出
├── events.jsonl            # 审计：{ts, op, scope, id, detail}
├── queue/curate-<batchId>.json
├── brief/<scope>.md        # 派生：确定性渲染
├── index/manifest.json     # 派生的派生（可选，v0.1 不落盘，仅占位）
└── .lock/                  # 跨进程写锁（目录，mkdir 即排他创建）
```

`scope` 形如 `repo:<项目名>` / `dir:work-yeager`（`MEMO_SCOPE` 环境变量可强制覆盖），用于隔离不同项目，禁止单库混用。

## 2. 记录模型（version=1）

```js
/**
 * @typedef {Object} MemoryRecord
 * @property {string} id            // 26 位 ULID（大写 Crockford base32）
 * @property {number} v             // 记录版本号，创建=1，每次状态变更 +1
 * @property {string} scope
 * @property {'fact'|'pref'|'decision'|'gotcha'|'state'} kind
 * @property {string} subject       // 实体，如 'monitor.server'
 * @property {string} predicate     // 属性，如 'port'；无法结构化时用 'text'
 * @property {string} value         // 归一化后的值（字符串）
 * @property {string} text          // 人类可读原句
 * @property {string} validFrom     // ISO-8601 UTC ms
 * @property {string|null} validTo  // 失效时间；active 时为 null
 * @property {string} createdAt
 * @property {string|null} expiredAt // TTL 到期标记
 * @property {'active'|'superseded'|'disputed'|'tombstoned'} status
 * @property {string|null} supersedes    // 被本条取代的 id
 * @property {number} confidence         // 0..1，默认 0.8
 * @property {{agent:string, session?:string, quote?:string}} source   // 必填 agent
 * @property {string} contentHash        // 'sha256:<hex>'，输入见 core/hash.js
 * @property {number} hits               // 被召回次数（只增）
 * @property {string} privacy            // 'private' | 'shared'，默认 private
 * @property {string[]} tags
 */
```

**不变式**（`core/record.js#validateRecord` 必须逐条校验，返回 `{ok, errors[]}`）：

1. `id` 匹配 `/^[0-9A-HJKMNP-TV-Z]{26}$/`；禁止列表下标、禁止自增整数。
2. `source.agent` 非空字符串，且属于 `dsh|codex|claude|cli|test|unknown`。
3. `validFrom <= (validTo ?? '9999')`；`status==='active'` ⇒ `validTo === null`。
4. `status==='superseded'` ⇒ `validTo !== null`。
5. `contentHash` 以 `'sha256:'` 开头。
6. `v >= 1`；`confidence` ∈ [0,1]。
7. `text` 非空且长度 ≤ 4000（超长截断并记 `tags:['truncated']`）。

## 3. 模块导出（冻结）

### `src/core/clock.js`
```js
export function createClock({ now } = {}) // -> { now(): string(ISO), nowMs(): number }
export const systemClock                         // 生产用
```

### `src/core/ids.js`
```js
export function newId(nowMs = Date.now()) // -> 26 位 ULID 字符串
export function isId(s)                   // -> boolean
```

### `src/core/hash.js`
```js
export function normalizeText(s)                 // 小写、全角→半角、去多余空白、去标点（保留数字与中英文）
export function contentHash({ text, subject, predicate, value })
// sha256 over normalizeText(text) + '\u0001' + subject + '\u0001' + predicate + '\u0001' + value
// -> 'sha256:<64hex>'
export function tokenize(s)                      // -> string[]（中文按 2-gram，英文按词+小写；去停用词表内置）
```

### `src/core/scope.js`
```js
export function resolveScope({ cwd, env }) // -> { scope: 'repo:x'|'dir:y', root: string }
// 规则：env.MEMO_SCOPE 优先 → 向上找 .git 取目录名 → 目录名兜底
```

### `src/core/record.js`
```js
export function createRecord(input, deps /* {clock} */) // -> MemoryRecord
export function validateRecord(r)                       // -> {ok:boolean, errors:string[]}
export function withPatch(r, patch)                     // -> 新对象（v+1），不修改入参
```

### `src/storage/jsonl-store.js`
```js
export class JsonlStore {
  constructor({ memoHome })
  async append(record)                 // 追加一行到 items/<scope>.jsonl（带锁）
  async loadScope(scope)               // -> MemoryRecord[]（按 id fold，最后一行胜出，按 createdAt 升序）
  async listScopes()                   // -> string[]
  async appendEvent(event)             // -> void（events.jsonl）
  async readEvents({limit}) // -> event[]
}
```

### `src/storage/lock.js`
```js
export async function withLock(memoHome, fn, { staleMs = 30000, timeoutMs = 15000 })
```

锁的真实形态是**目录** `<memoHome>/.lock`（`mkdir` 的 `EEXIST` 就是原子排他，没有「先检查后创建」窗口；
`staleMs` 按目录 mtime 判陈旧，`timeoutMs` 超时抛 `E_LOCK_TIMEOUT`，`finally` 删目录）。
不用「文件 + `wx` 标志」的原因是 CodeQL `js/insecure-temporary-file` 会把「临时目录里可预测文件名 + 排他创建」
判成符号链接攻击面——虽然这里路径由调用方 `memoHome` 决定，但换成目录既消除告警也更简洁（锁只需要唯一性 + 持有时间）。

### `src/index/inverted-index.js`（实现 IndexPort）
```js
export class InvertedIndex {
  constructor({ clock })
  build(records)                       // 全量重建
  add(record) / remove(id)
  search(query, { limit = 10, filter } = {})   // -> [{id, score}]，BM25，score>0 才返回
}
```
`filter` 是 `(record) => boolean`，由调用方传入（索引不持有策略）。

### `src/hygiene/write-gate.js`
```js
export function decideWrite(record, candidates, ctx /* {clock} */)
// candidates: 同 scope 且 status 允许参与判定的记录（由 api 传入，已含 active/disputed）
// -> { action:'created'|'noop_duplicate'|'noop_same_value'|'supersede'|'disputed',
//      record, superseded?: MemoryRecord, reason: string }
```

### `src/hygiene/conflict.js`
```js
export function sameSlot(a, b)                 // scope+subject+predicate 归一相等
export function parseComparable(value)         // -> {type:'number'|'date'|null, n?:number}
export function decideConflict(next, prev, ctx) // -> {action:'supersede'|'dispute'|'ignore', reason}
export function monotonicDecay(ageMs, halfLifeMs) // -> (0,1]，必须单调递减（有单测）
```

### `src/hygiene/decay.js`
```js
export const HALF_LIFE_MS // {pref: 180d, decision: 365d, fact: 90d, gotcha: 365d, state: 2h}
export function expiryFor(kind, nowMs)          // -> ISO|null（state 类 2h，其余 null，靠整合期标记）
export function isExpired(record, clock)        // -> boolean
```

### `src/hygiene/quota.js`
```js
export class QuotaPolicy {
  constructor({ maxActive = 5000 })
  selectEvictions(records, { max = this.maxActive }) // -> string[]（id，按价值升序；仅 tombstone 用）
  value(record, clock)                               // kindWeight*hits*recencyDecay*confidence，单调性可测
}
```

### `src/hygiene/curate.js`
```js
export class CurateQueue {
  constructor({ memoHome, clock })
  async exportBatch(pairs, { limit = 20 })   // -> {batchId, createdAt, pairs:[{a,b,reason}], path}
  async readBatch(batchId)                   // -> batch
  async applyDecisions(batch, decisions)     // decisions: [{pairIndex, decision:'a_wins'|'b_wins'|'merge'|'keep_both', note}]
                                             // -> [{pairIndex, applied, newRecord?}]
  async listBatches()                        // -> [{batchId, size, createdAt}]
}
```

### `src/render/brief.js`（实现 RendererPort）
```js
export function renderBrief({ scope, records, lines = 80, clock })
// 确定性输出：标题+计数 → pinned/decision 优先 → 最近 active 事实（按 hits 降序、createdAt 降序）
// 单条格式：`- [kind] text  (as of YYYY-MM-DD)`
// 总行数 ≤ lines；超出截断并追加 `… 其余 N 条见 memory_search`
```

### `src/api/service.js`（唯一对外 API）
```js
export async function createMemoryService({
  memoHome, scope, cwd, clock = systemClock,
  store = new JsonlStore({memoHome}),
  index = new InvertedIndex({clock}),
  quota = new QuotaPolicy({}),
} = {}) // -> MemoryService（已 build 索引）

class MemoryService {
  async write(input)   // input: {text, kind='fact', subject='text', predicate='text', value=text,
                       //         confidence, source:{agent,...}, tags, privacy}
                       // -> {action, record, supersededId?}
  async search(query, {limit=10, kind, asOf, includeDisputed=false, status='active'}={})
                       // -> {items:[{record, score}], total, asOf}
  async get(id)        // -> record|null
  async brief({lines=80})                 // -> string
  async supersede({oldId, value, text, source, reason}) // -> {record}
  async forget({id, mode='tombstone', reason})          // -> {id, status}
  async stats()        // -> {scope, total, active, superseded, disputed, tombstoned,
                       //     dupRatio, conflictRate, avgHits}
  async reindex()      // -> {rebuilt}   （只读真相层，绝不写 items）
  async doctor()       // -> {ok, issues:[{code, severity, detail}]}
  async curateExport({limit=20})        // -> batch|null（无候选时 null）
  async curateApply({batchId, decisions}) // -> {applied[]}
  async close()
}
```

**错误约定**：非法输入抛 `Error`，`err.code` 取 `E_INVALID_RECORD | E_NOT_FOUND | E_LOCK_TIMEOUT | E_BATCH_NOT_FOUND`；禁止吞错（这是对 #530「hook 静默失败」的直接防线）。

### `src/cli/memo.js`
```
memo write --text "..." [--kind fact] [--subject s] [--predicate p] [--agent dsh]
memo search "..." [--limit 10] [--kind fact] [--as-of ISO] [--json]
memo brief [--lines 80]
memo get <id>
memo supersede <id> --value "..." [--text "..."]
memo forget <id> [--purge]
memo stats [--json]
memo doctor [--json]
memo reindex
memo curate export [--limit 20] | memo curate apply <batchId> --decisions <file|-> 
memo migrate dsh-memory [--db path]
```
输出默认人类可读；`--json` 输出单行 JSON（供 Agent 消费）。退出码：0 成功，1 业务失败，2 用法错误。

### `src/mcp/server.js`
stdio JSON-RPC 2.0（**换行分隔**，非 Content-Length 分帧）。
- `initialize` → `{protocolVersion: <客户端请求值，若不在支持列表则 '2025-06-18'>, capabilities:{tools:{}}, serverInfo:{name:'memo',version:'0.1.0'}, instructions: <见下>}`
- 通知 `notifications/initialized` 忽略；`ping` 返回 `{}`。
- `tools/list` → 10 个工具：`memory_write` / `memory_search` / `memory_brief` / `memory_get` / `memory_supersede` / `memory_forget` / `memory_curate` / `memory_stats` / `memory_dedupe_scan` / `memory_scope`（每个带 `inputSchema` JSON Schema，`additionalProperties:false`）。
- `tools/call` → `{content:[{type:'text',text}], structuredContent?:{...}, isError?:true}`；业务错误用 `isError:true` 而非 JSON-RPC error；未知工具/方法 → JSON-RPC error `-32601`。
- `instructions` 固定文本：`"memo 是本机跨 agent 记忆。需要历史事实先 memory_search；用户要求记住时用 memory_write；事实变更用 memory_supersede。"`

## 4. 质量门禁

- `node --test tests/` 全绿（unit + injection）。
- `node eval/run.js` 的 6 项注入用例全 PASS，且 `dupRatio < 0.1`、`conflictRate < 0.2`。
- `memo doctor` 无 `severity=error`。
- 覆盖率不作为门禁，但 `hygiene/` 与 `core/` 每个导出必须有至少 1 个测试。

## 3.1 裁决与澄清（Lead，2026-11-02，实现后冻结）

实现过程中暴露的语义空洞，逐条裁决如下（后续版本不得默默更改，改则写 ADR）：

1. **`asOf` 语义**：返回满足 `validFrom <= asOf < (validTo ?? '9999')` 的版本。因此写入时间必须早于 `asOf` 才能查到；测试 I2 必须用可控 `clock` 把写入时间置于 `asOf` 之前，不能靠真实时钟。
2. **`conflictRate` 口径**：分母 = 含 ≥2 条记录的 slot 数；分子 = 其中包含 `disputed` 记录的 slot 数；分母为 0 → 0。**不是** C(n,2) 组合对数。
3. **`forget({mode:'purge'})`**：v0.1 与默认行为一致，只写墓碑；物理删除属整合期行为（v0.2 `memo compact`）。CLI 的 `--purge` 保留但不产生差异，输出提示。
4. **`memoHome` 归属**：由入口层解析 `MEMO_HOME || ~/.memo`，`MemoryService` 只接受显式传入的绝对路径（不猜环境）。CLI / MCP / nightly / migrate 四处一致。
5. **`config/policy.json` 解析**：模块内用 `new URL('../../config/policy.json', import.meta.url)` 定位（`src/hygiene/*` 与 `src/api/*` 深度相同），允许构造参数覆盖；禁止写死在代码里。
6. **`hits` 落盘时机**：`search`/`get` 只在内存累加，**不写盘**；`flushHits()` 聚合成新版本快照追加；`close()` 自动 flush；`nightly` 也会 flush。理由：读路径不得放大真相层（1000 次检索不应产生 1000 行）。
7. **`curateApply` 的 `merge`**：v0.1 按 `a_wins` 处理并给胜者打 tag `merged`（merge 语义未定义，宁可否认可审计地退化，也不要发明合并算法）。`keep_both` → 两条都 `active`，后者打 tag `coexist`。`applyDecisions` 必须幂等（重复 apply 返回 `applied:false`）。
8. **`source.agent` 枚举**：缺失或不在 `dsh|codex|claude|cli|test|unknown` 内 → `E_INVALID_RECORD`，**不默认填 unknown**（诚实报错 > 猜）。
9. **`doctor` 的 `quota_exceeded`**：`active >= maxActive` 或存在 tags 含 `quota` 的墓碑时报告，`severity:'warn'`（不是 error）。
10. **`nightly` / `migrate` 的例外**：这两个是运维型入口，允许直接读 `JsonlStore.loadScope`（只读）；**任何写操作仍必须走 `MemoryService`**。
11. **`parseComparable` 的无年份日期**（如 `3/1`）：锚定固定年份 2000，保证同批次内可比；跨年语义不在 v0.1 范围。
12. **`monotonicDecay` 下溢**：极小值 clamp 到 `Number.MIN_VALUE`，保持严格 >0 与单调递减。

## 3.2 审核后裁决（Lead，2026-11-02 第二轮，冻结）

两个独立审核发现 3 个阻断项，核实后逐条裁决（实现必须服从，测试同步更新）：

13. **跨进程一致性（阻断）**：`write` 的「重读 → 判定 → 追加」必须在**同一把 scope 锁**的临界区内完成。`JsonlStore` 需提供 `loadScopeIncremental(scope, fromOffset)` 与 `fileSize(scope)`；`MemoryService` 每次写前增量重读（记住已读 offset），把新记录并入内存索引后再 `decideWrite`。禁止「进程内快照直接判定」。
14. **无结构记录的近重复判定（阻断）**：`subject`/`predicate` 未显式给出时都记为 `'text'`，该 slot 视为 **unstructured**。unstructured 或同 slot 下的新记录，若与候选记录文本相似度 ≥ `policy.dedupe.nearDupThreshold`（默认 0.85）→ `noop_same_value`，`reason='near_duplicate'`，并给**原记录**追加 tag `variant`（不新增记录、不改 value）。
    相似度定义：`sim = |A∩B| / min(|A|,|B|)`（containment，token 集合来自 `tokenize`）。选 containment 而非 Jaccard，是因为「同一事实 + 不同长度措辞」的短句应被长句吸收。
15. **结构化 slot 的近重复**：显式给了 subject+predicate 时仍先按 `value` 判等；`value` 不等但文本相似度 ≥ 阈值 → 同样按 14 处理（避免「同事实换措辞」变成 disputed 垃圾）。
16. **suspicious 的读路径隔离**：`search`/`get` 默认**不返回** suspicious 记录的正文（`text` 替换为 `[suspicious withheld]`），只有显式 `includeSuspicious:true` 才返回原文；`brief` 永远不返回原文。写入照收（拒绝写入会让用户丢掉真实信息），但读路径绝不带给模型。
17. **`asOf` 必须按时间戳比较**：`Date.parse(asOf)` 归一化到 UTC ms 后比较，支持带偏移量字符串；解析失败抛 `E_INVALID_ARG`。禁止字符串字典序比较。
18. **IndexPort 契约补全**：索引必须暴露 `size`（number）与 `build/add/remove/search`；`asOf` 查询**不得**新建索引实例（在内存记录上过滤后按 bm25 重算或复用主索引再过滤）。换实现时 `asOf` 不需要改动。
19. **身份口令**：`MemoryService.write` 收到缺失 `source.agent` 一律 `E_INVALID_RECORD`（裁决 #8 不变）。入口层负责显式表明身份：CLI 传 `'cli'`，MCP 传 `'unknown'`（除非工具参数显式给 `agent`/`source`）。禁止入口层静默改写用户给的 agent。
20. **策略单一来源**：`maxActive`、近重复阈值、半衰期、kind 权重、打分公式系数、suspicious 模式串一律只从 `config/policy.json` 读（经 `src/config/policy.js` 统一加载并允许构造覆盖）。`nightly` 的淘汰必须走 `service.enforceQuota()`，给墓碑打 `tags:['quota']`，禁止自己实现一份淘汰逻辑。
21. **被吞的错误**：`close()`/`flushHits()` 不得吞异常；flush 失败必须抛出并在 `doctor` 中以 `warn` 呈现 hits 未落盘。

## 3.3 第三轮裁决（Lead 亲测后，2026-11-02 冻结）

**亲测结论（这条最重要）**：词法 containment 只能抓「字面近乎相同」的重复。我用 5 句人类真实改写（`The CI deploy pipeline requires Node 22+` / `Our release pipeline needs node version 22 or later` / `CI/CD deployment must use Node.js 22 minimum` / `pipeline: node >= 22 required for deploy` / `node 22 is the minimum version the deployment pipeline needs`）实测全部 `created`、active=9 —— **真同义改写必须靠判定者（LLM/Agent），不能靠词法**。因此 v0.1 的定位修正为：**在线词法只做「零误杀」的保守去重；语义去重由「正在运行的 Agent 当裁判」闭环**。

22. **`service.dedupeScan({threshold = 0.45, limit = 50})`**（新增公共 API）：返回候选簇，供 Agent 判定。
    - 分簇规则：先按 `slot`（归一化 subject/predicate，`text/text` 视为 unstructured）分组；组内**两两** `textSimilarity ≥ threshold` 的做并查集；unstructured 组整体参与（不设 slot 门槛）。
    - 返回 `{clusters: [{key, size, maxSimilarity, items: [{id, text, kind, validFrom, hits, status}]}], scanned, threshold}`，按 `maxSimilarity` 降序、最多 `limit` 条。
    - **只读**，绝不改数据。
23. **Agent 裁决回路**（自我迭代的主通道）：
    - MCP 暴露 `memory_dedupe_scan`（读）与 `memory_curate_apply`（写，已存在）。Agent 判定后逐簇给 decision：`a_wins|b_wins|merge|keep_both`，由 `curateApply` 落盘（非破坏：败者 superseded + tag `merged`/`coexist`，真相层保留）。
    - `brief` 新增末节「待裁决去重候选 N 条（`memory_dedupe_scan` 查看）」，让**下一个会话**能看见并处理 —— 无人值守也能靠「下次有人用」收敛。
    - `nightly` 打印候选簇数量与 id 列表（`--dry-run` 同样可见），不自动裁决（v0.2 才接 JudgePort/LLM）。
24. **阈值纪律**：在线写入门控阈值 `dedupe.nearDupThreshold=0.85`（宁可漏杀不可误杀）；`dedupeScan` 默认 `0.45`（宁可多给候选不可漏）。两者都只从 `policy.dedupe` 读，且 `policy.json` 增加 `dedupe: {nearDupThreshold: 0.85, scanThreshold: 0.45}`。

## 3.4 第四轮裁决（2026-11-02）

25. **`source.agent` 不收窄为枚举**：改为 `^[a-z0-9][a-z0-9._-]{0,31}$` 的自由标签 + 保留名黑名单（`root|system|admin|sudo|superuser` 拒绝）。理由：写死枚举会让新客户端（grok/opencode/未来的 DS 变体）无法接入，违背「不写死、可迭代」；同时保留「冒充系统身份必须拒」的对抗防线。`KNOWN_AGENTS` 仅用于展示/统计，不参与校验。MCP 的 inputSchema 用 `pattern` 而非 `enum`。

## 3.5 第五轮裁决（2026-11-02，三端接入后补强中文去重）

**实测数据（先看证据再改设计）**：§3.3 的「词法不行」结论是在**英文**改写上得出的。中文侧实测不同——
- 共享名词的中文改写，containment 其实能到 **0.55–0.67**（`部署脚本在 scripts/deploy.sh` / `上线脚本位于 scripts/deploy.sh` → 0.571；`缓存命中率低于 60% 要报警` / `缓存命中率不足 60% 时触发告警` → 0.556），写入门控 0.85 仍不误杀，`dedupeScan` 0.45 已能召回。
- 但**内容词全换**的中文改写 containment = **0**（`生产环境禁止直连数据库` / `线上环境不允许直接连接数据库`），必须另开一路度量。
- 字符二元组 Dice（含拉丁）在英文上不可用：无关英文对误聚 **13.68%**（@0.15），因为 `th/he/ing` 这类碎片到处都有。
- 汉字二元组（CJK-only）Dice 在 40 条无关中文技术事实上误聚 **1.41%**（11/780 @0.15），而中文改写召回 **5/6**。
- 试过 IDF 加权 Dice 想拉开真假差距：**失败** —— 真改写 0.19–0.26，同域无关事实 0.22–0.29，区间重叠，任何阈值都不可分。故不引入 IDF。

26. **`dedupeScan` 改为双路候选（containment + CJK Dice）**：
    - 新增 `signatureSimilarity(a, b)` = 汉字二元组 Dice = `2|A∩B| / (|A|+|B|)`；**任一侧不含汉字 → 返回 0**（英文交给 containment）。`charBigrams(s)` 只取 `normalizeText` 后的 `\p{Script=Han}+` 连续段切 2-gram。
    - 连边条件：`containment ≥ threshold`（默认 0.45）**或** `dice ≥ diceThreshold`（默认 0.15，`policy.dedupe.scanDiceThreshold`）。
    - **两路都只做候选发现，不做判决**；判决仍由 Agent（`memory_curate`）完成。误聚的代价是一次判断，漏聚的代价是重复长期堆积 —— 所以宁可多给候选。
    - `diceThreshold` 可设为 1 关闭该路（度量可插拔，供 v0.2 换 embedder 时对比）。
27. **簇内必须给逐对依据（`pairs`）**：并查集是传递闭包，一条链会把 A 与无关的 C 连进同簇，Agent 若只看 `items` 会误判。因此每簇额外返回
    `pairs: [{aId, bId, containment, dice, score, basis, strength}]`（按 score 降序，最多 20 条），其中
    `strength = 'strong'` 当 `containment ≥ threshold` 或 `dice ≥ 0.30`，否则 `'weak'`。
    **给 Agent 的默认动作建议（不是判决）**：strong → 先怀疑同一事实；weak → 默认 `keep_both`（实测同域无关中文事实落在 0.22–0.29，与真改写重叠）。
    同时 `scan` 结果回显 `threshold`/`diceThreshold`，簇带 `metrics:{maxContainment,maxDice}` 与 `basis`。

## 3.6 第六轮裁决（2026-11-02，三端真实接入暴露的两个问题）

### 问题一：常驻进程让「三端共享分库」名存实亡（发现即修）

DSH 的 MCP server 是 dsh 启动时 spawn 的**常驻子进程**，cwd 固定为宿主目录（实测 `~/.dsh/profiles/desktop`）。
Claude Code / Codex 每次会话按**项目 cwd** 解析。结果：同一项目里 DSH 写进 `dir:desktop`、CLI 读 `dir:<项目名>`，
一边写一边读永远读不到——而三端共享是 C2 硬需求。`MEMO_SCOPE` 也救不了：它是启动期变量，只能把常驻进程钉死在一个项目。

28. **`memory_scope` 工具 + 运行期分库切换**（新模块 `src/mcp/scope-state.js`）：
    - 工具：`{action:'get'}` 回 `{scope, source, memoHome}`；`{action:'use', path?|scope?}` 切换。
      `path` 走**与 cwd 自动解析完全相同**的规则（`core/scope.js` 的 `resolveScope({cwd:path, env:{}})`，
      显式传空 env 是刻意的：调用方说「按这个路径解析」就不该被 `MEMO_SCOPE` 再劫持一次）；`scope` 走形状校验。
    - 启动优先级（高→低）：`MEMO_SCOPE` env > `$MEMO_HOME/.scope.json` 持久化覆盖 > cwd 解析。
      覆盖文件损坏/形状非法一律**静默降级**（不能让 server 起不来）；`MEMO_SCOPE="   "` 视为未设置。
    - server 内 `Map<scope, MemoryService>` 懒建 + 缓存；工具分发器拿到的是**门面代理**，每次方法调用按当前 scope
      解析服务 —— 切换后所有工具立即跟随，无需重启。退出时关闭全部实例。
    - 每次切换写 stderr 一行（`stdout` 只能有 JSON-RPC），并在启动时若 `source==='cwd'` 额外提示
      「常驻进程 cwd 固定，要与其它客户端共享请 `memory_scope({action:'use', path})`」。
    - **覆盖文件按客户端隔离**：`<memoHome>/.scope.<clientKey>.json`，`clientKey` 取自 MCP `initialize`
      的 `clientInfo.name`（`claude-code` / `codex` / `dsh` …，归一化为小写 `[a-z0-9-]`、未知则 `default`）。
      若共用一个文件，DSH 把 scope 切到项目 A 后，Claude 在项目 B 启动会读到 A —— 跨项目污染记忆。
      因此 scope 状态在 `initialize` 时按连接初始化（不是进程启动时），每个连接各自一份。
    - `memo scope [--json]`（CLI）：打印本目录解析出的 scope + `memoHome` + **全部客户端的覆盖文件**，
      是排查「DSH 写的为什么在项目里搜不到」的第一条命令（CLI 自己永远按 cwd 解析，不读覆盖文件）。
    - **诚实边界**：覆盖文件记的是「本客户端上次切到哪」，不是权威（它不知道你这次在哪个项目）。
      所以正确用法是**每个 DSH 会话开始时对齐一次**（Agent 从 system prompt 知道 workspace 路径）；
      否则会出现「DSH 在项目 B 的会话里写进项目 A 的分库」。这条限制写进 INSTRUCTIONS 与 `docs/06-usage.md`。

### 问题二：词法召回的残余空洞（记录，不在 v0.1 修）

实测两条**同一事实**的记录，`textSimilarity=0.1176`、`signatureSimilarity=0.0625`，都低于扫描阈值（0.45 / 0.15）：
- `memo 的记忆真相层用 append-only JSONL 存，条目不可原地修改`
- `记忆的底层是只追加的 JSONL 文件，不允许就地改写记录`

汉字二元组只共享 `记忆` 一个 gram（内容词几乎全换）。**这是 v0.1 已知上限**（召回 5/6 里漏掉的那一条），
降到 0.05 会让「同域无关中文事实」大量误聚（实测 0.15 已 1.41%）。

29. **不为这条空洞降阈值，而是明确「终点在 Agent」**：
    - 不做：降 Dice 阈值、引入 embedding、加"同一 agent 顺序写入即疑似重复"的启发式（会误杀正常连续记录）。
    - 做：`brief` 按时间倒序列出 recent（默认 80 行），相邻两条同义记录**人/Agent 一眼可见**；
      Agent 判定后可用 `memory_curate({action:'apply', decisions:[{ids:[a,b], decision:'merge'}]})` 直接收敛
      （CLI 等价：`memo dedupe apply --file decisions.json`）。**不需要**先被 `dedupe_scan` 召回。
    - 已在真实库上跑通这条路径：两条记录由 Agent 判 `merge` → `active 3→2`、败者 `superseded`、真相层保留
      （3 条写入 + 1 条补丁 + 1 条裁决事件 = 5 行）。语义召回的根治留给 v0.2 的 `EmbedderPort`（已在 03 文档列为候选）。

## 3.8 内部模块导出清单（受质量门禁约束）

质量门禁 `Q5 契约覆盖` 要求 `src/` 的每个 `export` 都能在 `docs/`（不含 `docs/research/`）里被找到——
目的是**新增对外能力必须同步改契约**。下面这些是内部工具函数/常量，不是对外 API，
但仍在此登记，避免"导出即隐形契约"：

| 导出 | 位置 | 作用（内部） |
|---|---|---|
| `migrateDshMemory` | `src/cli/migrate-dsh-memory.js` | 从 dsh-memory 的 SQLite 一次性迁移，CLI 子命令内部实现 |
| `loadPolicy` / `defaultPolicy` | `src/config/policy.js` | 策略唯一加载点与冻结默认值；对外的"契约"是 `config/policy.json` 的键 |
| `dedupeSlotKey` / `clusterNearDuplicates` | `src/hygiene/conflict.js` | `service.dedupeScan` 的候选簇实现；对外契约是 `dedupeScan` 的返回形状（裁决 22） |
| `normalizeForMatch` / `detectSuspicious` / `isSuspicious` | `src/hygiene/suspicious.js` | 投毒检测；对外契约只有"读路径默认遮蔽"语义（裁决 16） |
| `SCOPE_PATTERN` / `scopeFilePath` / `readScopeOverride` / `writeScopeOverride` / `initScopeState` / `resolveUseTarget` | `src/mcp/scope-state.js` | `memory_scope` 工具的纯函数实现；对外契约是工具语义（裁决 28） |
| `validateArgs` | `src/mcp/validate.js` | MCP 参数严格校验；对外契约是"未知参数/缺必填即 isError 且不落库" |

**规则**：对外 API（`createMemoryService` 及其方法、Ports、CLI 子命令、MCP 工具）必须写在
§3 / §3.1–§3.7 正文里；只登记在本节的，改动不需要 ADR，但不得新增未登记的导出
（`tools/contract-exempt.json` 是兜底豁免清单，必须逐条写理由）。

## 3.9 第七轮裁决（2026-11-02，v0.2 Web UI 冻结契约）

设计侧规格见 [`08-web-ui.md`](08-web-ui.md)，施工分解见 [`plans/v0.2-web-ui-plan.md`](plans/v0.2-web-ui-plan.md)。
本节只冻结**实现层必须一致的语义**，四路并行开发只认这里与 `08` §6。

**裁决 30（两个只读查询方法）**

```js
await svc.events({ since, until, ops, limit = 200 })
  // → { events: [{ts,op,scope,id,detail}], scanned, truncated }
await svc.exportRecords({ since, until, status = 'active', kind, limit = 2000 })
  // → { records: [record], total, limited }
```

- 两者**只读**：读事件不得写 `events.jsonl`（否则 `hit` 自我放大）。
- 时间窗一律 `[since, until)` 半开区间，按 `ts` 字符串比较（`ts` 为 UTC ISO8601，字典序 == 时间序）。
- `truncated`/`limited` 为 true 表示「命中数超过上限被截断」，调用方必须提示用户，**禁止静默截断**。
- `exportRecords` 默认 `status='active'`，`status:'all'` 表示不过滤；suspicious 记录默认遮蔽为 `[suspicious withheld]`（沿用裁决 16），需原文时显式 `includeSuspicious:true`。

**裁决 31（metrics 按 scope 分文件）**

- 写入：`metrics/<date>.<scopeKey>.json`，其中 `scopeKey = scope.replace(/[^a-z0-9._-]+/gi,'-')`。
- 读取：先找新名，找不到再回退旧的 `metrics/<date>.json`（兼容 v0.1.0–0.1.2 的历史文件）。
- 理由：`<date>.json` 在多分库同日运行时互相覆盖，属静默数据丢失。

**裁决 32（按自然日切片由调用方给时区）**

- `/api/today?date=YYYY-MM-DD&tzOffset=480`、`/api/timeline?days=30&tzOffset=480`：`tzOffset` 为**分钟、东为正**，缺省 0（UTC）。
- 服务端换算：`from = Date.parse(date + 'T00:00:00Z') - tzOffset*60000`，`to = from + 86400000`，再按 `[from, to)` 过滤。
- 服务端**不猜**服务进程时区（常驻进程时区不可靠，见裁决 28 的同类理由）。

**裁决 33（图谱由服务端派生，UI 不做关系推断）**

- 节点集合：`status ∈ {active, superseded}` 的记录，上限 `limit`（默认 300），排序按 `createdAt` 降序 + `hits` 降序取前 N；返回 `sampled: {shown, total}`。
- 边四类（`type` 唯一取值）：
  - `same-entity`：同一 `subject` 且该组记录数 ≥2，两两连边，`weight = 1`；
  - `supersedes`：记录 `supersedes` 字段指向的旧 id → 新 id 有向边，`weight = 1`；
  - `duplicate-of`：来自 `dedupeScan` 的 `pairs[]`，`weight = pairs[].score`；
  - `disputed-with`：`status='disputed'` 的记录与其同 slot 的 `status='active'` 记录之间，`weight = 1`。
- 节点 `label` 由服务端生成：有结构时 `subject/predicate`，否则 `text` 前 60 字（+ `…`）。**UI 不得自行拼接 label**。
- `degree` 为节点在返回边集中的度（无向计一次、有向计出度+入度）。

**裁决 34（Web 层不得越权）**

- `src/web/*` 只允许 `import` `src/api/service.js`、`src/core/*`、`src/config/*`；**禁止** import `src/hygiene/*`、`src/storage/*`、`src/index/*`（关系与判定都在 service 内完成，Web 只做投影）。
- 静态资源只从 `versions/v0.1/ui/` 读取；路径穿越（`..`、绝对路径、软链接）一律 404。
- 服务只绑 `127.0.0.1`；无鉴权（用户决策 D1），因此**不得**提供任何写操作端点。

## 3.10 第八轮裁决（2026-11-02，v0.1.3 Web 只读层实现期冻结）

实现期发现的四个语义问题，与 §3.9 裁决 30–34 叠加生效；冲突时以本节为准。

**裁决 35（same-entity 边是时间链，不是全连）**

- 同一 `subject` 组内不再两两连边，改为**按 `createdAt` 升序只连相邻两条**（链式）。
- 理由：一个同 subject 17 节点的组全连产生 C(17,2)=136 条互相重叠的边，视觉上是毛球、信息量为零；链式边表达「同一实体的时间序列」，且边数 O(n)。
- 取代 §3.9 裁决 33 中 `same-entity`「两两连边」的描述；`weight` 仍为 1，边方向为旧 → 新。

**裁决 36（curate_apply 事件按裁决键聚合）**

- 一次 `curate_apply` 在事件流里会写 **loser + winner 两条事件**；`/api/today`、`/api/timeline`、`/api/hygiene` 三处统计必须按**裁决键**聚合为一次动作，禁止按写盘条数计数。
- 裁决键：`detail.batchId + '#' + detail.pairIndex`；无 batchId（ids 形状）时用 `detail.ids` 排序拼接。实现见 `src/web/handlers.js` 的 `curateKeyOf()`。

**裁决 37（label 一律服务端生成，延续裁决 33）**

- 图谱节点：短标签 `subject/predicate`（无结构时 `text` 前 60 字 + `…`）。
- 今日时间线与清理史行：`subject/predicate：值前 40 字`（`makeLabel` 的长格式）。
- UI 只绘制不拼语义；节点标签在画布重叠时允许跳过绘制（点节点看详情兜底），但这不改变「语义只产自服务端」的边界。

**裁决 38（趋势序列暴露 activeRatio，坐标系统一为百分比）**

- metrics 序列给 Web 层额外暴露 `activeRatio = active / maxActive`（相对配额占比，0–1；`maxActive` 缺失时按 5000 兜底，序列里带出实际使用的 `maxActive`）。
- UI 趋势图三条线（activeRatio / dupRatio / conflictRate）一律以百分比绘制；**不得把 active 绝对条数与比率放进同一坐标系**（量纲不同，双轴混排会制造假相关性）。

**Web 只读层冻结导出清单（补 §3.8 登记，Q5 契约覆盖用）**

| 模块 | 导出 | 职责 |
|---|---|---|
| `src/web/server.js` | `createWebServer` | `node:http` 服务器，绑 `127.0.0.1`，SIGINT/SIGTERM 优雅关闭 |
| `src/web/handlers.js` | `ENDPOINTS` | 端点路径白名单（7 个 `/api/*`） |
| `src/web/handlers.js` | `handleApi` | `/api/*` 统一分发：参数校验（非法 400）、`ok:false` 错误形状、裁决键聚合 |
| `src/web/handlers.js` | `makeLabel` | 裁决 33/37 的 label 生成（节点短标签 / 时间线长格式） |
| `src/web/handlers.js` | `dayWindow` | 裁决 32 的自然日窗口换算（`[from,to)` 半开区间） |
| `src/web/handlers.js` | `readMetrics` | 裁决 31 的新旧文件名兼容读取 + 裁决 38 的 `activeRatio` 派生 |
| `src/web/static.js` | `createStaticHandler` | `ui/` 静态文件白名单服务；目录缺失降级 404；路径穿越一律 404 |

### 3.11 第九轮裁决 39–44（v0.2 双审核整改：常驻进程一致性 / 遮蔽 / 回环 / 拆分 / 导出顺序）

> 来源：`versions/v0.1/reviews/arch-v0.2.md`（5 严重）与 `reviews/adversarial-v0.2.md`（4 严重）。
> 两路结论均为「阻断项 no」，但以下五条属于「结构上会腐化」的问题，本版一次修掉并冻结语义。

**裁决 39（常驻只读进程必须显式刷新视图）**

- `MemoryService.refreshView()` 是读路径的刷新入口：按真相层文件大小水位增量重读，文件未变只做一次 `stat`；文件变短退化为全量 `_reload`；同实例并发调用共享同一在途 Promise（`_refreshPromise`），重复消费的快照按 `validTo/status/contentHash/hits` 全等跳过。
- `src/web/server.js` 必须在**每个 `/api/*` 请求**处理前 `await svc.refreshView()`。理由：Web 进程永不写库，`_records` 会冻结在启动时刻，导致「今日 +1 条、图谱/记录数不变」的自相矛盾截面。
- 任何新的常驻读端（未来的 TUI、导出守护进程）同样必须遵守本裁决；违反它的症状是「截面撕裂」，不是崩溃，因此必须有集成测试兜底（I14 跨进程用例）。

**裁决 40（图谱节点集含 disputed，否则冲突边是死条款）**

- 节点准入 `status ∈ {active, superseded, disputed}`；disputed 节点按 `docs/08-web-ui.md §5.2` 用红色描边呈现。
- 理由：`disputed-with` 边的 `from` 端恒为 disputed 记录；若节点集不含 disputed，该边永远悬空被 UI 丢弃，等于「契约里有一条永远画不出来的边」。
- 节点采样上限与排序不变（`createdAt` 降序 → `hits` 降序 → `id`）。

**裁决 41（回环绑定与超时是结构保证，不是门禁纪律）**

- `createWebServer({host})` 运行时校验：`localhost`、`::1`、`127.0.0.0/8` 之外一律抛 `E_INVALID_ARG`。`0.0.0.0` 与空串视为非法。
- `server.headersTimeout=10000`、`requestTimeout=15000`、`keepAliveTimeout=5000`；`close()` 先 `closeIdleConnections()` 再 `server.close()`。
- 理由：门禁 S9 只能检查源码里的默认值，挡不住调用方传参；本地只读服务不该被一条半截连接的 socket 拖住关闭。

**裁决 42（suspicious 遮蔽覆盖全部正文字段）**

- 遮蔽字段：`text`、`value`、`subject`、`predicate`、`source.quote`，统一占位 `[suspicious withheld]`；`source.agent` 保留（它是身份，不是正文）。
- 单一实现：`src/api/mask.js` 的 `maskSuspiciousRecord(r, includeSuspicious)`；`MemoryService._maskSuspicious` 与 `read-only.js` 的导出投影都必须调它，禁止各写一份。
- 理由：只遮 `text/value` 时，把 payload 挪进 `subject` 或 `source.quote` 就能原样出网（审核实测 `/api/records` 返回 `SECRET-SUBJECT-POISON`）。

**裁决 43（质量门禁 Q9 的阈值有实现，且 UI 模块按行数上限拆分）**

- `docs/08-web-ui.md §8` 声明的 Q9 语义已在 `tools/quality-check.mjs` 落地：`ui/` 零构建（无 `package.json`/锁文件/`node_modules`/`dist`/`build`）＋**单文件 ≤600 行**＋**`ui/` 总量 ≤2500 行**＋HTML 资源引用只允许相对路径。
- 因此 `ui/graph.js` 拆为 `ui/layout.js`（纯布局与视觉常量，被 node 单测直接覆盖）与 `ui/graph.js`（渲染与交互）。今后超线请拆模块，不要放宽阈值。

**裁决 44（导出顺序稳定，禁止在随机子集里过滤）**

- `queryExportRecords` 在截断**之前**按 `createdAt` 升序、同刻 `id` 升序排序；`total` 仍是过滤后总数，`limited` 表示是否被 `limit` 截断。
- 理由：`_records` 是 `Map` 插入序；不排序时 `/api/records?q=…` 的 `q` 过滤发生在 `limit` 截断之后，记录数超过 `limit` 时搜索结果既不可复现也不完整（审核 A3/B8）。

**第九轮新增导出（补 §3.8 登记，Q5 契约覆盖用）**

| 模块 | 导出 | 职责 |
|---|---|---|
| `src/config/paths.js` | `scopeKeyOf(scope)` | scope → 文件名安全片段（裁决 39 的命名单一来源；`repo:strata` → `repo-strata`） |
| `src/config/paths.js` | `metricsFileName(date, scope)` | metrics 快照文件名 `<date>.<scopeKey>.json`（写侧唯一入口） |
| `src/config/paths.js` | `legacyMetricsFileName(date)` | 旧命名 `<date>.json`，仅供读侧兼容回退 |
| `src/api/mask.js` | `maskSuspiciousRecord(r, includeSuspicious)` | 裁决 42 的遮蔽单一实现 |
| `src/api/read-only.js` | `queryEvents(service, args)` | 裁决 30 的事件只读查询（`Nightly`/Web 共用） |
| `src/api/read-only.js` | `queryExportRecords(service, args)` | 裁决 30 的记录导出（含遮蔽与 `limited` 语义） |
| `src/api/service.js` | `refreshView()` | 裁决 39 的读路径刷新（方法，非模块级 export） |

### 3.12 第十轮裁决 45–47（v0.2.1：索引后端可插拔 / curate 任务包 / 身份常量单点）

> 来源：issue #20（SQLite FTS5 索引）与 #21（curate 裁决任务包）。设计细节见 `docs/09-sqlite-index.md`、`docs/10-curate-auto.md`；
> 本节只冻结**跨模块必须一致**的语义。

**裁决 45（IndexPort 只有一个注入点，索引是纯派生层）**

- `MemoryService` 不得自行 `new InvertedIndex()`；索引一律由 `src/index/create-index.js` 的 `createIndex({policy, memoHome, scope, clock})` 构造。
- IndexPort 契约（与 `src/index/inverted-index.js` 完全一致，两种后端不得有第二套语义）：`build(records)`、`add(record)`（同 id 覆盖、无 id 抛 `E_INVALID_RECORD`）、`remove(id)`、`search(query,{limit,filter})` → `{id,score}[]`（只返回 `score>0`，score 降序、同分 id 升序，**先打分后 filter**，`limit` **缺省默认 10 且两个后端必须一致**——要全量就显式传 `index.size`）、`get size()`。
- `policy.index.backend`: `memory`（默认）| `sqlite`。选 `sqlite` 但运行时不具备 `node:sqlite` 或 FTS5 → **启动即抛 `E_INDEX_UNAVAILABLE`**；禁止静默降级（静默降级会让「开了 sqlite 却慢」变成玄学）。
- 索引文件 `$MEMO_HOME/index/<scopeKeyOf(scope)>.sqlite`（WAL）；`docs` 表 + `docs_fts` external-content + 三个触发器；损坏（打开失败或 `docs` 与 `fts` 行数不符）→ 删三个文件重建并告警。
- 检索一致性由 I16 保证：同批查询两后端 top-k 集合相等（同分并列允许多解）。

**裁决 46（curate 任务包 = 幂等键 + 严格校验 + 只读候选来源）**

- 候选**只能来自** `service.dedupeScan()`（裁决 26/27 的 pairs/metrics/basis/strength）；CLI 与 MCP 不得各自重算相似度。
- 任务包落盘 `$MEMO_HOME/curate/<batchId>.md`（人读）+ `<batchId>.json`（机读）；`batchId` 形如 `batch-<ISO 去冒号>-<4 位随机>`，是**幂等键**：同一批次重复 apply 只把已裁决对计 `skipped`，不重复写事件。
- `apply` 的校验顺序与原子性：V1 解析 → V2 批次存在 → V3 `decision ∈ {merge,a_wins,b_wins,keep_both}` → V4 `ids` 必须等于任务包内某一对（排序后比对，与顺序无关）→ V5 同 pair 不重复；**任一失败一条都不落盘**（`E_INVALID_ARG` 带人话）。V6（记录已 tombstone/superseded）不是错误，记 `skipped` 并报告。
- `memo curate status` 的进度**只从事件流** `curate_apply` 按裁决键（裁决 36）聚合，不引入状态文件（状态文件必然与真相层漂移）。
- 无候选时 `curate prompt` 正常退出 0 并打印说明，不报错。

**裁决 47（身份模式常量单点定义，CLI/MCP 共用）**

- `AGENT_PATTERN`（`^[a-z0-9][a-z0-9._-]{0,31}$`）与 `RESERVED_AGENTS`（`root|system|admin|sudo|superuser`）只允许在 `src/core/record.js` 定义，`src/cli/memo.js` 与 `src/mcp/server.js` 必须 import 复用。
- 起因：v0.1.3 的 CLI 曾自己维护一份 6 值枚举（`dsh|codex|claude|cli|test|unknown`），与裁决 25「agent 是自由标签」冲突，导致 `--agent cli-writer` 被拒——典型的「同一规则两处实现必然漂移」。

**第十轮导出登记（Q5 契约覆盖用）**

| 模块 | 导出 | 职责 |
|---|---|---|
| `src/index/create-index.js` | `createIndex({policy, memoHome, scope, clock, sqliteModule})` | 裁决 45 的唯一索引构造点；`sqliteModule` 仅测试注入 |
| `src/index/sqlite-index.js` | `SqliteIndex` | FTS5 + BM25 的 IndexPort 实现（WAL、单事务、损坏自愈） |
| `src/index/sqlite-index.js` | `buildMatchExpr(query)` | 查询构造纯函数（同源 `tokenize()` → 字面量 → ` OR `；空则 `null`） |
| `src/api/mask.js` | `SUSPICIOUS_MASK` | 裁决 42 的占位串（`'[suspicious withheld]'`），UI/服务端共用 |
| `src/cli/curate.js` | `curatePrompt(service,{limit,json})` | 裁决 46：生成任务包（md + json）并返回摘要 |
| `src/cli/curate.js` | `curateApplyFile(service, filePath)` | 裁决 46：校验（V1–V5）后逐条 apply，返回 `{applied,skipped,results}` |
| `src/cli/curate.js` | `curateStatus(service)` | 裁决 46：按事件流聚合批次进度 |
| `src/cli/curate.js` | `validateDecisions(pkg, decisions)` | V3–V5 的纯校验（可单测，不碰 IO） |
| `src/cli/curate.js` | `pairKeyOf(ids)` | 排序后拼 pair 键（裁决 36 的裁决键同源） |
| `src/cli/curate.js` | `pairsFromScan(scan)` | 把 `dedupeScan` 结果投影成任务包 pairs（唯一来源） |
| `src/cli/curate.js` | `readBatchPkg(memoHome, batchId)` | 读机读任务包；缺失/损坏返回 `null`（不抛） |
| `src/core/record.js` | `AGENT_PATTERN` | 裁决 47 的唯一身份正则 |
| `src/core/record.js` | `RESERVED_AGENTS` | 裁决 47 的保留名集合 |
