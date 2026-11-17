# 未来架构：记忆治理内核与个人 AI 端点

状态：已批准（A 方案；2026-11-15 用户拍板，自 v1.3 起执行；第五轮 delta 复核记录见 §17.5）
依据：m00089 用户指示「把未来架构写进计划、对抗性审核到没问题」；m00378 要求基于 v1.2 重新调研规划；m00766 拍板 A 并给出四条规定（版本映射 / 文档先行+TDD+多 agent 审核 / 不自造常量 / 红线）；2026-11-14 四轮对抗审核（4 + 2 + 1 + 1 名审核者）；2026-11-15 v1.2.2 实测（753 tests / 56 eval / Q15）与 GitHub 生态扫描
版本规则：**P0a→`v1.3`、P0b→`v1.4`、P1→`v2.0`，其后每个阶段在 `2.x` 上递增**；每阶段一个版本目录，完成后冻结（`FROZEN.md`）。版本号由维护者排期，本文不预设 patch 节奏。阶段结论写入后补「执行结果」节。

> 本文是**未来计划**，不是当前版本规格。当前行为以 `versions/v1.2/` 与 `docs/02` 为准。
> 标注「已有 / 部分 / 缺失」的地方，均已对 v1.2.2 源码核实；2026-11-14 的基线与 2026-11-15 的复核差异见 §0.1 / §17.5。

---

## 0. 结论先行

1. **项目定位收窄为「个人 AI-native 记忆观测台 + 可审计决策账本」**：跨 agent、append-only、冲突可失效、as-of 可回查。对外一句话：*It remembers why you decided that — and shows you the receipt.*
   - 2026-11-15 限定：这是**个人**观测台/工作台，不是通用记忆平台；不再声称「治理是市场空位」（见 §0.1）。
2. **不重做存储内核**。检索、去重、四道门已是资产；下一步补的是「捕获的签名与去污」「按任务装配」「按来源删除」，不是换数据库、不是换检索算法。
3. **不做通用 agent 框架、不做聊天 UI、不做全屏录制、不做连接器数量竞赛**。
4. **阶段顺序按用户感知价值排**，不是按模块完整度：
   - **P0a 地基**：CI/门禁/文档先变真（v1.3 已把 CI/覆盖率/Windows 冒烟指向 `versions/CURRENT`，待 PR 验证）。
   - **P0b 语义与信任**：锁、鉴权、权限、trust/taint、按来源删除。没有这些，后面每一步都在放大不可审计性。
   - **P1 装配**：`memory_pack` + `export agents-md` + `init/audit`。零迁移即可感到「答得更准」。
   - **P2 导入**：只读导入 claude-mem / AGENTS.md / git / `.ics`，不做 hook 矩阵。
   - **P3 行动**：最小 scheduler + supervisor + 审批队列。
   - **P4 个人端点**：网关 + profile + 默认拒绝。**可选**，有真实第二消费者才做。
   - **P5 一致性套件**：把 I-1–I-50 抽成可对任意记忆库跑的卫生套件，不是排行榜。
5. **设计变更前置**：本计划有意改变若干现行契约（C1/C6 口径、锁、鉴权、信任字段、审计链、profile 布局）。按 `docs/plans/README.md`「计划不改设计」，这些必须先改 `docs/` 规格或落 ADR、并开 issue，再进代码。清单见 §6.0。
6. **十三项阻塞项在本计划中全部有归属**（§17.1）；两轮审核发现的 4 条错误、4 条未闭合、8 条 must-fix 已按 §17.3 修订；第三、四轮 delta 复核无 blocker。

### 0.1 2026-11-15 复核：竞争格局变了，路线必须收窄

v1.2 交付了任务库与任务上下文账本（`session` 命令组 + `sessions/<taskId>/segments.jsonl` + brief/expand/archive + UI 任务页）。这解决了「同一任务跨会话继续」的真实痛点，但也把项目带入三个已经拥挤的赛道。2026-11-15 的 GitHub 扫描给出四个新事实：

| 事实 | 证据 | 含义 |
|---|---|---|
| 捕获/交接已商品化 | claude-mem 117,263★，描述已改为「Persistent Context Across Sessions for Every Agent」，支持 Claude Code / Codex / Gemini / OpenCode 等 | 不再做捕获/hook 矩阵；只做只读导入 |
| 任务账本已商品化 | guild 297★（Go 单二进制 + SQLite，shared context/memory/task coordination，原子 claim）；v1.2 自己也有账本 | 账本是 substrate，不是卖点 |
| 治理已不是空位 | Mnemosyne 161★（每条记忆带来源与信任级、superseded 可回看、as-of 重放、更正沿依赖失效、`bisect`、投毒测试 227 例、整合回执、LongMemEval-S 409/500、npm/MIT/Node 22.16）；GateMem 136★（多主体记忆治理 benchmark） | 不能声称「唯一可审计」；P0b+P1 要做的事已有成熟参照 |
| 可观测性也在被占 | brain0 289★（把 commit 链接到 agent prompt 的决策图「黑盒」） | UI 必须给出别人没有的东西：**注入回执** |

结论：

1. **不要打「最完整的记忆平台」**。单人对 117k★ 的捕获层、161★ 且有论文级 eval 的治理层、297★ 的任务协调层，三线作战必输。
2. **保留唯一可守的组合**：本地、中文/DSH 原生、单进程零依赖、**看得见**（UI 观测台 + 注入回执）。一句话：*别人的记忆层你不知道它喂了什么；sedimem 让你看见并复核。*
3. **治理仍是底座，但不再是叙事主角**：append-only、as-of、矛盾失效、provenance/trust、按来源删除，这些是「自己敢用」的安全底线，不是「市场空位」。
4. **砍掉通用平台件**：不建常驻 adapter 生态、不在 P0b 引入 Ed25519、不做 gateway、不做公开榜单。P2 只做只读导入（claude-mem / AGENTS.md / git / `.ics`），够用即止。
5. **阶段改为**：P0a 地基（v1.2 真值化）→ P0b 安全与信任最小集 → P1 pack + 注入回执 → P2 只读导入 → P3 行动（条件触发）→ P4 端点（可选）→ P5 内部一致性/对照（非榜单）。
6. **工作量随之下调**：MVP（P0a+P0b+P1）约 5.5–7.5 个周末；P1 从 3–4 降到 2–3（v1.2 的 `briefJson` 已是 pack 子集）。

**战略分叉（待用户拍板，见 §18-9）**：

- A（本计划默认）：个人观测台 + 治理工作台，继续自研内核；
- B：通用治理平台，对标 Mnemosyne/GateMem——单人维护不建议；
- C：把 Mnemosyne 作为内核或导入源，sedimem 专注 DSH/中文/UI——可保留学习价值，但放弃内核控制。

**如果只能做一件事**：P1 的 `memory_pack` + **注入回执**。它用现有数据就能验证「装配比全文注入更省且更准」，并且把「agent 到底看到了什么」变成可复核的证据——这是 claude-mem/Mnemosyne 的 CLI 叙事里最弱、而 sedimem 的 UI 最强的一环。

### 0.2 版次映射（2026-11-15 用户拍板，A 方案）

| 阶段 | 版本目录 | 版本起点 | 说明 |
|---|---|---|---|
| P0a 地基 | `versions/v1.3/` | 1.3.0 | 从 v1.2 复制自包含快照；v1.2 冻结 |
| P0b 安全与信任最小集 | `versions/v1.4/` | 1.4.0 | P0a 完成后冻结 v1.3 |
| P1 装配与注入回执 | `versions/v2.0/` | 2.0.0 | 新大版本；不再在 1.x 上加功能 |
| P2 只读导入 | `versions/v2.1/` | 2.1.0 | 在 2.x 上递增 |
| P3 行动 | `versions/v2.2/` | 2.2.0 | 条件触发 |
| P4 个人端点 | `versions/v2.3/` | 2.3.0 | 可选；硬触发后才开 |
| P5 内部一致性 + 可选对照 | `versions/v2.4/` | 2.4.0 | 不作为对外榜单 |

规则：`versions/CURRENT` 只指向当前开发版本；阶段完成即写 `FROZEN.md` 并切到下一目录；`X.Y` 换目录、`X.Y.Z` 同目录递增；跨版本只共享文档思想与 eval cases，不共享代码路径（`docs/03:32-36`）。**P1 起是 2.0 大版本，1.x 不再接受新功能。**

### 0.3 工作规则与红线（写进每个阶段的验收）

**四条工作规则（用户 m00766 指定，缺一不可）**

1. **文档先行、实时同步**：每次开发先改文档再改代码；PR 必须同步更新受影响的 `docs/*`、`README.md`、`docs/index.html`（项目站）与 `docs/en/*`（英文页）；契约文档 `doc-version` 必须等于 `versions/CURRENT`；`docs-drift-check` 未通过不得提交。
2. **TDD + eval**：先写失败测试（red）再实现（green）；每条不变量配负向测试；每个新行为配一条 eval case，并同步 `docs/04-eval-plan.md` 的 case 数与 `docs/07` 的 Q 口径；覆盖率门槛 lines ≥85 / branches ≥70 / functions ≥90；测试、eval、quality、security 全绿才允许进入审核。
3. **多 agent 审核、本地闭环**：每个 PR 前至少 2 个独立审核者（一个架构/矛盾猎手，一个安全/可行性），blocker 必须修完并复跑；审核结论写进 `docs/plans/` 或 `reviews/`；**本地审核未通过不得 push / 开 PR**。
4. **不自造常量**：阈值、预算、超时、条数、比例一律进 `config/policy.js`（或版本内配置）并写进文档；代码里不得出现无出处的魔法数字；新增常量必须同时补文档、测试与回滚说明。
5. **多模型分工与额度**：多 agent 开发/审核优先用 `glm-5.3` / `glm-5.3-flash`（复杂审核用 5.3，例行检查用 flash）；DeepSeek 额度有限，不用于批量全量复读；每次 spawn 记录模型、用途与结论，避免同一 diff 重复审。

**红线（不可谈判；违反即拒绝合入）**

- **R1 真相只追加**：`items/*.jsonl` 永不物理删除/重写；删除是墓碑 + 派生清理；`compact` 是显式维护操作且必须留审计。
- **R2 派生可弃**：index / brief / views / vectors / projections 删光必须可重建，且重建结果与 asOf 冻结一致。
- **R3 无静默降级**：语义道、注入、网关失败必须显式 `degraded` 或报错，不得假装成功。
- **R4 T2 不进 facts**：远程内容默认只进 references 且不注入原文；提升必须人工、带理由、留审计。
- **R5 秘密不落明文**：secret 不进 env / 日志 / 审计 / items；只走 Keychain 或 credential-provider，按调用注入。
- **R6 默认不出站**：未声明目的地的 adapter 无网络；出站白名单在 socket/HTTP 层强制。
- **R7 同 UID 不承诺机密**：文档必须写明本机同 UID 进程可读可改；不把「加密」当同 UID 防线。
- **R8 不破坏跨版本承诺**：`MEMO_HOME` 布局与 `MemoryRecord.version` 只加字段、不改语义；schema 变更必须「新字段可缺省 + ADR + `memo migrate`」。
- **R9 不造假数据**：benchmark/评测不得用真实第三方隐私内容；演示数据必须标注为合成。
- **R10 不 push 未审核代码**：本地测试 + eval + 多 agent 审核全过之前，不得 push 或开 PR。

---

## 1. 为什么是现在这个切口

### 1.1 已有资产（2026-11 实测）

| 资产 | 状态 | 证据（v1.2.2） |
|---|---|---|
| 真相层 append-only + 派生层可重建 | 已有 | `docs/02`；753 tests / 56 eval |
| 写入四道门（schema / 脱敏 / 去重 / 冲突） | 已有 | `versions/v1.2/src/core/`、`hygiene/` |
| BM25 + 语义 + RRF、degraded 显式降级 | 已有 | `index/search.js`、`api/search-path.js` |
| 三端共用一份记忆 | 已有 | DSH 插件、MCP server；Codex/Claude 走 MCP |
| 会话决策/坑自动晋升 | 部分 | `session/cli-support.js`（close 时白名单晋升） |
| 任务库（跨任务隔离） | 已有 | v1.1 `session list|rename|remove` |
| 任务上下文账本 | 已有 | v1.2 `session capture|segments|brief|expand|archive`；`sessions/<taskId>/segments.jsonl`；段不进 items/facts；UI 任务页 |
| 夜间确定性整合 | 已有 | `cli/nightly.js`、`config/policy.js` |
| LLM 派生层（可关） | 部分 | `llm/`、Q15；默认不影响真相层 |
| Web 观察台 | 已有 | 九页 UI；任务页含账本 |
| 只读导入 | 部分 | `memo import` 有通用导入；无 claude-mem / AGENTS.md 专用导入 |
| 治理门禁 | 部分 | `quality-check` 15 项、`security-check`、`coverage-gate`、`docs-drift`；v1.3 已把 CI 指向 CURRENT |

### 1.2 竞争格局（2026-11-15 实测，star 会漂移）

| 项目 | 事实 | 对我们的含义 |
|---|---|---|
| mem0（69,004★） | v3 ADD-only，**明确不做 UPDATE/decay**，旧事实永不失效 | 它放弃的正是治理；但它有分发与连接器 |
| claude-mem（117,263★） | 描述已改为「Persistent Context Across Sessions for Every Agent」；6 个 hook、SQLite+FTS5、支持 Claude Code/Codex/Gemini/OpenCode 等 | **捕获/交接已被占**；我们只做只读导入，不建 hook 矩阵 |
| **Mnemosyne（161★，`28naem-del/mnemosyne`）** | 本地 SQLite；每条记忆带来源与信任级；superseded 可回看；as-of 重放；更正沿依赖失效；`bisect`；投毒测试 227 例；整合回执；LongMemEval-S 409/500；npm/MIT/Node 22.16；MCP/HTTP/CLI/SDK | **治理已不是空位**。它是 P0b+P1 的成熟参照；我们不能再声称「唯一可审计」。差异化只能在「看得见 + DSH/中文 + 单进程」 |
| **GateMem（136★，`rzhub/GateMem`）** | 多主体共享记忆治理 benchmark：效用 / 访问控制 / 主动遗忘 | 不要自建榜单；P5 改为内部一致性 + 可选对照，引用它而不是重复它 |
| **guild（297★，`mathomhaus/guild`）** | Go 单二进制 + SQLite；shared context/memory/task coordination；原子 claim；跨编辑器 agent | 任务协调/账本已被占；v1.2 的账本不是差异化，只是 substrate |
| **brain0（289★，`Brain0-ai/brain0`）** | 把 commit 链接到 agent prompt 的决策图「黑盒」 | 可观测性也在被占；我们的 UI 必须给出「注入回执」，而不只是图谱 |
| Hindsight（61,163★）/ Graphiti（32,820★）/ cognee（33,328★）/ Letta（25,449★）/ supermemory（31,628★） | 平台级认知架构 / 时序图 / 记忆 OS | 依赖重，不是单人本机形态；不跟 |
| Lanes Link（36★，lanes-sh/link） | 一条本地 MCP 端点：connections + memory + tasks + files + contacts + secrets；profile 隔离；默认拒绝；append-only 审计 | 仍是端点参照；本期不做它的超集；P4 仍按其触发条件 |
| OpenHuman / Screenpipe | 前者转向 agent harness，后者转向流程挖掘 | 证明「全量捕获」不是单人可持续路线 |
| AGENTS.md / SKILL.md / MCP | 均已捐给 Linux Foundation AAIF；AGENTS.md 60k+ 项目；Skill 70+ 平台 | 接入标准，不发明标准 |

**结论（2026-11-15 修订）**：检索、钩子、任务账本、治理、可观测性**都不是空位**。sedimem 唯一可守的不是「某个功能没人做」，而是「本地 + 中文/DSH 原生 + 单进程零依赖 + 看得见」的组合。因此本计划从「做最完整的治理内核」降级为「做自己能每天用、并且能复核的个人观测台」；治理深度只保留自己敢用所需的底线。

### 1.3 反证：为什么不是别的五件事

- **为什么不做第二个 claude-mem？** 钩子矩阵要跟 harness 升级赛跑，且已被 117k★ 项目占住；它已支持 Claude Code/Codex/Gemini/OpenCode 等，我们只做只读导入，成本低一个量级。
- **为什么不再扩任务账本？** v1.2 已有账本，guild（297★）与 Mesh 也在做；继续加功能是红海里的功能竞赛。账本只作为 pack 的数据源（`includeLedger`），不单独做产品。
- **为什么不对标 Mnemosyne（161★）？** 它已有来源/信任级、as-of 重放、更正沿依赖失效、`bisect`、投毒测试、整合回执和论文级 eval；单人无法在「治理完整度」上超过它。我们只保留自己敢用所需的最小治理（T2 排除、按来源删除、矛盾失效），并把力气放在它没有的：UI 回执、DSH/中文、单进程。
- **为什么不做第二个 Lanes Link？** 它 36★ 说明「个人端点」目前没有拉力；跟做只会得到它的子集。等我们有 pack 的真实使用证据再说（P4 触发条件）。
- **为什么不做 benchmark 榜单？** GateMem（136★）已在做多主体治理 benchmark，BEAM（arXiv 2510.27246）已把矛盾消解列为主要短板；再做榜单是重复且不可信。P5 只做内部一致性 + 可选对照，不做排行榜。

---

## 2. 当前债务（不修就会在新架构里放大）

| # | 债务 | 证据 |
|---|---|---|
| 1 | ~~CI 跑的是 v0.3，`coverage-gate` 写死 v0.1~~（P0a 已修，待 PR 验证） | `.github/workflows/ci.yml`；`tools/coverage-gate.mjs` |
| 2 | Q1「全仓零依赖」会让引入 SDK 的 adapter 直接红 | `tools/quality-check.mjs:91-116` |
| 3 | 仓库无根 `package.json` / lockfile / workspace；插件 `lib/src` 是拷贝（44 文件 / 8,828 行，与 v0.4 差 20 处） | `plugin/dsh-sedimem/`；`scripts/sync-plugin.sh` 只同步 2 文件 |
| 4 | `~/.memo` 已是 880K items，无 workspace 级 profile/迁移测试 | `~/.memo/items/`、`events/`、`brief/`、`metrics/`、`derived/` |
| 5 | 版本矩阵：9 个版本目录 × 3 端 × 3 OS，一人维护不动 | `versions/v0.1`–`v1.2` |
| 6 | 锁：30s 判陈旧、不刷心跳；inbox 另有一套锁 | `storage/lock.js:18,37`；`capture/queue.js:35` |
| 7 | 信任：inbox 无签名；accept 丢来源；记录无 trust/taint | `capture/queue.js:28-29,195-200`；`core/record.js:120-160` |
| 8 | Web：无 token、Host 不校验、缺失 Origin 放行 | `web/server.js:93,101-109`；`web/api/write.js:43` |
| 9 | 权限：全仓仅一处 0o600；`~/.memo` 会被 Time Machine/iCloud 备份 | `index/vector-index.js:120`；`config/paths.js` |
| 10 | 读路径把 hits 写回真相层，pack 非纯派生 | `api/search-path.js:150`；`api/lifecycle.js:152` |
| 11 | 凭据走 env 会被 `printenv` / `ps eww` / 子进程读走 | §10 改为 Keychain + fd/pipe |
| 12 | 文档口径漂移：README 写 747 tests、覆盖率 89/90/77、12 模块；实际 753 tests / 14 目录；85/70/90 是 docs/07 的覆盖率阈值 | `README.md:21,200,267`；`docs/07:56-58` |
| 13 | `engines.node` 写 `>=22`，但 transcript 的 zstd 需要 `>=22.15` | `versions/v1.2/package.json:11-12`；`session/transcript.js:70-81` |
| 14 | v1.2 任务账本 segments 在 items 之外，未纳入数据地图/保留期/按来源删除/导出 | `src/session/ledger.js`、`sessions/<taskId>/segments.jsonl`；`docs/12-data-map.md` 尚不存在 |

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
| I-4 | **（P3 起生效）** adapter 不读 items / inbox / events；不接收 `MEMO_HOME`；只持自己的私钥；只通过 ingest 投递 | `spawn` 清 env 后 adapter 无法定位 `~/.memo`；直写 items 必须失败并写 `acl.deny` |
| I-5 | 外部读取默认最小：search 只回 id + 片段（单条 ≤200 字，默认 ≤N 条/次），每次会话有字节预算 | 超预算报错；`search` 不返回正文 |
| I-6 | 同一 `asOf` 的 pack 逐字节相等（确定性排序；nonce 由 `hash(contentHash+asOf)` 确定性派生） | 同参数两次 pack `diff` 为空 |
| I-7 | 冲突可失效、as-of 可回查；`superseded` 是失效不是删除 | 旧 asOf 能检出新旧两版；新 asOf 只回有效版 |
| I-8 | 出站默认关闭；adapter 无网络默认断网；目的地白名单在 socket/HTTP 层强制 | 未声明目的地时 POST 被拒 |
| I-9 | C6 口径：每客户端 ≤1 kernel + ≤1 可选 daemon；无 daemon 功能全集可用；常驻 RSS <100MB | 新增 `tests/invariance/i9-*.js` 断言进程数/依赖/RSS |
| I-10 | profile 显式映射，不跨 profile 读；**默认 profile 固定在 `~/.memo`**，命名 profile 在 `~/.memo/profiles/<name>/`，不做物理迁移 | 切 profile 后 `memory_get` 看不到旧数据；缺失指针 fail-closed |
| I-11 | T2 内容默认不注入原文；必须注入时只注入结构化抽取，围栏加确定性 nonce，并逐行转义所有分隔符 | canary T2 不得触发任何工具调用/出站 |
| I-12 | 逻辑删除是默认语义；审计脱敏只追加「脱敏事件」，**不改历史行**（否则 prevHash 链断） | 删除后 `get` 为空但链仍可验；脱敏后旧行 hash 不变 |
| I-13 | **（P3 起生效）** 协议版本由写入端盖章；旧 kernel 遇未知大版本拒收，不 fail-open | 用 v2 信封打 v1 kernel → `E_PROTOCOL_UNSUPPORTED` |
| I-14 | Q 门禁冻结为 15 项（Q1–Q11、Q13–Q16）；新增不变量走 G 系列，不挤 Q | `quality-check` 断言 Q 集合 = 冻结集合 |
| I-15 | 任务账本段永不进入 pack 的 `facts`；账本为空时 pack 输出与引入账本前逐字节一致（可加性扩展） | 关账本后 pack `diff` 为空；构造含段的 pack 断言 `facts` 里无段 id |

### 3.2 边界规则（可检查，不是口号）

- **B1 读写分离**：`api/*` 不直接碰 `storage/jsonl-store.js`；以 `tests/unit/arch-boundaries.test.js` 为起点扩展到根包。
- **B2 依赖方向**：kernel 不 import adapters / plugin；adapters 只依赖 `packages/protocol` 与自身 SDK。
- **B3 副作用隔离**：`render/*`、`views/*` 纯函数；`Date.now()` / `process.env` 只在入口注入。
- **B4 版本冻结**：每个 `versions/vX.Y/` 下有 `FROZEN.md`（v0.1–v1.1 已有；v1.2 尚未冻结，故可改）；`versions/CURRENT` 是**文件**，内容是版本名；跨版本不共享代码路径（`docs/03:32-36`）。
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

**实施时点（重要）**：本节协议随**未来的常驻 adapter**（最早 P4）一起实施；P0b 只做 §4.2 的字段、backfill 与人工提升，不做密钥、`packages/protocol` 或常驻 adapter；P2 一期是 `memo import <source>` 只读 CLI，不经过本节信封。换句话说，P0b/P1 的安全边界是「单机、单写者、人工提升」，Ed25519 解决的是「多进程各自写候选」的场景，等真正需要常驻 adapter 时再加。

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

输入：`{ task, asOf, budgetTokens, profile, kinds?, includeT2?, includeLedger? }`
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
  "basis": { "retrieval": "bm25+vector+rrf", "k": 60 },
  "receipt": { "id": "evt_...", "packHash": "sha256:..." }
}
```

约束：

- 排序确定性：`(trustRank, kindRank, score, id)`；**不按「最近命中」排序**（否则输出依赖历史调用次数）。
- `asOf` 冻结；同输入两次输出逐字节相等（I-6）。
- 超预算先裁 `references`，再裁低分 facts；被裁项进 `excluded` 并给原因。
- T2 默认只进 `references`，且只给片段；`includeT2: true` 才进 `facts`（仍需人工提升）。
- 不读写真相层计数（hits 移出真相层，见 §6.2-11、§18-3）。
- `includeLedger:true` 时，任务账本（`~/.memo/sessions/<taskId>/segments.jsonl`）作为一个数据源参与装配；**段只贡献 `references` 与 `summary`，永不进 `facts`**（见 v1.2 计划与 I-15）。
- **注入回执**：每次 pack / brief / inject 都向 `events.jsonl` 追加一条 `kind:"inject"` 事件（`packHash`、`recordIds`、`excluded`、`asOf`、`surface`）；只写 events，不写 items。回执是「agent 到底看到了什么」的证据，也是 UI 观测台的可展开项。

### 5.4 审批队列（P3）

审批队列 `~/.memo/tasks/*.jsonl`，append-only，状态机 `pending → approved | rejected | expired`。审批通过才允许 adapter 执行外写；审批记录进 `events.jsonl`。

> 与「任务账本」区分：账本是任务的过程上下文（`~/.memo/sessions/<taskId>/`，v1.2），审批队列是外写动作的前置门（本目录）。两者不共用目录、不共用状态机。

### 5.5 CLI / MCP 表面

**现状（v1.2）**：MCP 默认注册 17 个工具（`tools.js:324` 的 `TOOL_DEFS = [...MEMORY_TOOL_DEFS, ...SESSION_TOOL_DEFS]`），且 `--session-tools` 开关尚未实现、没有 `memo mcp` 子命令。**目标**：P1 默认面 4 个（`memory_search`、`memory_write`、`memory_brief`、`memory_pack`）；其余走显式开关。

**P0b 必须先做迁移开关**，再做收敛：新增 `memo mcp --surface core|all`（`core` = 3 个，P1 变 4 个）与 `--session-tools`；先把现有 17 个的兼容表写出来，再把默认切到 `core`。默认面收敛与「先新增开关」在同一阶段完成，不允许直接删工具。

兼容表：旧配置若依赖 `memory_curate` / 会话工具，在插件 UI 里改走 CLI 或 `--surface all` / `--session-tools`，并在升级说明里写清楚。

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
| adapter 协议意图（不建 `packages/protocol`） | `docs/02` + ADR | 只记信封/签名/版本意图；P4 引入常驻 adapter 时才实现 |
| Q1 scope 调整 | `docs/03:44` + `docs/07` | 与「Q1 全仓生效」同步改口径 |
| 任务账本纳入数据地图/删除 | `docs/12` + `src/session/ledger.js` | 段保留期、导出、`deleteBySource` |

每项一个 issue；PR 用 `Refs #N`。未完成前不动对应代码。

### 6.1 P0a 地基 · v1.3（工作量 1.5–2 个周末）

目标：**让「CI 绿」这句话变真**。

1. **CI 指向当前版本**（半天）：新增 step
   `echo "dir=versions/$(cat versions/CURRENT)" >> "$GITHUB_OUTPUT"`，各步骤 `working-directory: ${{ steps.v.outputs.dir }}`；artifact 路径同样用该 output。禁止把 `versions/CURRENT` 当目录。目标：753 tests / 56 eval 真正跑起来。
2. **windows-smoke 跟随 CURRENT**：`tools/windows-smoke.mjs:24-26` 改为按 `versions/CURRENT` import；否则 G0 必红。
3. **门禁防回退**：`tools/meta-check.mjs` 断言 CI/gate 脚本里不得出现字面 `versions/v0.x`（allowlist 需 reason + until）。
4. **Q1 scope**：`quality-check.mjs:91-116` 只对 `versions/CURRENT/src` + 已存在的 `packages/*/src` 生效；adapters 由 G6（依赖清单）与 G7（架构负向测试）覆盖；同步改 `docs/03:44` 的「Q1 全仓生效」表述。
5. **根 workspace**：根 `package.json`（`private: true`）+ `pnpm-workspace.yaml` + 单 lockfile；`plugin/dsh-sedimem` 改为 `workspace:*` 依赖（workspace 链接不需要发布，`private:false` 不等于要发 npm）；`private:false` 只对将来要发布的一方包设置。
6. **README 口径修正**：tests 753（不是 747）；覆盖率 85/70/90（不是 89/90/77）；14 个模块目录（不是 12）；「零依赖」改为「内核零运行时依赖」；claude-mem「只服务 Claude」改为「支持 6+ harness（含 dsh）」。
7. **engines 抬到 `>=22.15`**：`versions/v1.3/package.json`；README 注明 transcript 源需 22.15+（`session/transcript.js:70-81` 已有 feature guard）。
8. **命名澄清（只改文档）**：四道门 = schema / 脱敏 / 去重 / 冲突；`V1–V5` 仅指 curate 批文件校验，**不改代码标识符**。
9. **G0 基线**：记录 `tests / eval / quality / security / docs-drift` 的耗时与通过率，写进计划「执行结果」。
10. **最小 G6**：`tools/supply-check.mjs`——committed lockfile、`npm ci --ignore-scripts` 可装、无 postinstall 网络、SBOM 生成。

**验收**：CI 在 `versions/CURRENT` 上绿（753 tests / 56 eval）；G0 五项可见；meta-check 能拦住硬编码版本；README 数字与门禁一致。

### 6.2 P0b 安全与信任最小集 · v1.4（工作量 2–2.5 个周末）

目标：**让「审计」这个词站得住，但不建通用平台件**。

1. **锁**：storage 数据锁（items / inbox / events）统一为 `<memoHome>/.lock`，加 5s 心跳，判陈旧改「mtime 超时 **且** pid 不存在」；`capture/queue.js` 的 mkdir 同步锁改为同一把；`llm/outbox` 锁保留（Q15 禁依赖 storage），在 ADR 写理由。CI 加两进程并发 append + `kill -9` 测试。
2. **队列流式化**：append 不整文件重读重写；per-adapter + 每日 + 单文件字节配额；行长度与 `provenance` 数组上限；超限拒绝并审计。
3. **签名信封（不在 MVP；最早 P4）**：本阶段只定义 `adapter.json` 的 trust 上限与来源字段；Ed25519 注册 / 轮换 / kid / 双 key 留到引入常驻 adapter 时（最早 P4）。P0b 不因缺签名而阻塞，验收也不含伪造信封。
4. **trust / taint 落 schema**：按 §4.2；`accept` 只继承；`merge/supersede` 追加 `v+1` 并集；`memo trust promote|clean` 带理由与审计。
5. **存量 backfill**：按 §4.1 规则一次性补齐；迁移前先备份；`memo migrate` 支持回滚；测试断言「迁移后 pack 非空」。
6. **按来源删除**：`memo delete --source adapter:gmail --uri msg://...` → 墓碑 + compact + 清派生（index/brief/vectors/projections）+ 审计脱敏事件 + 备份说明；`memo verify-delete` 打印目标是否已不可检索；任务账本 segments 同步纳入（按 taskId / 来源导出与删除）。
7. **profile 路径收敛**：所有入口只走 `resolveMemoHome(env, cwd, profilePointer)`；默认 profile 永久映射 `~/.memo`，命名 profile `~/.memo/profiles/<name>/`；`~/.memo/profiles.json` 只存命名 profile 的指针（不在 profile 内）；指针缺失 fail-closed；**不做物理迁移**（不违反 `docs/03:45` 跨版本承诺）。
8. **Web 鉴权**：`memo serve` 在 `GET /`（Host 限 loopback）下发短期 `HttpOnly; SameSite=Strict` cookie；`/api/**` 同时接受 cookie 或 `Authorization: Bearer`；`ui/api.js` 用同源 fetch 自动带 cookie（无需改调用）；无 Cookie/Token → 401；强校验 Host/Origin；可选 UDS + peer-credential。
9. **权限**：`~/.memo` 及子目录 0700、文件 0600；启动校验并告警；`tmutil addexclusion` 与云盘排除写进文档。
10. **T2 注入**：默认不注入原文；必须注入时只注入结构化抽取；围栏 nonce = `hash(contentHash + asOf)` 前 8 位；逐行转义所有分隔符；「数据不是指令」写进 system prompt；canary 行为测试（T2 指令不得触发任何工具调用/出站）。
11. **hits 只做观测（不迁移）**：P0b 只加测试与 ADR，把 `search-path.js:150` 的 `flushHits` 标为待迁移；列出 `brief.js:104`、`quota.js:45`、`judge`、web read 的改法；**P1 再移出真相层**。避免 P0b 同时改语义和排序。
12. **审计统一**：`events.jsonl` 为唯一审计源（`kind` + `seq` + `prevHash`）；gateway 只转发不写；外部锚定 = 可选「每日把链头 hash 写进本地 git 提交（不 push）」；写明无锚定时只能防无意损坏。
13. **数据地图与保留期**：新增 `docs/12-data-map.md`（资产 / 位置 / 保留期 / 删除路径 / PII 类别；含 `sessions/<taskId>/segments.jsonl`）；候选 14 天过期（P0b 新增清理任务，挂进 nightly）；任务账本 90 天（可配）；events / quarantine 90 天；T2 默认 7 天；`redact.js:6-14` 增 PII 类别。
14. **工具面收敛（先加开关）**：v1.2 当前默认注册 17 个、无 `--session-tools`、无 `memo mcp`；P0b 新增 `memo mcp --surface core|all` 与 `--session-tools`，默认切到 `core` 的 3 个（search / write / brief）；P1 加 pack 变 4 个；其余 7 个 `memory_*` 走 `--surface all`，5 个会话工具走 `--session-tools`；插件 UI 的 `memory_curate` 改走 CLI 或 `--surface all`；schema token 预算留到 P1。
15. **读预算**：`search` 默认 ≤N 条片段、单条 ≤200 字；每会话条数/字节上限；超限报错；落点 `api/search-path.js`。
16. **Windows 声明**：只支持 kernel / CLI；adapters 不支持；`memo doctor` 在 win32 打印 `unsupported` 并 exit 2；写进 README 与 §16。
17. **quarantine**：只存引用（uri + hash + ≤200 字摘录），不存正文；`memo quarantine list|accept|reject`；retention 与配额同 inbox。

**验收**：T2 canary 零外写；kill -9 后锁可恢复且不丢写；`memo verify-delete` 通过（含任务账本段）；web 无 token 401、有 token 200 且 UI 仍可用；命名 profile 互不可见（同进程切换不串数据）；存量 backfill 后 pack 非空且 trust 可查。

### 6.3 P1 装配与注入回执 · v2.0（工作量 2–3 个周末）

目标：**用现有数据证明「装配」值得做，并让「agent 看到了什么」可复核**。

1. `memory_pack`（内核内实现，不引第三方）：以 `session/ledger-brief.js` 的 `briefJson` 为子集基线，扩成超集（records + ledger + `includeLedger`）；确定性排序、预算裁剪、T2 分区、`excluded` 原因。
2. `memo export agents-md`：把 decision/gotcha 写成**带 provenance 的 AGENTS.md 节**，可配置 marker，不覆盖用户手写内容。
3. **`memo init`**（clone 后本地运行，暂不发 npm）：探测 DSH/Codex/Claude 配置，幂等写 MCP 配置 + 打印验证命令。
4. **`memo audit`**：只读扫描 `~/.claude-mem/*.sqlite`、`AGENTS.md` / `CLAUDE.md`、`~/.codex/memories`，输出卫生报告（重复/过期/无来源/冲突），不写任何东西。二者都以 `git clone` 后本地可用为前提；是否发 npm 单列决策，不在 P1 阻塞。
5. 默认工具面变 4 个（加 `memory_pack`）；schema token 预算进 G4。
6. **先做基线实验**：固定 20 个任务、同一 harness、同一模型；对比 `brief` 与 `pack` 的 token 与事实召回。**不达标不发**：事实召回 20/20（Wilson 95% 下界 ≈84%；19/20 不通过）、token ≤ brief 的 70%。
7. hits 迁移到 metrics/events（带 ADR）；更新 brief / quota / judge / web-read 四处读取。
8. **注入回执**：每次 brief / pack / inject 生成一条 `inject` 事件（`packHash`、`recordIds`、`excluded` 原因、`asOf`、`surface`），只写 `events.jsonl`，**不写 items**；UI 的今日页/任务页可展开「这次 agent 看到了什么」。这是与 claude-mem / Mnemosyne CLI 叙事的差异点。

**验收**：pack 输出可复现（逐字节）；AGENTS.md 导出可被 DSH/Codex 直接消费；init 在干净机器上 5 分钟内完成；基线实验报告可复现；**注入回执覆盖率 100%**（每次注入都有一条可查事件）。

### 6.4 P2 只读导入 · v2.1（工作量 2–3 个周末，先做 1 周 spike）

目标：**治理别人的捕获，而不是自己再抓一遍**；零迁移获得增量，不建钩子矩阵。

| 源 | 做法 | 不做什么 |
|---|---|---|
| claude-mem | 只读 `~/.claude-mem/*.sqlite` → 候选（T2，需 accept） | 不装它的 hook、不双写 |
| AGENTS.md / CLAUDE.md / SKILL.md | 解析标题/条目 → 候选；只当数据 | 不执行指令、不改原文件 |
| git | CLI 读本地 repo（可配作者过滤）→ 提交摘要候选 | 不做 CI 集成、不读远端 |
| 本地文档 | markdown / 纯文本目录 → 候选 | 不做全盘索引 |
| `.ics` | 读导出文件；只取本人相关字段（subject/time/attendee 的最小集） | 不做 OAuth、不做 IMAP |
| DSH transcript | 已有 `session/transcript.js`；**仅 Node ≥22.15 可用**；先补测试再接 `memo import transcript` | 不做常驻 tail |

- 一期全部走 `memo import <source>` CLI（一次性 / 按需），**不引入常驻 adapter 进程、不引入 Ed25519**；只有出现第二个需要持续同步的源，才启用 §4.3 协议。这样 P2 不依赖 `packages/protocol`。
- **不做**：hook 矩阵、OAuth、IMAP、日历/邮件 API（§16）。
- 验收（连续 14 天，每日手动跑一次即可，**不依赖 P3 的调度器**）：候选 ≥150；accept ≥60%；40–60% 先调启发式再延一轮；<40% 停。

### 6.5 P3 行动 · v2.2（工作量 3–5 个周末）

1. 最小 scheduler：one-shot + cron 一行（不引 cron 库，`setTimeout` 到下一分钟）；`memo schedule add|list|run`。
2. 最小 supervisor：child_process 拉起 / 重启 / 退避；最大进程数；健康超时；`memo adapter doctor` 打印 last-event。
3. 任务审批（任务库 v1.1 已有，不再重做）：`memo tasks list|approve|reject`；外写 adapter 必须拿到 approved token。
4. 首个动作：`memo next`（今日待办/待确认）+ 晚间 `today.md` 摘要。
5. 验收：`today.md` 使用率 ≥50%（<20% 停）。判定口径：当日 `today.md` mtime 发生变化，且次日 `memo next` 的输出包含其中至少一条；两项都满足才算「使用」。每周至少一次由调度产生的有效动作。

### 6.6 P4 个人端点 · v2.3（可选，4–6 个周末，触发后才做）

只在**两个硬条件同时成立**时启动：

1. 出现第二个真实消费者（不是本人脚本），且有 issue 记录其需求；
2. pack 已连续使用 ≥30 天，且 `memo stats` 能看到稳定的读取来源分布。

内容：gateway（聚合 + profile + 默认拒绝 + 审计转发）、`secrets`（Keychain / credential-provider）、`files` / `contacts` 只读视图。**不承接内核写**；不把网关做成单点（默认不启用，旁路）。

### 6.7 P5 内部一致性 + 可选对照 · v2.4（2–3 个周末，不作为对外榜单）

把 eval runner 抽成 `sedimem-conformance`：输入任意记忆库导出（JSONL / MCP 只读端点），输出治理判定（重复、过期、矛盾、来源、删除、as-of）。**先服务自己**：每次发布前跑一遍，防止治理行为回退。只有在主仓出现外部使用者后，才可选做「对 mem0 / claude-mem / Mnemosyne 各跑一份对照」；引用 GateMem / BEAM 的方法，不自建排行榜。

---

## 7. 关键设计决策（为什么不是别的）

### 7.1 为什么治理而不是检索

检索是红海且有现成 RRF/向量库；治理（append-only + 失效 + as-of + 来源删除）曾是 mem0 明确不做、claude-mem 不覆盖的空白，但 2026-11-15 复核发现 Mnemosyne（161★）已把它做成产品。**治理不再是差异化，而是自用底线**；我们保留最小治理，是为了「自己敢把真实决策交给它」，不是为了在功能表上赢。差异化改由 UI 回执、DSH/中文、单进程承担（§0.1）。

### 7.2 为什么 pack 不自定义主格式

宿主已占住注入位（DSH auto-compact、Claude auto memory、Codex Memories、AGENTS.md）。再定义一个 `<context-pack>` 只会造成双份注入与「记忆说 A、pack 说 B」。pack 输出三种标准物，让宿主自己决定何时注入。

### 7.3 为什么不建 hook 矩阵

claude-mem（117k★）已支持 Claude Code/Codex/Gemini/OpenCode 等 6+ harness，且钩子要跟 harness 升级赛跑。我们只保留 DSH 插件一条实时路径 + 只读 importer；Claude 用其自身 hook 打 loopback（P2 可选），Codex 只做按需 import。

### 7.4 为什么先 pack 后捕获

用户能感知的是「答得更准」，不是「记得更多」。现有数据足够验证 pack；捕获扩张应由此暴露的召回缺口驱动，而不是先建 100 个连接器。

### 7.5 为什么网关降为可选

单端点 + 直连兜底在 MCP 客户端不成立（三份独立配置、无健康检查）；网关半死会让工具超时。先保留 stdio 直连，网关只在第二消费者出现后作为旁路。

### 7.6 为什么 Ed25519 而不是 HMAC

HMAC 要求 adapter 持有共享密钥，而共享密钥只能放 `MEMO_HOME`（违反 I-4），且无 `kid` 无法轮换。Ed25519 让 adapter 只持私钥、kernel 只存公钥，轮换用 `kid` 双窗口。**本期不实施**：P2 的只读导入走 CLI，不引入常驻 adapter；只有出现持续同步源时才启用。

### 7.7 为什么不做 benchmark 榜单

GateMem（136★）已在做多主体治理 benchmark，BEAM 已覆盖矛盾消解；再做榜单是重复且不可信。P5 只做内部一致性 + 可选对照，不做排行榜。

---

## 8. 验收指标（预注册，样本量与阈值先定）

| 阶段 | 指标 | 阈值 | 样本 |
|---|---|---|---|
| P0a | CI 在 CURRENT 上绿 | 五项全绿（753 tests / 56 eval） | 每次 push |
| P0a | 门禁防回退 | meta-check 拦硬编码 | 故意注入 v0.3 的 PR |
| P0b | 任务账本删除 | `verify-delete` 覆盖 segments | 集成 |
| P0b | T2 canary | 0 次外写/工具调用 | 20 条注入样本（含改写/翻译/base64） |
| P0b | 并发丢写 | 0 | 2 进程 × 1000 次 append + kill -9 |
| P0b | web 鉴权 | 无 token 401 / 有 token 200 | 手工 + 集成 |
| P1 | pack 事实召回 | 20/20（Wilson 95% 下界 ≈84%） | 20 个固定任务 |
| P1 | pack token | ≤ brief 的 70% | 同上 |
| P1 | pack 确定性 | 同 asOf 两次逐字节相等 | 10 次 |
| P1 | 注入回执 | 覆盖率 100% | 10 次注入 |
| P2 | 候选量 | ≥150 / 14 天 | 真实使用 |
| P2 | accept 率 | ≥60%；40–60% 调启发式后再测；<40% 停；候选 50–150 条时延长试验 | 同上 |
| P3 | today.md 使用 | ≥50%（<20% 停） | 4 周 |
| P4 | 第二消费者 | 有 issue + 实测 30 天 | 硬触发 |
| P5 | 内部一致性 | 发布前全过 | 每次发布 |
| P5 | 外部对照（可选） | 3 个外部使用者跑通 | 公开邀请 |

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

- 历史证据：v1.0 重构 12 天 / 90 commits；2026-11-14 单日 22 commits；v1.1–v1.2（任务库 + 账本）约一周内交付、+约 100 tests。单人可持续节奏约每周 1–2 个有效工作日。
- 阶段工作量按「周末」计（1 周末 ≈ 2 天）：

| 阶段 | 周末 | 日历（含缓冲） |
|---|---|---|
| P0a | 1.5–2 | 3 周 |
| P0b | 2–2.5 | 5–6 周 |
| P1 | 2–3 | 5–6 周 |
| P2 | 2–3 | 5–6 周 |
| P3 | 3–5 | 6–10 周 |
| P4 | 4–6 | 仅在触发后 |
| P5 | 2–3 | 仅在主仓有外部使用者后 |

**MVP（P0a + P0b + P1）合计 5.5–7.5 个周末，日历约 3–4 个月**。验收窗口里的「14 天 / 4 周」是**日历观察窗口**，不是额外工作量；累计日历至少 +6–10 周。P1 从 3–4 降到 2–3，因为 v1.2 的 `briefJson` 已是 pack 的子集。

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
| R-11 | Q 门禁与 G 系列漂移 | 中 | 低 | Q 冻结 15（Q1–Q11+Q13–Q16）；G 单独编号；docs/07 R5 同步 |
| R-12 | `~/.memo` 被云盘/备份带走 | 中 | 高 | 启动校验 + 排除 + 可选加密 |
| R-13 | 供应链（第三方包/可选二进制） | 中 | 高 | 单 lockfile + `--ignore-scripts` + SBOM + 签名 |
| R-14 | 删来源时漏清派生层 | 中 | 中 | `deleteBySource` 统一入口 + `verify-delete` |
| R-15 | 计划改变了设计却没回写规格 | 中 | 中 | §6.0 前置；docs-drift + 人工 review |
| R-16 | 单人评审容量（无第二 maintainer） | 高 | 中 | 适配器上限 2 个；issue 模板；外部贡献只收测试/文档 |

---

## 14. 质量门禁调整

### 14.1 现状

- `quality-check.mjs`：Q1–Q11、Q13–Q16，共 **15 项**（Q12 跳号预留）。
- `docs-drift-check.mjs`：R1–R6；`docs/07` 声明的 Q 项数必须等于实际 Q 编号数。
- `coverage-gate.mjs`：lines ≥85 / branches ≥70 / functions ≥90（与 `docs/07:56-58` 一致）。
- **Q 冻结 15 项**：本计划期间不新增 Q；新增不变量走 G 系列。

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
- 不做图谱物化邻接（仅当出现 k-hop 查询或 `/api/graph` P95 超预算时，才作为可删可重建的派生缓存；当前不排期）。
- 不做跨源实体消解（ER）；多源只保留 provenance，不把不同来源的记录合并成单一实体。
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

### 17.5 2026-11-15 v1.2 复核记录（本轮修订）

**触发**：m00378。仓库从计划基线 v1.0.3 前进到 v1.2.2：v1.1 增加任务库管理，v1.2 增加任务上下文账本（753 tests / 56 eval / Q15）；同时外部生态出现 claude-mem 117,263★、Mnemosyne 161★、GateMem 136★、guild 297★、brain0 289★。

**方法**：重读 v1.2 的 `versions/CURRENT`、`package.json`、`README.md`、`.github/workflows/ci.yml`、`tools/coverage-gate.mjs` 与四份新调研文档；对照 §0.1 的竞争事实与 §6 的阶段依赖逐条改写；改后跑 `quality-check`（15/15）与 `docs-drift-check`（17 文档 / 56 eval / Q15）。随后启动第五轮 delta 对抗复核（只读）：**返回 1 blocker + 8 major + 3 minor，均已在下面修掉**；修后复跑门禁通过，本轮结论为「第五轮 pass（文档级）、待用户拍板」。

**本轮修掉的 9 处不一致**：

1. 旧稿把 Ed25519 写成 P0b「应该做」——与「P0b 不做签名」冲突；现明确「最早 P4，等常驻 adapter」。
2. B4 仍写「v1.0 尚未冻结」——实际 v1.0/v1.1 已冻结、v1.2 才是可改版本；已改。
3. 旧稿 MVP 6–8.5 周末、P1 3–4——与 v1.2 `briefJson` 已是 pack 子集不符；现 5.5–7.5、P1 2–3。
4. Q 冻结仍写 14 项——v1.2 已有 Q16，实际 15 项；I-14/§14.1/R-11 已同步。
5. 旧稿写 P2 会引入常驻 adapter/协议包——与「只读导入」冲突；现 P2 全部走 `memo import`，且 §6.0 不再把 `packages/protocol` 列为 P0a 前置。
6. §19 写了不存在的 `cli/mcp.js`、`cli/serve.js`——实际 `cmdServe` 在 `cli/commands/ops.js`；已改为真实路径并补 `commands/memory.js`。
7. §19 漏了 `quarantine` 的模块与子命令——已补 `capture/quarantine.js`（新增）与 `memo quarantine`。
8. 工具面把「现有 3 个」当事实——v1.2 实际默认注册 17 个、无 `--session-tools`；现改为「P0b 先新增 `memo mcp --surface core|all` 开关，再收敛到 3」。
9. §6.3 写 `npx ... init/audit`，与「无外部用户前不发 npm」冲突——已改为 clone 后本地运行，发布单列决策；`docs/plans/README.md` 行已存在，对应债务与 P0a 动作已删。

**P0a 已闭合（本地，待 CI 验证）**：CI / `coverage-gate` / `windows-smoke` 跟随 `versions/CURRENT`、`engines >=22.15`、README/项目站/契约文档同步。P0a 余项见 `docs/plans/v1.3-p0a.md`。

**残留判断风险**：竞争格局可能在一个月内再变（claude-mem 迭代很快）；本计划的对策是不追功能、只守「本地/中文/DSH/看得见」，每季度复核一次 §0.1，不把单次扫描当永久结论。

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
9. **战略分叉（2026-11-15，已拍板）**：选 **A**（个人观测台 + 治理工作台）；B（通用治理平台，对标 Mnemosyne/GateMem）与 C（以 Mnemosyne 为内核或只读导入源）不执行，不写相关代码。
10. **是否把 Mnemosyne 纳入 P2 对照/导入**：它已有 npm、SQLite、as-of 与回执；作为只读导入源可减少重复造轮，但会增加外部依赖与格式跟踪。触发条件 = 其导出格式稳定 ≥2 个版本，且 P1 已证明 pack 有日常使用。

11. **图谱与多源口径（2026-11-17 已定，按 A 执行）**：图谱 = **force-graph + 请求时构图**（只读派生视图，节点上限 300，真相层仍是 JSONL）；SQLite 物化邻接**不进 P0a–P5**，仅当出现 k-hop 查询或 `/api/graph` P95 超预算时，才作为可删可重建的派生表；多源只做 **provenance**（`trust` / `taint` / `sourceRefs`、按来源删除、`verify-delete`），**不做 ER/实体消解**；P2 只读导入的每条记录保留来源，不合并成单一实体。

---

## 19. 写盘范围（本计划若批准）

**P0a · v1.3**

- `.github/workflows/ci.yml`
- `tools/meta-check.mjs`（新增）、`tools/windows-smoke.mjs`、`tools/coverage-gate.mjs`
- `tools/quality-check.mjs`（Q1 scope）
- 根 `package.json`、`pnpm-workspace.yaml`
- `plugin/dsh-sedimem/package.json`（workspace 依赖）
- `README.md`、`README.en.md`、`docs/index.html`、`docs/en/index.html`
- `docs/00`、`docs/01`、`docs/03`、`docs/04`、`docs/06`、`docs/07`、`docs/08`、`docs/11`（doc-version / 路径）
- `docs/plans/README.md`、`docs/plans/v1.3-p0a.md`（新增）
- `versions/v1.3/package.json`（engines、version）、`versions/v1.3/CHANGELOG.md`、`versions/v1.2/FROZEN.md`

**P0b · v1.4**

- `versions/v1.4/src/storage/lock.js`、`storage/jsonl-store.js`
- `versions/v1.4/src/capture/queue.js`
- `versions/v1.4/src/core/record.js`、`api/write-path.js`、`api/maintenance.js`
- `versions/v1.4/src/api/search-path.js`（读预算 + hits 标记）
- `versions/v1.4/src/render/inject.js`、`render/brief.js`、`render/tier0.js`
- `versions/v1.4/src/hygiene/redact.js`、`quota.js`、`judge.js`
- `versions/v1.4/src/web/server.js`、`web/api/write.js`、`web/api/read.js`、`web/static.js`
- `versions/v1.4/src/config/paths.js`、`cli/commands/shared.js`、`cli/capture.js`、`cli/commands/ops.js`、`cli/commands/memory.js`
- `versions/v1.4/src/mcp/tools.js`、`mcp/session-tools.js`、`mcp/server.js`、`cli/commands/mcp.js`（新增 `memo mcp` 开关）
- `versions/v1.4/src/api/lifecycle.js`
- `versions/v1.4/ui/api.js`（仅 cookie 兼容；如无需改动则不动）
- `versions/v1.4/src/session/cli-support.js`、`session/transcript.js`、`session/ledger.js`
- `versions/v1.4/src/capture/quarantine.js`（新增）
- `versions/v1.4/src/cli/memo.js` + 新子命令（`trust`、`delete`、`verify-delete`、`quarantine`、`migrate`）
- `versions/v1.4/tests/**`（含 `tests/invariance/`、`tests/injection/`）
- `tools/supply-check.mjs`（新增）
- `docs/02-data-model-and-contract.md`、`docs/12-data-map.md`（新增）、`docs/adr-*.md`
- `docs/plans/future-architecture.md`（本文件）

**P1 · v2.0**

- `versions/v2.0/src/api/pack.js`（新增；复用 `session/ledger-brief.js`）
- `versions/v2.0/src/cli/init.js`、`cli/audit.js`、`cli/export.js`（新增）
- `versions/v2.0/eval/`（基线实验；不是 `src/eval/`）
- `versions/v2.0/ui/**`（注入回执视图）
- `versions/v2.0/package.json`（bin 增 `mem`）

**P2 · v2.1**

- `versions/v2.1/src/cli/import-*.js`（新增：claude-mem / agents-md / git / ics / transcript）
- `versions/v2.1/src/importers/*`（新增，只读）
- `versions/v2.1/tests/importers/**`

**P3–P5 · v2.2–v2.4**：`adapters/*`、`packages/protocol`、`packages/gateway`、`tools/gen-compat.mjs` 的扩展，按阶段另立 issue。

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
