# 未来架构：记忆治理内核与个人 AI 端点

状态：待批准（四轮对抗审核完成，无 blocker；记录见 §17.3）
依据：m00089 用户指示「把未来架构写进计划、对抗性审核到没问题」，以及 2026-11-14 的四轮对抗审核（4 + 2 + 1 + 1 名审核者）
版本规则：本计划不绑定版本号。阶段是工作单元，何时拆成哪个版本由维护者排期决定。阶段结论写入后补「执行结果」节。

> 本文是**未来计划**，不是当前版本规格。当前行为以 `versions/v1.0/` 与 `docs/02` 为准。
> 标注「已有 / 部分 / 缺失」的地方，均已对 v1.0.3 源码核实。

---

## 0. 结论先行

1. **项目定位收窄为「决策与坑的可审计账本」**：跨 agent、append-only、冲突可失效、as-of 可回查。对外一句话：*It remembers why you decided that — and shows you the receipt.*
2. **不重做存储内核**。检索、去重、四道门已是资产；下一步补的是「捕获的签名与去污」「按任务装配」「按来源删除」，不是换数据库、不是换检索算法。
3. **不做通用 agent 框架、不做聊天 UI、不做全屏录制、不做连接器数量竞赛**。
4. **阶段顺序按用户感知价值排**，不是按模块完整度：
   - **P0a 地基**：CI/门禁/文档先变真（当前 CI 跑的是 v0.3，`docs/07` 声明的必需检查从未运行）。
   - **P0b 语义与信任**：锁、鉴权、权限、trust/taint、按来源删除。没有这些，后面每一步都在放大不可审计性。
   - **P1 装配**：`memory_pack` + `export agents-md` + `init/audit`。零迁移即可感到「答得更准」。
   - **P2 导入**：只读导入 claude-mem / AGENTS.md / git / `.ics`，不做 hook 矩阵。
   - **P3 行动**：最小 scheduler + supervisor + 审批队列。
   - **P4 个人端点**：网关 + profile + 默认拒绝。**可选**，有真实第二消费者才做。
   - **P5 一致性套件**：把 I-1–I-50 抽成可对任意记忆库跑的卫生套件，不是排行榜。
5. **设计变更前置**：本计划有意改变若干现行契约（C1/C6 口径、锁、鉴权、信任字段、审计链、profile 布局）。按 `docs/plans/README.md`「计划不改设计」，这些必须先改 `docs/` 规格或落 ADR、并开 issue，再进代码。清单见 §6.0。
6. **十三项阻塞项在本计划中全部有归属**（§17.1）；两轮审核发现的 4 条错误、4 条未闭合、8 条 must-fix 已按 §17.3 修订；第三、四轮 delta 复核无 blocker。

**如果只能做一件事**：P1 的 `memory_pack`。它用现有数据就能验证「装配比全文注入更省且更准」，是整条路线唯一的单点验证。

---

## 1. 为什么是现在这个切口

### 1.1 已有资产（2026-11 实测）

| 资产 | 状态 | 证据 |
|---|---|---|
| 真相层 append-only + 派生层可重建 | 已有 | `docs/02`；651 tests / 50 eval |
| 写入四道门（schema / 脱敏 / 去重 / 冲突） | 已有 | `versions/v1.0/src/core/`、`hygiene/` |
| BM25 + 语义 + RRF、degraded 显式降级 | 已有 | `index/search.js`、`api/search-path.js` |
| 三端共用一份记忆 | 已有 | DSH 插件、MCP server；Codex/Claude 走 MCP |
| 会话决策/坑自动晋升 | 部分 | `session/cli-support.js`（close 时白名单晋升） |
| 夜间确定性整合 | 已有 | `cli/nightly.js`、`config/policy.js` |
| 治理门禁 | 部分 | `quality-check` 14 项、`security-check`、`coverage-gate`、`docs-drift`；**但 CI 未指向当前版本** |

### 1.2 竞争格局（2026-11-14 实测，star 会漂移）

| 项目 | 事实 | 对我们的含义 |
|---|---|---|
| mem0（68,936★） | v3 ADD-only，**明确不做 UPDATE/decay**，旧事实永不失效 | 它放弃的正是我们要做的治理；但它有分发与连接器 |
| Hindsight（60,937★） | 四网（world/experience/observation/opinion）、事实-信念分离、Postgres+pgvector、写入时压成本 | 最接近的「认知架构」参照；依赖重，不是单人本机形态 |
| claude-mem（116,912★） | 6 个 hook、SQLite+FTS5、支持 6+ harness（含 dsh） | **钩子层已被占**；我们只做只读导入，不建 hook 矩阵 |
| Graphiti（32,800★） | 时序知识图谱、bi-temporal | 图模型完整，但需要图库，违反 C6 |
| Letta / cognee / MemOS / supermemory | 各自有记忆 OS / 图谱 / 分层记忆 | 都是平台级，不是「可审计账本」 |
| Lanes Link（36★，lanes-sh/link） | 一条本地 MCP 端点：connections + memory + tasks + files + contacts + secrets；profile 隔离；默认拒绝；append-only 审计；Markdown 存储 | **最直接的重叠者**；它已发货我们计划里 P0b–P3 的大部分。**本期不做它的超集**；长期可做它的 memory provider（非承诺，§18-2） |
| OpenHuman / Screenpipe | 前者转向 agent harness，后者转向流程挖掘 | 证明「全量捕获」不是单人可持续路线 |
| AGENTS.md / SKILL.md / MCP | 均已捐给 Linux Foundation AAIF；AGENTS.md 60k+ 项目；Skill 70+ 平台 | 接入标准，不发明标准 |

**结论**：检索与钩子都不是空位。**「决策与坑的可审计治理」仍是空位**——也是我们唯一已有深度的位置。

### 1.3 反证：为什么不是别的三件事

- **为什么不做第二个 claude-mem？** 钩子矩阵要跟 harness 升级赛跑，且已被 116k★ 项目占住；我们只做只读导入，成本低一个量级。
- **为什么不做第二个 Lanes Link？** 它 36★ 说明「个人端点」目前没有拉力；跟做只会得到它的子集。等我们有 pack 的真实使用证据再说。
- **为什么不做 benchmark 榜单？** 74★ 的自测榜单不可信且太晚；BEAM（arXiv 2510.27246）已把矛盾消解列为主要短板。做「一致性套件」——让别人能复现我们对任意记忆库的判定。

---

## 2. 当前债务（不修就会在新架构里放大）

| # | 债务 | 证据 |
|---|---|---|
| 1 | CI 跑的是 v0.3，`coverage-gate` 写死 v0.1，651 个测试从未在 CI 执行 | `.github/workflows/ci.yml:36,64`；`tools/coverage-gate.mjs:18` |
| 2 | Q1「全仓零依赖」会让引入 SDK 的 adapter 直接红 | `tools/quality-check.mjs:91-116` |
| 3 | 仓库无根 `package.json` / lockfile / workspace；插件 `lib/src` 是拷贝（44 文件 / 8,828 行，与 v0.4 差 20 处） | `plugin/dsh-sedimem/`；`scripts/sync-plugin.sh` 只同步 2 文件 |
| 4 | `~/.memo` 已是 880K items，无 workspace 级 profile/迁移测试 | `~/.memo/items/`、`events/`、`brief/`、`metrics/`、`derived/` |
| 5 | 版本矩阵：6 个版本目录 × 3 端 × 3 OS，一人维护不动 | `versions/v0.1`–`v1.0` |
| 6 | 锁：30s 判陈旧、不刷心跳；inbox 另有一套锁 | `storage/lock.js:18,37`；`capture/queue.js:35` |
| 7 | 信任：inbox 无签名；accept 丢来源；记录无 trust/taint | `capture/queue.js:28-29,195-200`；`core/record.js:120-160` |
| 8 | Web：无 token、Host 不校验、缺失 Origin 放行 | `web/server.js:93,101-109`；`web/api/write.js:43` |
| 9 | 权限：全仓仅一处 0o600；`~/.memo` 会被 Time Machine/iCloud 备份 | `index/vector-index.js:120`；`config/paths.js` |
| 10 | 读路径把 hits 写回真相层，pack 非纯派生 | `api/search-path.js:150`；`api/lifecycle.js:152` |
| 11 | 凭据走 env 会被 `printenv` / `ps eww` / 子进程读走 | §10 改为 Keychain + fd/pipe |
| 12 | 文档口径漂移：README 写覆盖率 89/90/77、12 模块；实际 85/70/90、14 目录 | `README.md:55-59,200`；`docs/07:56-58` |
| 13 | `engines.node` 写 `>=22`，但 transcript 的 zstd 需要 `>=22.15` | `versions/v1.0/package.json`；`session/transcript.js:70-81` |

---

## 3. 架构总览

```
┌───────────────────────────── 客户端 ─────────────────────────────┐
│  DSH 插件   Codex MCP   Claude MCP   CLI   Web 观察台            │
└───────────────┬─────────────────────────────────────────────────┘
                │ 只读查询 / 带签名的候选写入（MCP / CLI / HTTP）
┌───────────────▼─────────────────────────────────────────────────┐
│                    kernel（一个进程，零运行时依赖）               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ capture  │ │ govern   │ │assemble  │ │ observe  │            │
│  │ 验签/隔离│ │ 四道门   │ │ pack     │ │ brief/   │            │
│  │ 待审队列 │ │ 裁决/失效 │ │ 预算/分区│ │ audit    │            │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘            │
│  真相层 items/*.jsonl（append-only）  events.jsonl（审计唯一源）  │
└───────────────▲─────────────────────────────────────────────────┘
                │ 候选投递（Ed25519 签名信封；不接触 MEMO_HOME）
┌───────────────┴─────────────────────────────────────────────────┐
│  adapters（独立进程，各自私钥，允许依赖，可崩溃）                 │
│  git · 本地文档 · .ics · claude-mem 导入 · AGENTS.md 导入         │
└─────────────────────────────────────────────────────────────────┘
                │ 可选：仅当出现第二消费者
┌───────────────▼─────────────────────────────────────────────────┐
│  gateway（可选旁路，不承接内核写；聚合 + 默认拒绝 + 审计转发）     │
└─────────────────────────────────────────────────────────────────┘
```

### 3.1 不变量（每条配负向测试）

| ID | 不变量 | 测法 |
|---|---|---|
| I-1 | 常规运行只追加；**`compact` 是唯一例外**（显式维护操作，写 ADR + 审计事件）；读路径与 pack 永不触发 compact | 写 100 条后 `items` 行数只增；`pack` 前后行数不变 |
| I-2 | 派生层（index / brief / views / vectors / projections）删光可重建，且重建结果与 asOf 冻结的基线一致 | 删除派生目录后 rebuild，逐字节比对 |
| I-3 | **数据锁**统一在 storage 层（items / inbox / events 共用一把 `<memoHome>/.lock`）；`llm/outbox` 保留独立锁（Q15 禁止 `llm` 依赖 `storage`，写理由进 ADR） | 两把锁的 key 集合断言；两进程并发 append 无丢写 |
| I-4 | adapter 不读 items / inbox / events；不接收 `MEMO_HOME`；只持自己的私钥；只通过 ingest 投递 | `spawn` 清 env 后 adapter 无法定位 `~/.memo`；直写 items 必须失败并写 `acl.deny` |
| I-5 | 外部读取默认最小：search 只回 id + 片段（单条 ≤200 字，默认 ≤N 条/次），每次会话有字节预算 | 超预算报错；`search` 不返回正文 |
| I-6 | 同一 `asOf` 的 pack 逐字节相等（确定性排序；nonce 由 `hash(contentHash+asOf)` 确定性派生） | 同参数两次 pack `diff` 为空 |
| I-7 | 冲突可失效、as-of 可回查；`superseded` 是失效不是删除 | 旧 asOf 能检出新旧两版；新 asOf 只回有效版 |
| I-8 | 出站默认关闭；adapter 无网络默认断网；目的地白名单在 socket/HTTP 层强制 | 未声明目的地时 POST 被拒 |
| I-9 | C6 口径：每客户端 ≤1 kernel + ≤1 可选 daemon；无 daemon 功能全集可用；常驻 RSS <100MB | 新增 `tests/invariance/i9-*.js` 断言进程数/依赖/RSS |
| I-10 | profile 显式映射，不跨 profile 读；**默认 profile 固定在 `~/.memo`**，命名 profile 在 `~/.memo/profiles/<name>/`，不做物理迁移 | 切 profile 后 `memory_get` 看不到旧数据；缺失指针 fail-closed |
| I-11 | T2 内容默认不注入原文；必须注入时只注入结构化抽取，围栏加确定性 nonce，并逐行转义所有分隔符 | canary T2 不得触发任何工具调用/出站 |
| I-12 | 逻辑删除是默认语义；审计脱敏只追加「脱敏事件」，**不改历史行**（否则 prevHash 链断） | 删除后 `get` 为空但链仍可验；脱敏后旧行 hash 不变 |
| I-13 | 协议版本由写入端盖章；旧 kernel 遇未知大版本拒收，不 fail-open | 用 v2 信封打 v1 kernel → `E_PROTOCOL_UNSUPPORTED` |
| I-14 | Q 门禁冻结为 14 项（Q1–Q11、Q13、Q14、Q15）；新增不变量走 G 系列，不挤 Q | `quality-check` 断言 Q 集合 = 冻结集合 |

### 3.2 边界规则（可检查，不是口号）

- **B1 读写分离**：`api/*` 不直接碰 `storage/jsonl-store.js`；以 `tests/unit/arch-boundaries.test.js` 为起点扩展到根包。
- **B2 依赖方向**：kernel 不 import adapters / plugin；adapters 只依赖 `packages/protocol` 与自身 SDK。
- **B3 副作用隔离**：`render/*`、`views/*` 纯函数；`Date.now()` / `process.env` 只在入口注入。
- **B4 版本冻结**：每个 `versions/vX.Y/` 下有 `FROZEN.md`（v0.1–v0.6 已有；v1.0 尚未冻结，故可改）；`versions/CURRENT` 是**文件**，内容是版本名；跨版本不共享代码路径（`docs/03:32-36`）。
- **B5 网关失败策略**：网关是**可选旁路**（默认不启用），在环时结果与直连逐字节一致；半死时客户端必须显式报 `degraded`，不静默降级。
- **B6 无隐式全局**：`MEMO_HOME` 只经 `config/paths.js#resolveMemoHome` 解析；`src` 层不读 `process.env`。

---

## 4. 信任模型

### 4.1 四个信任级

| 级 | 来源 | 默认处置 |
|---|---|---|
| **T0** | 维护者本人；`memo write` / 本人 CLI；已签名的 adapter 且经人工提升 | 可进 `facts` |
| **T1** | 本机可信来源：git 作者过滤后的提交、本人日历/文档 | 可进 `facts`，带 `provenance` |
| **T2** | 远程内容：网页、第三方邮件、共享文档、未知 adapter | 只进 `references`；默认不注入原文；需人工 `memo trust promote` 才可进 `facts` |
| **T3** | 未注册 adapter、来源不明、解析失败 | 只存引用（URI + hash + ≤200 字摘录），不进上下文 |

**存量记录的 backfill 规则（防止迁移后 pack 变空）**：只对迁移时已存在、缺少 `trust`、`source.agent ∈ {cli, dsh}`、且无 `adapter` / `sourceRefs` / import 类 tag / `provenance` 的记录补 `T0`；其余（含 `claude` / `codex` / 任何带 import 痕迹的）补 `T1`（有本地来源）或 `T2`（来源不明）。backfill 只运行一次并记录 `backfillDone`，**导入开始后不得再提升**；写 ADR、可回滚，并测「import 后 backfill 不提升」。

### 4.2 记录新增字段

```json
{
  "trust": "T2",
  "taint": ["untrusted-source", "email"],
  "sourceRefs": [{ "adapter": "gmail", "uri": "msg://...", "hash": "sha256:..." }],
  "provenance": { "adapter": "gmail", "kid": "gmail-2026-11", "ingestedAt": "..." }
}
```

规则：

- `taint` **单调不减**：copy / dedupe / supersede / merge / session 晋升都取并集。
- `merge` / `supersede` **必须追加新版本 `v+1`**，携带并集污点；`noop` 路径（`api/write-path.js:135-140`）不得只写事件而丢掉合并后的污点。
- `trust` 只能由人工 `memo trust promote` 提升，提升写审计事件；`accept` 只继承候选的 trust，不自行提升。
- 去污（`memo trust clean`）是独立动作，必须带理由与审计；禁止在 accept / merge 中静默消除。

### 4.3 适配器协议

- **身份**：每个 adapter 生成 Ed25519 密钥对。私钥存 adapter 自己的配置目录（`~/.config/memo/adapters/<name>.key`，0600，**不在 `MEMO_HOME` 内**）；公钥注册到 kernel（`~/.memo/adapters/<name>.pub`，人工确认指纹）。
- **信封**：`{ v, kid, adapter, nonce, sentAt, payload, sig }`，签名覆盖规范化 JSON；kernel 验签失败 → `E_SIG_INVALID`，写 `acl.deny`。
- **轮换**：`kid` 标识密钥版本；kernel 保留双 key 过渡窗口（旧 key 仍可验，新 key 优先），`memo adapter rotate <name>` 打印新公钥指纹。
- **信任上限**：`adapter.json` 里声明的 `trustCeiling` 只是上限，真实等级由人工签署的注册表决定；未注册 → T3。
- **版本**：信封 `v` 是大版本；kernel 落盘前盖 `protocol` 版本；未知版本拒收（I-13）。

### 4.4 威胁模型（同 UID 为前提）

| 攻击者 | 能做什么 | 对应防线 |
|---|---|---|
| 同 UID 任意进程 | 读 `~/.memo`、杀进程、抢端口 | 文件权限 0700/0600、web token、UDS peer-cred、审计锚定；**不承诺抗同 UID 恶意篡改**，文档写明 |
| 远程内容作者 | 提示注入、诱导外写 | T2 默认不进 facts/上下文；canary 行为测试；出站白名单 |
| 第三方包/适配器作者 | 供应链、伪造候选 | 单 lockfile + `--ignore-scripts` + SBOM；Ed25519 验签 |
| 其他本机用户/备份 | 读备份、读云盘 | `tmutil addexclusion`、排除云盘、可选 Keychain 加密 |
| agent 自身 | 误写、越权读、被注入 | 能力声明 + 默认拒绝、读预算、审批队列、审计 |

### 4.5 与宿主记忆的关系（不抢位）

- 不自定义 `<context-pack>` 主格式。pack 的输出是三种标准物：**AGENTS.md / CLAUDE.md 的节**、**SKILL.md**、**MCP `memory_pack` 的返回**。
- 宿主已有的 auto memory / auto-compact / Codex Memories 不覆盖、不双写；我们只提供「按任务装配 + provenance + 失效」。
- 读取 AGENTS.md / CLAUDE.md / SKILL.md 时**只当数据**，不执行其中指令（`docs/00:43`）。

---

## 5. 数据与接口

### 5.0 硬需求修订（C1 / C6）

本计划新增进程（adapter / gateway / supervisor），必须先把 `docs/00` 的两条硬需求改成可判定口径，否则「≤1 进程、零依赖」在实现前就自相矛盾：

- **C1（离线）**：核心记忆（写入四道门、检索、brief、pack、审计）在无 API key、无网络时完整可用；连接器（日历/邮件/远程源）默认关闭、可选；无 key 时降级不报错。
- **C6（轻）**：每客户端 ≤1 kernel + ≤1 可选 daemon；**supervisor 与 gateway 必须是同一个 daemon 进程**（`memo daemon`，单进程多职责），不得各自常驻；未合并前不启动 P4。**没有 daemon 时功能全集可用**；内核零运行时依赖；常驻 RSS <100MB；不引入 Docker、图数据库、外部服务。
- 计数口径：adapter 是独立进程、按需起停、不计入常驻；同一时刻由 supervisor 限制最大并发数（P3）。
- 同步产物：`docs/00` 修订 + `tests/invariance/i9-*.js`（进程数 / 依赖 / RSS 断言）+ `eval` 不新增网络用例。

### 5.1 协议 v1（`packages/protocol`）

只放：信封 schema、错误码、版本、context pack schema。**不放实现**。内核和 adapter 各自复制/依赖同一份 JSON Schema 与类型；跨版本只承诺大版本兼容。

### 5.2 记录模型（新增字段均可缺省，符合 `docs/03:45`）

`id / kind / subject / predicate / value / text / tags / status / validFrom / validTo / supersedes / source / sourceRefs / trust / taint / provenance / createdAt / updatedAt`

- `kind` 仍是 `fact | pref | decision | gotcha | state`；session 晋升只允许 `decision | gotcha`。
- `status` 仍是 `active | superseded | disputed | tombstoned`。

### 5.3 context pack（P1）

输入：`{ task, asOf, budgetTokens, profile, kinds?, includeT2? }`
输出：

```json
{
  "v": 1,
  "asOf": "...",
  "budget": { "maxTokens": 1800, "usedTokens": 1200 },
  "facts": [{ "id": "...", "text": "...", "trust": "T0", "provenance": "..." }],
  "decisions": [...],
  "gotchas": [...],
  "references": [{ "id": "...", "snippet": "...", "trust": "T2" }],
  "excluded": [{ "id": "...", "reason": "stale|disputed|over-budget|tainted" }],
  "degraded": false,
  "basis": { "retrieval": "bm25+vector+rrf", "k": 60 }
}
```

约束：

- 排序确定性：`(trustRank, kindRank, score, id)`；**不按「最近命中」排序**（否则输出依赖历史调用次数）。
- `asOf` 冻结；同输入两次输出逐字节相等（I-6）。
- 超预算先裁 `references`，再裁低分 facts；被裁项进 `excluded` 并给原因。
- T2 默认只进 `references`，且只给片段；`includeT2: true` 才进 `facts`（仍需人工提升）。
- 不读写真相层计数（hits 移出真相层，见 §6.2-11、§18-3）。

### 5.4 任务与审批（P3）

任务库 `~/.memo/tasks/*.jsonl`，append-only，状态机 `pending → approved | rejected | expired`。审批通过才允许 adapter 执行外写；审批记录进 `events.jsonl`。

### 5.5 CLI / MCP 表面

**默认面 ≤4 个工具**（P1 起）：`memory_search`、`memory_write`、`memory_brief`、`memory_pack`。
其余工具（`get/supersede/forget/curate/dedupe_scan/stats/scope` 与会话工具）通过 `memo mcp --all-tools` / `--session-tools` 显式开启；P0b 阶段默认仍是现有 3 个（search / write / brief），P1 加 pack。
兼容表：旧配置若依赖 `memory_curate`，在插件 UI 里改走 CLI 或 `--all-tools`，并在升级说明里写清楚。

---

## 6. 阶段计划

### 6.0 设计变更前置（P0a 之前必须完成）

| 变更 | 落点 | 产物 |
|---|---|---|
| C1/C6 口径修订 | `docs/00-principles-and-requirements.md` | 规格修订 + `tests/invariance/i9-*.js` |
| trust / taint / provenance 字段 | `docs/02-data-model-and-contract.md` + ADR | ADR + `memo migrate` 迁移与回滚 |
| hits 移出真相层 | `docs/02` + ADR | ADR（P1 实施） |
| 审计链与外部锚定 | `docs/02` + ADR | 链格式、锚定策略、保留期 |
| profile 显式映射 | `docs/03` + ADR | 映射表、缺失指针 fail-closed |
| Web 鉴权 | `docs/08-web-ui.md` | cookie/Authorization/Host 规则 |
| adapter 协议 v1 | `docs/02` + `packages/protocol` | 信封 schema、错误码、`adapter.json` |
| Q1 scope 调整 | `docs/03:44` + `docs/07` | 与「Q1 全仓生效」同步改口径 |

每项一个 issue；PR 用 `Refs #N`。未完成前不动对应代码。

### 6.1 P0a 地基（工作量 1–1.5 个周末）

目标：**让「CI 绿」这句话变真**。

1. **CI 指向当前版本**（半天）：新增 step
   `echo "dir=versions/$(cat versions/CURRENT)" >> "$GITHUB_OUTPUT"`，各步骤 `working-directory: ${{ steps.v.outputs.dir }}`；artifact 路径同样用该 output。禁止把 `versions/CURRENT` 当目录。
2. **windows-smoke 跟随 CURRENT**：`tools/windows-smoke.mjs:24-26` 改为按 `versions/CURRENT` import；否则 G0 必红。
3. **门禁防回退**：`tools/meta-check.mjs` 断言 CI/gate 脚本里不得出现字面 `versions/v0.x`（allowlist 需 reason + until）。
4. **Q1 scope**：`quality-check.mjs:91-116` 只对 `versions/CURRENT/src` + 已存在的 `packages/*/src` 生效；adapters 由 G6（依赖清单）与 G7（架构负向测试）覆盖；同步改 `docs/03:44` 的「Q1 全仓生效」表述。
5. **根 workspace**：根 `package.json`（`private: true`）+ `pnpm-workspace.yaml` + 单 lockfile；`plugin/dsh-sedimem` 改为 `workspace:*` 依赖（workspace 链接不需要发布，`private:false` 不等于要发 npm）；`private:false` 只对将来要发布的一方包设置。
6. **README 口径修正**：覆盖率 85/70/90（不是 89/90/77）；14 个模块目录（不是 12）；「零依赖」改为「内核零运行时依赖」；claude-mem「只服务 Claude」改为「支持 6+ harness（含 dsh）」。
7. **engines 抬到 `>=22.15`**：`versions/v1.0/package.json`；README 注明 transcript 源需 22.15+（`session/transcript.js:70-81` 已有 feature guard）。
8. **命名澄清（只改文档）**：四道门 = schema / 脱敏 / 去重 / 冲突；`V1–V5` 仅指 curate 批文件校验，**不改代码标识符**。
9. **G0 基线**：记录 `tests / eval / quality / security / docs-drift` 的耗时与通过率，写进计划「执行结果」。
10. **最小 G6**：`tools/supply-check.mjs`——committed lockfile、`npm ci --ignore-scripts` 可装、无 postinstall 网络、SBOM 生成。

**验收**：CI 在 `versions/CURRENT` 上绿；G0 五项可见；meta-check 能拦住硬编码版本；README 数字与门禁一致。

### 6.2 P0b 语义与信任（工作量 2–3 个周末）

目标：**让「审计」这个词站得住**。

1. **锁**：storage 数据锁（items / inbox / events）统一为 `<memoHome>/.lock`，加 5s 心跳，判陈旧改「mtime 超时 **且** pid 不存在」；`capture/queue.js` 的 mkdir 同步锁改为同一把；`llm/outbox` 锁保留（Q15 禁依赖 storage），在 ADR 写理由。CI 加两进程并发 append + `kill -9` 测试。
2. **队列流式化**：append 不整文件重读重写；per-adapter + 每日 + 单文件字节配额；行长度与 `provenance` 数组上限；超限拒绝并审计。
3. **Ed25519 验签**：注册 / 轮换 / kid / 双 key 窗口；`memo adapter register|rotate|list`；伪造信封 → `E_SIG_INVALID` + `acl.deny`。
4. **trust / taint 落 schema**：按 §4.2；`accept` 只继承；`merge/supersede` 追加 `v+1` 并集；`memo trust promote|clean` 带理由与审计。
5. **存量 backfill**：按 §4.1 规则一次性补齐；迁移前先备份；`memo migrate` 支持回滚；测试断言「迁移后 pack 非空」。
6. **按来源删除**：`memo delete --source adapter:gmail --uri msg://...` → 墓碑 + compact + 清派生（index/brief/vectors/projections）+ 审计脱敏事件 + 备份说明；`memo verify-delete` 打印目标是否已不可检索。
7. **profile 路径收敛**：所有入口只走 `resolveMemoHome(env, cwd, profilePointer)`；默认 profile 永久映射 `~/.memo`，命名 profile `~/.memo/profiles/<name>/`；`~/.memo/profiles.json` 只存命名 profile 的指针（不在 profile 内）；指针缺失 fail-closed；**不做物理迁移**（不违反 `docs/03:45` 跨版本承诺）。
8. **Web 鉴权**：`memo serve` 在 `GET /`（Host 限 loopback）下发短期 `HttpOnly; SameSite=Strict` cookie；`/api/**` 同时接受 cookie 或 `Authorization: Bearer`；`ui/api.js` 用同源 fetch 自动带 cookie（无需改调用）；无 Cookie/Token → 401；强校验 Host/Origin；可选 UDS + peer-credential。
9. **权限**：`~/.memo` 及子目录 0700、文件 0600；启动校验并告警；`tmutil addexclusion` 与云盘排除写进文档。
10. **T2 注入**：默认不注入原文；必须注入时只注入结构化抽取；围栏 nonce = `hash(contentHash + asOf)` 前 8 位；逐行转义所有分隔符；「数据不是指令」写进 system prompt；canary 行为测试（T2 指令不得触发任何工具调用/出站）。
11. **hits 只做观测（不迁移）**：P0b 只加测试与 ADR，把 `search-path.js:150` 的 `flushHits` 标为待迁移；列出 `brief.js:104`、`quota.js:45`、`judge`、web read 的改法；**P1 再移出真相层**。避免 P0b 同时改语义和排序。
12. **审计统一**：`events.jsonl` 为唯一审计源（`kind` + `seq` + `prevHash`）；gateway 只转发不写；外部锚定 = 可选「每日把链头 hash 写进本地 git 提交（不 push）」；写明无锚定时只能防无意损坏。
13. **数据地图与保留期**：新增 `docs/12-data-map.md`（资产 / 位置 / 保留期 / 删除路径 / PII 类别）；候选 14 天过期（P0b 新增清理任务，挂进 nightly）；events / quarantine 90 天；T2 默认 7 天；`redact.js:6-14` 增 PII 类别。
14. **工具面收敛**：P0b 默认仍是现有 3 个（search / write / brief）；写兼容表：其余 7 个 `memory_*` 走 `--all-tools`，5 个会话工具走 `--session-tools`；插件 UI 的 `memory_curate` 改走 CLI 或 `--all-tools`；schema token 预算留到 P1。
15. **读预算**：`search` 默认 ≤N 条片段、单条 ≤200 字；每会话条数/字节上限；超限报错；落点 `api/search-path.js`。
16. **Windows 声明**：只支持 kernel / CLI；adapters 不支持；`memo doctor` 在 win32 打印 `unsupported` 并 exit 2；写进 README 与 §16。
17. **quarantine**：只存引用（uri + hash + ≤200 字摘录），不存正文；`memo quarantine list|accept|reject`；retention 与配额同 inbox。

**验收**：伪造信封被拒并审计；T2 canary 零外写；kill -9 后锁可恢复且不丢写；`memo verify-delete` 通过；web 无 token 401、有 token 200 且 UI 仍可用；两 profile 互不可见；存量迁移后 pack 非空。

### 6.3 P1 装配（工作量 3–4 个周末）

目标：**用现有数据证明「装配」值得做**。

1. `memory_pack`（内核内实现，不引第三方）：确定性排序、预算裁剪、T2 分区、`excluded` 原因。
2. `memo export agents-md`：把 decision/gotcha 写成**带 provenance 的 AGENTS.md 节**，可配置 marker，不覆盖用户手写内容。
3. `npx @old-friends-gathering/sedimem init`（`mem init`）：探测 DSH/Codex/Claude 配置，幂等写 MCP 配置 + 打印验证命令。
4. `npx ... audit`：只读扫描 `~/.claude-mem/*.sqlite`、`AGENTS.md` / `CLAUDE.md`、`~/.codex/memories`，输出卫生报告（重复/过期/无来源/冲突），不写任何东西。
5. 默认工具面变 4 个（加 `memory_pack`）；schema token 预算进 G4。
6. **先做基线实验**：固定 20 个任务、同一 harness、同一模型；对比 `brief` 与 `pack` 的 token 与事实召回。**不达标不发**：事实召回 20/20（Wilson 95% 下界 ≈84%；19/20 不通过）、token ≤ brief 的 70%。
7. hits 迁移到 metrics/events（带 ADR）；更新 brief / quota / judge / web-read 四处读取。

**验收**：pack 输出可复现（逐字节）；AGENTS.md 导出可被 DSH/Codex 直接消费；init 在干净机器上 5 分钟内完成；基线实验报告可复现。

### 6.4 P2 导入（工作量 3–4 个周末，先做 2 周 spike）

目标：**零迁移获得增量**，不建钩子矩阵。

| 源 | 做法 | 不做什么 |
|---|---|---|
| claude-mem | 只读 `~/.claude-mem/*.sqlite` → 候选（T2，需 accept） | 不装它的 hook、不双写 |
| AGENTS.md / CLAUDE.md / SKILL.md | 解析标题/条目 → 候选；只当数据 | 不执行指令、不改原文件 |
| git | adapter 读本地 repo（可配作者过滤）→ 提交摘要候选 | 不做 CI 集成、不读远端 |
| 本地文档 | markdown / 纯文本目录 → 候选 | 不做全盘索引 |
| `.ics` | 读导出文件；只取本人相关字段（subject/time/attendee 的最小集） | 不做 OAuth、不做 IMAP |
| DSH transcript | 已有 `session/transcript.js`；**仅 Node ≥22.15 可用**；先补测试再接 `memo import transcript` | 不做常驻 tail |

- 每源一个 adapter 进程，各自私钥；互不 import。
- **不做**：hook 矩阵、OAuth、IMAP、日历/邮件 API（§16）。
- 验收（连续 14 天，每日手动跑一次即可，**不依赖 P3 的调度器**）：候选 ≥150；accept ≥60%；40–60% 先调启发式再延一轮；<40% 停。

### 6.5 P3 行动（工作量 4–6 个周末）

1. 最小 scheduler：one-shot + cron 一行（不引 cron 库，`setTimeout` 到下一分钟）；`memo schedule add|list|run`。
2. 最小 supervisor：child_process 拉起 / 重启 / 退避；最大进程数；健康超时；`memo adapter doctor` 打印 last-event。
3. 任务库 + 审批：`memo tasks list|approve|reject`；外写 adapter 必须拿到 approved token。
4. 首个动作：`memo next`（今日待办/待确认）+ 晚间 `today.md` 摘要。
5. 验收：`today.md` 使用率 ≥50%（<20% 停）。判定口径：当日 `today.md` mtime 发生变化，且次日 `memo next` 的输出包含其中至少一条；两项都满足才算「使用」。每周至少一次由调度产生的有效动作。

### 6.6 P4 个人端点（可选，4–6 个周末，触发后才做）

只在**两个硬条件同时成立**时启动：

1. 出现第二个真实消费者（不是本人脚本），且有 issue 记录其需求；
2. pack 已连续使用 ≥30 天，且 `memo stats` 能看到稳定的读取来源分布。

内容：gateway（聚合 + profile + 默认拒绝 + 审计转发）、`secrets`（Keychain / credential-provider）、`files` / `contacts` 只读视图。**不承接内核写**；不把网关做成单点（默认不启用，旁路）。

### 6.7 P5 一致性套件（3–5 个周末）

把 eval runner 抽成 `sedimem-conformance`：输入任意记忆库导出（JSONL / MCP 只读端点），输出治理判定（重复、过期、矛盾、来源、删除、as-of）。公开对 mem0 / claude-mem / Lanes Link 各一份报告 + 复现脚本。**不做排行榜**；把治理用例提给 BEAM / LongMemEval。

---

## 7. 关键设计决策（为什么不是别的）

### 7.1 为什么治理而不是检索

检索是红海且有现成 RRF/向量库；治理（append-only + 失效 + as-of + 来源删除）是 mem0 明确不做、claude-mem 不覆盖、Lanes Link 只做日志的空白。我们已有的 eval 与四道门是别人没有的资产。

### 7.2 为什么 pack 不自定义主格式

宿主已占住注入位（DSH auto-compact、Claude auto memory、Codex Memories、AGENTS.md）。再定义一个 `<context-pack>` 只会造成双份注入与「记忆说 A、pack 说 B」。pack 输出三种标准物，让宿主自己决定何时注入。

### 7.3 为什么不建 hook 矩阵

claude-mem 已支持 6+ harness（含 dsh），且钩子要跟 harness 升级赛跑。我们只保留 DSH 插件一条实时路径 + 只读 importer；Claude 用其自身 hook 打 loopback（P2 可选），Codex 只做按需 import。

### 7.4 为什么先 pack 后捕获

用户能感知的是「答得更准」，不是「记得更多」。现有数据足够验证 pack；捕获扩张应由此暴露的召回缺口驱动，而不是先建 100 个连接器。

### 7.5 为什么网关降为可选

单端点 + 直连兜底在 MCP 客户端不成立（三份独立配置、无健康检查）；网关半死会让工具超时。先保留 stdio 直连，网关只在第二消费者出现后作为旁路。

### 7.6 为什么 Ed25519 而不是 HMAC

HMAC 要求 adapter 持有共享密钥，而共享密钥只能放 `MEMO_HOME`（违反 I-4），且无 `kid` 无法轮换。Ed25519 让 adapter 只持私钥、kernel 只存公钥，轮换用 `kid` 双窗口。

### 7.7 为什么不做 benchmark 榜单

自测榜单不可信且太晚；BEAM 已覆盖矛盾消解。做「可对任意库跑的卫生套件」既有差异化，又能被引用。

---

## 8. 验收指标（预注册，样本量与阈值先定）

| 阶段 | 指标 | 阈值 | 样本 |
|---|---|---|---|
| P0a | CI 在 CURRENT 上绿 | 五项全绿 | 每次 push |
| P0a | 门禁防回退 | meta-check 拦硬编码 | 故意注入 v0.3 的 PR |
| P0b | 伪造信封 | 100% 拒绝 + 审计 | 20 个变体 |
| P0b | T2 canary | 0 次外写/工具调用 | 20 条注入样本（含改写/翻译/base64） |
| P0b | 并发丢写 | 0 | 2 进程 × 1000 次 append + kill -9 |
| P0b | web 鉴权 | 无 token 401 / 有 token 200 | 手工 + 集成 |
| P1 | pack 事实召回 | 20/20（Wilson 95% 下界 ≈84%） | 20 个固定任务 |
| P1 | pack token | ≤ brief 的 70% | 同上 |
| P1 | pack 确定性 | 同 asOf 两次逐字节相等 | 10 次 |
| P2 | 候选量 | ≥150 / 14 天 | 真实使用 |
| P2 | accept 率 | ≥60%；40–60% 调启发式后再测；<40% 停；候选 50–150 条时延长试验 | 同上 |
| P3 | today.md 使用 | ≥50%（<20% 停） | 4 周 |
| P4 | 第二消费者 | 有 issue + 实测 30 天 | 硬触发 |
| P5 | 外部复现 | 3 个外部使用者跑通 | 公开邀请 |

---

## 9. 迁移与兼容

1. **schema 新增字段可缺省**：旧记录无 `trust` → 迁移补齐（§4.1）；无 `sourceRefs` → 空数组；新写入缺字段视为 T2；存量必须先 backfill 再启用 pack，否则会被清空。
2. **协议大版本**：`protocol: 1`；adapter 声明 `kernelProtocol: ">=1 <2"`；未知大版本拒收。
3. **profile**：默认路径不变；命名 profile 新增；不做物理迁移；旧 `MEMO_HOME` 显式映射，`resolveMemoHome` 缺失即 fail-closed。
4. **三端配置**：保留 stdio 直连；网关只做可选前置；`memo init` 负责写配置并打印验证。
5. **回滚**：`memo migrate --rollback` 恢复迁移前快照；`memo verify-delete` 验证删除；每次迁移先做 `.memo-backup-<ts>` 硬链接/复制。
6. **发布**：一方包 lockstep（`versions.json` 派生）；`protocol` 只声明大版本；`memo-adapters` 作为一个包发子命令；无外部用户前只 `git clone`，不发 npm。
7. **Windows**：kernel / CLI only；adapters 不支持；`doctor` 在 win32 exit 2。

---

## 10. 安全与隐私底线（不可协商）

- 凭据只走 OS Keychain / credential-provider，经 fd/pipe 注入，**不进 env、不进配置文件、不进日志**。
- 出站默认关闭；目的地白名单在 socket/HTTP 层；不需要网络的 adapter 默认断网。
- 文件权限 0700 / 0600；启动校验；备份排除（Time Machine / iCloud / OneDrive）。
- T2 默认不进 facts、不注入原文；去污只能人工提升并留审计。
- 删除按来源可枚举；墓碑 + compact + 清派生 + 审计脱敏事件；备份副本在文档中说明。
- 审计不存 secret 值；保留期与 crypto-shred 写进 `docs/12-data-map.md`。
- 同 UID 威胁不承诺完全防护；文档写明边界，避免虚假安全感。

---

## 11. 度量：项目北极星

1. **每天需要重复解释的次数**（同一事实被用户第二次说明的次数）。
2. **冷启动首次正确率**（新会话首个任务无需补充背景的比例）。
3. **每任务注入 token**（brief / pack 的 token 成本）。
4. **决策可追溯率**（随机抽 20 条 decision，能指出来源与时间的比例）。

不做 DAU / 安装量指标——单人项目，先证明「对自己有用」。

---

## 12. 时间与节奏（现实版）

- 历史证据：v1.0 重构 12 天 / 90 commits；2026-11-14 单日 22 commits。单人可持续节奏约每周 1–2 个有效工作日。
- 阶段工作量按「周末」计（1 周末 ≈ 2 天）：

| 阶段 | 周末 | 日历（含缓冲） |
|---|---|---|
| P0a | 1–1.5 | 2 周 |
| P0b | 2–3 | 4–6 周 |
| P1 | 3–4 | 6–8 周 |
| P2 | 3–4 | 6–8 周 |
| P3 | 4–6 | 8–12 周 |
| P4 | 4–6 | 仅在触发后 |
| P5 | 3–5 | 仅在主仓有外部使用者后 |

**MVP（P0a + P0b + P1）合计 6–8.5 个周末，日历约 3–4 个月**。验收窗口里的「14 天 / 4 周」是**日历观察窗口**，不是额外工作量；累计日历至少 +6–10 周。

不承诺日期，只承诺顺序与验收；每阶段结束补「执行结果」并用实际耗时校准下一阶段。

---

## 13. 风险表

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R-01 | 范围膨胀，MVP 做不完 | 高 | 高 | §16 不做清单；每阶段一个可演示切片 |
| R-02 | pack 实验不达标 | 中 | 高 | 先做基线；不达标就停，回退到 brief + 溯源 |
| R-03 | T2 注入被绕过 | 中 | 高 | 默认不注入原文 + 结构化抽取 + canary 行为测试 |
| R-04 | 双份注入（宿主 + pack） | 中 | 中 | 只输出标准物；宿主已注入时 pack 不重复注入 facts |
| R-05 | 三端 hook 维护成本 | 高 | 中 | 只保留 DSH 实时路径 + 只读 import |
| R-06 | Windows 长尾 | 高 | 中 | 只承诺 kernel/CLI；adapters 不支持 |
| R-07 | Ed25519 私钥丢失/轮换失败 | 中 | 中 | 双 key 窗口；`memo adapter rotate`；备份公钥注册表 |
| R-08 | 迁移把存量误判为 T2，pack 变空 | 中 | 高 | backfill 规则 + 「迁移后 pack 非空」测试 + 回滚 |
| R-09 | 审计链被同 UID 重算 | 中 | 中 | 可选 git 锚定；文档写明边界 |
| R-10 | web token 引导导致 UI 全 401 | 中 | 中 | cookie 下发 + UI 验收 + 保留 `--no-auth` 仅 loopback 调试 |
| R-11 | Q 门禁与 G 系列漂移 | 中 | 低 | Q 冻结 14；G 单独编号；docs/07 R5 同步 |
| R-12 | `~/.memo` 被云盘/备份带走 | 中 | 高 | 启动校验 + 排除 + 可选加密 |
| R-13 | 供应链（第三方包/可选二进制） | 中 | 高 | 单 lockfile + `--ignore-scripts` + SBOM + 签名 |
| R-14 | 删来源时漏清派生层 | 中 | 中 | `deleteBySource` 统一入口 + `verify-delete` |
| R-15 | 计划改变了设计却没回写规格 | 中 | 中 | §6.0 前置；docs-drift + 人工 review |
| R-16 | 单人评审容量（无第二 maintainer） | 高 | 中 | 适配器上限 2 个；issue 模板；外部贡献只收测试/文档 |

---

## 14. 质量门禁调整

### 14.1 现状

- `quality-check.mjs`：Q1–Q11、Q13、Q14、Q15，共 **14 项**（Q12 跳号预留）。
- `docs-drift-check.mjs`：R1–R6；`docs/07` 声明的 Q 项数必须等于实际 Q 编号数。
- `coverage-gate.mjs`：lines ≥85 / branches ≥70 / functions ≥90（与 `docs/07:56-58` 一致）。
- **Q 冻结**：本计划期间不新增 Q；新增不变量走 G 系列。

### 14.2 新增（按阶段）

| 阶段 | 门禁 | 内容 |
|---|---|---|
| P0a | **G0** | CI 在 CURRENT 上跑通；五项耗时/通过率可见 |
| P0a | **G6** | 依赖与供应链：lockfile、`--ignore-scripts`、SBOM、无 postinstall 网络 |
| P0b | **G3** | 注入行为测试：canary + 变体（改写/翻译/base64/多轮）+ property-based |
| P1 | **G4** | pack：确定性（逐字节）、预算、schema token ≤ 预算、T2 分区 |
| P1 | **G5** | 覆盖率「每包三指标」；只对已存在包生效；阈值 lines 85 / branches 70 / functions 90 |
| P0b | **G7** | 架构负向测试：未注册 search 被拒、直写 items 失败、trust 自升被拒、audit 断链可检出、kill gateway 可恢复 |

**不扩 Q5**（Q 冻结）：adapters 的依赖与架构由 G6/G7 覆盖。

### 14.3 门禁哲学

- 门禁是**证据**，不是装饰：每条不变量至少一个负向测试，失败信息必须能指向 §3.1 的 ID。
- 门禁不能要求「更多代码」而应先要求「更少假设」：先测现有行为，再改。
- 所有门禁在 CI 与本地同源；本地跑不过不许 push（文档写清楚）。

---

## 15. 工程卫生（与架构同等重要）

1. **单 workspace + 单 lockfile**；一方包 lockstep；adapter 允许 runtime deps 但必须有 committed lockfile、无 postinstall、SBOM。
2. **测试分层**：unit / integration / invariance / injection / e2e（DSH 插件一条）；`tests/invariance` 专放 C1/C6/I-9。
3. **ADR 制度**：任何改变数据格式、锁、鉴权、审计、profile 的决定先写 ADR（`docs/adr-*.md`），再改代码。
4. **文档即代码**：contract 文档头部四行（doc-kind / doc-version / verified-at / verified-against）；改行为必须同步改 contract。
5. **发布节奏**：一方包同版本号；`protocol` 单独大版本；CHANGELOG 手写「为什么」。
6. **社区**：issue 模板（bug / feature / adapter request）；SECURITY.md 覆盖 adapter；至少一个外部可复现 demo。

---

## 16. 不做清单（防止范围膨胀）

- 不做通用 agent 框架 / 聊天 UI / 多 agent 编排。
- 不做全屏/音频录制（Screenpipe 路线）。
- 不做连接器数量竞赛；adapter 上限 2 个，直到出现第二个 maintainer。
- 不做云端多租户 / 团队协作 / RBAC。
- 不做日历/邮件 OAuth、IMAP、Gmail restricted scope（P2 只读 `.ics`/导出文件）。
- 不做图数据库；不做 Docker 依赖。
- 不做 benchmark 排行榜；不做「通用记忆协议」标准。
- 不做 Windows adapters；Windows 只保证 kernel / CLI。
- 不做 gateway 默认启用；不做多 profile 产品化（P0b 只做路径收敛与隔离）。
- 不为 star 做与治理无关的功能。

---

## 17. 对抗审核记录

### 17.1 第一轮：四路独立审核（只读，未改文件）

| 审核者 | 视角 | 结论 | 主要 finding（详见 §17.2 的处理） |
|---|---|---|---|
| adv-eco | 生态/产品 | 初稿不可批准 | 定位与 Lanes Link 重叠；hook 矩阵重复；pack 与宿主抢位；工具膨胀；采用门槛高；benchmark 太晚 |
| adv-sec | 安全/隐私 | 不可批准 | T2 注入非边界；inbox 无签名/accept 洗白；凭据走 env；无出口控制；web 无鉴权；锁与配额可 DoS；删除不可枚举 |
| adv-arch | 架构不变量 | 不可批准 | C1/C6 未修订；边界只是模块语言；trust/taint 无字段；锁丢写；pack 非纯派生；版本/冻结错误；profile 三份实现；门禁冲突 |
| adv-feas | 单人可行性 | 不可批准 | CI 跑 v0.3；Q1 全仓零依赖；无 workspace；估时低估 2–3 倍；三端 hook 机制不同；门禁净新增；Windows 长尾 |

**十三项阻塞项**（初稿阶段）：

1. 定位与 Lanes Link 重叠（它已发货 memory/tasks/skills/secrets）。
2. hook 矩阵重复 claude-mem（已支持 6+ harness）。
3. pack 与宿主记忆抢注入位。
4. T2 注入不是边界（单围栏、字面匹配）。
5. inbox 无签名、accept 丢来源、记录无 trust/taint。
6. 凭据走 env。
7. 无出口控制（search = 整库读）。
8. 锁 30s 判陈旧且无心跳，可静默丢写。
9. C1/C6 未修订却新增进程。
10. 版本/冻结表述错误（`versions/FROZEN` 不存在；四道门误写 V1–V5）。
11. 门禁阈值错误（89/90/77 vs 85/70/90）且 CI 不跑当前版本。
12. 阶段互相引用，验收不可执行。
13. 读路径把 hits 写回真相层，pack 非纯派生。

### 17.2 第一轮修订（本稿已落实）

| 问题 | 修订 |
|---|---|
| 定位 | 收窄为「决策与坑的可审计账本」；五环降为支撑（§0、§7.1） |
| Lanes Link | 本期不做超集；长期可做 memory provider，非承诺（§1.2、§18-2） |
| hook 矩阵 | 只读 importer + 保留 DSH 插件一条（§6.4） |
| pack 抢位 | 不自定义主格式；输出 AGENTS.md 节 / SKILL.md / MCP tool（§4.5） |
| T2 注入 | 默认不注入原文；结构化抽取；确定性 nonce；canary（§3.1 I-11、§6.2-10） |
| 信任 | Ed25519 信封；trust/taint/provenance；merge 追加 v+1；人工提升（§4） |
| 凭据 | Keychain / credential-provider + fd/pipe；不进 env（§10） |
| 出口 | 默认断网；目的地白名单；search 只回片段（§3.1 I-5、§10） |
| 锁 | 心跳 + pid 判据；数据锁统一；llm 锁例外（§3.1 I-3、§6.2-1） |
| C1/C6 | 修订口径；新增 `tests/invariance`（§5.0） |
| 版本 | 每版本 FROZEN.md；CURRENT 是文件；四道门命名澄清（§3.2 B4、§6.1-8） |
| 门禁 | Q 冻结 14；G0/G3–G7；阈值 85/70/90（§14） |
| 阶段 | 纵向切片；P0b 含 quarantine accept CLI；scheduler/supervisor 在 P3，P2 不依赖 |
| hits | P0b 只测试 + ADR，P1 移出（§6.2-11） |

### 17.3 第二轮：矛盾猎手 + 闭合审计（均 reject）

**第二轮 A（contradiction-hunter）**：6 件缺失，其中 5 条 blocker：工具数与阶段矛盾、随机 nonce 破坏确定性、I-1 与 compact 矛盾、密钥位置违反 I-4、初稿 P1「95% 召回」在 n=20 时数学不可达（20/20 的 Wilson 下界才 ≈84%）。结论：P0a 修完可单独开工，P0b 之后需再审核。

**第二轮 B（closure-auditor）**：48 条逐条核验——闭合 14、部分闭合 26、未闭合 4（E11/S4/S10/F8）、错误 4（S6/A12/F1/F5）。must-fix 8 条：

1. 补全 §19 写盘范围（测试、渲染、hygiene、web-read、storage、CLI、UI、tools、eval）。
2. P0b web 鉴权必须给 UI token 引导，并把 `ui/**` 纳入范围，否则全 401。
3. 存量记录必须 backfill trust，否则「缺 trust 按 T2」+「pack 默认排除 T2」会让全部存量被排除。
4. P0a-1 改为可执行的 CURRENT 解析（step output），并同步修 `windows-smoke.mjs`。
5. hits 决策统一：P0b 只测试 + ADR；P1 移出；列出 brief/quota/judge/web-read 改法。
6. 补实 E11/S4/S10/F8/A12 五个空落点（adapter 策略、读预算、保留期/数据地图、Windows、P2 验收不得依赖 P3 的调度器）。
7. 裁决 A4：保留 llm outbox 锁并写理由；数据锁只统一 items/inbox/events；inbox 同步锁改造。
8. 统一验收阈值（§8）；修 §14 冻结清单（补 Q13/Q15）；不扩 Q5。

**本稿对应修订**：§4.1 backfill、§6.2 全部落点、§6.3/§6.4 阈值、§14 Q 冻结、§19 范围、§3.2 B4/CURRENT、§8 P1/P2/P3。

### 17.3.1 第三轮 delta 复核（reject → 已修）

只验 8 条 must-fix 与新增矛盾。结论：8 条中 7 条闭合、1 条部分闭合；发现 4 条新问题，均属 blocker/major：

1. **backfill 过宽**：把 `source.agent ∈ {cli,dsh,claude,codex}` 且无 adapter 的记录补 T0，而 P2 的 git/文档/AGENTS.md 导入正是这个形状 → 外部内容被升为可注入 facts。修：限缩为「迁移时已存在 + `{cli,dsh}` + 无 adapter/sourceRefs/import tag/provenance」；其余 T1/T2；只跑一次；导入后不得提升。
2. **规格文件名错误**：`docs/02-data-model-and-storage.md` 不存在，实为 `docs/02-data-model-and-contract.md`；`write-path.js` 实际在 `src/api/`。修：§6.0、§19 全部改正。
3. **adapter 上限不一致**：§16/R-16 写 2，§18-1 写 3。修：统一为 2。
4. **daemon 计数不可断言**：I-9 允许 1 个 daemon，但 P3 supervisor 与 P4 gateway 会各起一个。修：§5.0 明确二者必须是同一个 `memo daemon` 进程；未合并前不启动 P4。
5. 顺带：Web 规格指向 `docs/05`（实为 `docs/08`）；schema 字段规则在 `docs/03:45` 不是 `:44`。均已改。

### 17.3.2 第四轮 delta 复核（pass）

只验上述 4 条 + 2 条顺带修正：全部已修，**无 blocker**；仅 `write-path.js:135-140` 一处路径未带 `src/api/`，已顺手统一。审核结论：**本稿可提交批准**。

### 17.4 残留风险（不打算在本计划内解决）

- 同 UID 恶意进程可读可改：只能检测与告警，不能阻止。
- `node:sqlite` 仍是 ExperimentalWarning：接受，不因此引入依赖。
- LLM 裁决的质量依赖模型：用 eval 兜底，不承诺「一定对」。
- 单人项目无第二 maintainer：adapter 上限 2 个，外部贡献只收测试/文档。
- 不支持 Windows adapters：接受，文档写明。

---

## 18. 开放问题

1. **adapter 支持策略**：旧版本只读 + 90 天公告弃用；`SECURITY.md` 为唯一安全联系人（adapter 安全报告也走这里）；容量上限 = 1 maintainer / ≤2 adapters；超出即关闭新 adapter 接收。
2. **是否做 Lanes Link 的 memory provider**：长期选项，非承诺；触发条件 = 它出现真实用户且其 memory 接口稳定 ≥2 个版本。
3. **hits 的最终归宿**：P1 决定移到 `metrics/` 还是 `events/`；两者都要保证「不影响排序」。
4. **审计外部锚定**：默认无锚定（只防无意损坏）；可选本地 git 提交锚定，不 push。是否需要系统日志锚定，P0b 后评估。
5. **AGENTS.md 导出的 marker 约定**：用 HTML 注释还是 JSON 块；需同时兼容 DSH / Codex / Claude。
6. **P5 套件的输入格式**：JSONL 导出 vs MCP 只读端点；优先 JSONL（可离线复现）。
7. **多 profile 产品化**：P0b 只做路径收敛与隔离；是否值得做 UI 切换，等第二消费者。
8. **中文分词**：当前汉字二元组足够；是否引入词典，等坏了再说。

---

## 19. 写盘范围（本计划若批准）

**P0a**

- `.github/workflows/ci.yml`
- `tools/meta-check.mjs`（新增）、`tools/windows-smoke.mjs`、`tools/coverage-gate.mjs`
- `tools/quality-check.mjs`（Q1 scope）
- 根 `package.json`、`pnpm-workspace.yaml`
- `plugin/dsh-sedimem/package.json`（workspace 依赖）
- `README.md`、`docs/03-iterability-and-versioning.md`、`docs/07-quality-and-security.md`
- `versions/v1.0/package.json`（engines）

**P0b**

- `versions/v1.0/src/storage/lock.js`、`storage/jsonl-store.js`
- `versions/v1.0/src/capture/queue.js`
- `versions/v1.0/src/core/record.js`、`api/write-path.js`、`api/maintenance.js`
- `versions/v1.0/src/api/search-path.js`（读预算 + hits 标记）
- `versions/v1.0/src/render/inject.js`、`render/brief.js`、`render/tier0.js`
- `versions/v1.0/src/hygiene/redact.js`、`quota.js`、`judge.js`
- `versions/v1.0/src/web/server.js`、`web/api/write.js`、`web/api/read.js`、`web/static.js`
- `versions/v1.0/src/config/paths.js`、`cli/commands/shared.js`、`cli/capture.js`、`cli/mcp.js`
- `versions/v1.0/src/mcp/tools.js`、`mcp/session-tools.js`、`mcp/server.js`
- `versions/v1.0/src/cli/serve.js`、`api/lifecycle.js`
- `versions/v1.0/ui/api.js`（仅 cookie 兼容；如无需改动则不动）
- `versions/v1.0/src/session/cli-support.js`、`session/transcript.js`
- `versions/v1.0/src/cli/memo.js` + 新子命令（`trust`、`delete`、`verify-delete`、`adapter`、`migrate`）
- `versions/v1.0/tests/**`（含 `tests/invariance/`、`tests/injection/`）
- `tools/supply-check.mjs`（新增）、`tools/gen-compat.mjs`（新增）
- `docs/02-data-model-and-contract.md`、`docs/12-data-map.md`（新增）、`docs/adr-*.md`
- `packages/protocol/**`（最小：信封 schema + 错误码 + 版本）
- `docs/plans/future-architecture.md`（本文件）

**P1**

- `versions/v1.0/src/api/pack.js`（新增）
- `versions/v1.0/src/cli/init.js`、`cli/audit.js`、`cli/export.js`（新增）
- `versions/v1.0/src/eval/`（基线实验）
- `versions/v1.0/package.json`（bin 增 `mem`）

**P2–P5**：`adapters/*`、`packages/protocol`、`packages/gateway`、`tools/gen-compat.mjs` 的扩展，按阶段另立 issue。

---

## 20. 执行结果（待填）

> 每阶段完成后补：实际耗时、验收是否通过、偏差原因、下一阶段调整。

- P0a：
- P0b：
- P1：
- P2：
- P3：
- P4：
- P5：
