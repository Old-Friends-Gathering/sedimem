# 03 · 可演化性与版本管理

> doc-kind: manual
> doc-version: 1.1
> verified-at: 2026-11-14
> verified-against: versions/CURRENT（v1.0 / 1.0.0）

## 1. 为什么 v0.1 必须「笨」

v0.1 刻意用最笨的实现（纯 JS 倒排索引、规则化裁决、无 embedding），换取三件事：**可测、可换、可重建**。任何让这三件事变差的优化都不进 v0.1。

## 2. 扩展点（新增能力只加适配器，不改 core）

下表「所在文件」均相对 `versions/CURRENT` 指向的版本目录（现为 `versions/v1.1/src/`）：

| Port | 状态 | 所在文件 | 说明 | 切换方式 |
|---|---|---|---|---|
| `StoragePort` | **已落地** | `storage/jsonl-store.js`（真相层 append-only JSONL，同 id 最后一行胜出）、`storage/lock.js` | sqlite / S3 / git+merge 等实现仍是替换点 | 注入 |
| `IndexPort` | **已落地** | `index/inverted-index.js`（内存 BM25）、`index/sqlite-index.js`（FTS5）、`index/hybrid-index.js`（BM25+dense，RRF k=60）；单点注入 `index/create-index.js` | 后端可换且只有一处注入点 | `config/policy.json` 的 `index.backend` |
| `JudgePort` | **已落地** | `hygiene/judge.js`（确定性规则裁决器，`memo curate auto` 默认） | LLM 裁决实现留给 LlmPort（v1.0） | `createMemoryService({ judge })` 注入 |
| `EmbedderPort` | **已落地** | `index/embedder.js`（kind=`none` 默认空实现 / `http` OpenAI 兼容）；失败返回 `E_EMBED_UNAVAILABLE`，调用方降级打 `degraded` | 语义道可插拔，不阻塞写入 | `policy.search.embedder.kind` |
| `ViewsPort` | **已落地** | `views/l2.js`（L2 场景块）、`views/l3.js`（L3 画像，带 sourceRefs 溯源）、`views/conflicts.js`（分歧视图） | 视图是派生物，删目录重建须字节相同 | 注入 |
| `RendererPort` | 已落地 | `render/brief.js`（确定性渲染） | 预算自适应渲染仍是替换点 | 注入 |
| `ClockPort` | 已落地 | `core/clock.js` | 可回放时钟仍是替换点 | 依赖注入 |
| `PolicyPort` | 已落地 | `hygiene/quota.js` + `decay.js` | 按 kind 的 TTL、token 预算仍是替换点 | 注入 |
| `LlmPort` | **v1.0 待落地** | —（规划见 `docs/plans/v1.0.0-refactor.md` §2.1） | LLM 接管总结写入 / 可选裁决 / checkpoint 主题句；默认 glm-5.3-flash，派生数据独立 sidecar | — |

**判定标准**：如果某个改动需要在 `api/service.js` 或 `hygiene/` 里写 `if (impl === 'sqlite')`，那它设计错了——应该是适配器 + 注入。

## 3. 版本策略

- 目录：`versions/vX.Y/`，**每个版本自包含**（自己的 src/tests/eval/CHANGELOG/ACCEPTANCE）。跨版本只共享 `docs/`、`eval/cases/` 的**思想**，不共享代码路径。
- **升降级规则（硬约定）**：**`X.Y` 换目录，`X.Y.Z` 在同一目录内递增**。即 `0.2.0 → 0.2.7` 全在 `versions/v0.2/`；
  开 `v0.3` 才建 `versions/v0.3/`。老大版本目录**冻结**（只读 + `FROZEN.md`），不再接受改动、不再随 CI 跑。
- `versions/CURRENT` 是唯一「当前版本」指针（内容形如 `v0.2`）。CI、门禁、文档里的路径都从它推出来，
  禁止在脚本里硬编码版本目录名——否则下次换目录又要改一圈。
- **真实走法举例（v0.1 → v0.6，截至 2026-11-14）**：
  - `v0.1`：`0.1.0 → 0.1.5` 六个 patch，全程同目录递增；
  - 新能力成批 → `v0.2`：`0.2.0`（只读 Web UI）→ `0.2.1`（sqlite-index + curate auto）；
  - 分层视图与混合检索 → `v0.3`：`0.3.0 → 0.3.4`；
  - 语义道 / 捕获 / 脱敏 → `v0.4`：`0.4.0`；UI 分库粘性 → `v0.5`：`0.5.0`（发布后目录冻结）；
  - 会话临时库与写侧契约 → `v0.6`：`0.6.0 → 0.6.2`，`versions/CURRENT` 内容为 `v0.6`。
- 门禁按版本收敛：Q2 源码规模 / Q3 测试清单 / Q5 契约覆盖 / Q9 Web 边界 / S9 部署面 **只审 CURRENT**；
  Q1 零依赖、Q6 文档链接、Q8 编码卫生对全仓生效；Q7 额外校验 CURRENT 有效且每个版本目录自包含。
- 兼容：`MEMO_HOME` 布局与 `MemoryRecord.version` 是**跨版本承诺**。schema 变更必须：新字段可缺省 + 写在 `docs/adr-*.md` + 提供 `memo migrate` 路径。
- 真相层永不迁移破坏性：新版本必须能读旧版 `items/*.jsonl`（只加字段，不改语义）。
- `eval/results/` 每次跑留下 `vX.Y-<时间戳>.json`，版本间对比写进 `versions/vX.Y/docs/COMPARE.md`。

## 4. 迭代一个版本的标准流程

```
1. 写 ADR（docs/adr-NNN-*.md）：问题 / 备选 / 决定 / 代价 / 回滚
2. 改契约文档（docs/02-...），如果涉及接口
3. 写失败测试（tests/），red
4. 实现，green
5. 跑 eval，与上一版对比（必须给出数字，不接受「感觉更好」）
6. 多 agent 审核（架构 / 对抗），把结论写进 reviews/
7. 打 tag，更新 README 版本索引与 CHANGELOG
```

## 5. v0.1 → v0.2 的候选路线（按价值排序）

0. **`metrics` 修复 + 只读查询方法**（v0.2.0 已完成，**前置**）：metrics 按 scope 分文件（现 `metrics/<date>.json` 多分库同日互相覆盖，趋势图会缺数据）；新增 `service.events()` / `service.exportRecords()`。见 [`08-web-ui.md`](08-web-ui.md) §6。
1. **只读 Web UI（记忆观察台）** —— 用户 2026-11-02 提出，v0.2 核心交付：三页分别回答「今天变了什么」「这些记忆是什么关系」「库在变健康还是变脏」。零依赖零构建、只读、只绑回环。规格见 [`08-web-ui.md`](08-web-ui.md)，线框图见 [`ui-mockup.html`](ui-mockup.html)。
2. **`sqlite-index.js`**：FTS5 + WAL，5k 条以上检索延迟收益明显；同时验证 IndexPort 是否真的可换。——**已完成（v0.2.1-A，契约要点见 [`docs/02` 附录 A](02-data-model-and-contract.md)）**：`config/policy.json` 的 `index.backend=memory|sqlite` 切换，回滚 = 改回 `memory` 一条配置。
3. **curate 裁决 prompt + Agent 调用器**：把「导出批次 → Agent 判断 → 回写」跑成一条命令（`memo curate auto`）；Web UI 的「待裁决」区就是它的观察面。——**已完成（v0.2.1-B，契约要点见 [`docs/02` 附录 B](02-data-model-and-contract.md)）**：落地为 `memo curate prompt`（生成任务包）→ Agent 回填 `decisions` → `memo curate apply --file` → `memo curate status` 三步；单命令 `auto`（含自动 LLM 裁决）仍留给 `JudgePort`。
4. **夜间整合的收口** ——**已在 v0.1 落地**：crontab 已装（夜间跑 `memo nightly`），输出 metrics 快照；实现见 `versions/v0.2/src/cli/nightly.js`。
5. **投毒防线** ——**已在 v0.1 落地**：写入打 `suspicious` 标签 + 读路径默认遮蔽 + brief 逐行复检；实现见 `versions/v0.2/src/hygiene/suspicious.js`。
6. **service 拆分** ——**v0.2.1 已做（进行中，[#32](https://github.com/Old-Friends-Gathering/sedimem/issues/32)）**：`api/service.js` 拆为 lifecycle / write-path / search-path / maintenance 四个承接模块，主文件回落到 ≤320 行，对外类与签名不变。
7. **hybrid 检索**（BM25+dense）：**等 #36 的检索健康指标**（`noHitRate` / `staleHitRate`）给出实测痛点后再决定，v0.2.1 只先把指标立起来。
8. **EmbeddingIndex**（`EmbedderPort` 第二实现）：与「先证明治理机制、再加检索能力」的排序一致，词法检索被证明不够时才启动。

> **扩展点验证结论（v0.2.1 实测）**：IndexPort 真的只在一处注入就能换后端——`src/api/service.js` 只改了
> import（`versions/v0.2/src/api/service.js:10`）+ 一行 `createIndex({...})` 调用
> （`versions/v0.2/src/api/service.js:53`），无任何 `if (impl === 'sqlite')` 分支散落；
> 两种后端同一批查询结果对齐见 [`docs/02` 附录 A](02-data-model-and-contract.md) 与 `versions/v1.1/tests/injection/i16-index-parity.test.js`。

> 为什么 Web UI 排第一：不是因为"好看"，而是**没有观察面时卫生指标只是数字**——`dup_ratio` 涨了却看不出是哪几条在重复。它把 v0.1 已有的数据（events / metrics / dedupeScan）变成可诊断的界面；其它候选的收益判断都依赖它。

### 5.1 v0.6 候选落地情况（2026-11-13，v0.6.0 已发布）

[`plans/v0.6-memory-quality-and-session.md`](plans/v0.6-memory-quality-and-session.md) 的候选全部落地，见 [`../versions/v1.1/docs/DELTA.md`](../versions/v1.1/docs/DELTA.md)：

- ✅ **方向 A 写侧粒度契约**（300 字软线 / 4000 字硬线报错 / title 先警告后强制）——`versions/v1.1/src/core/record.js`、`config/policy.json` 的 `write` 段；
- ✅ **方向 B 会话临时记忆库**（`session:<id>` scope、五命令五工具、8 段 checkpoint、close 只晋升 decision/gotcha）——`versions/v1.1/src/session/*`；
- ✅ **方向 C UI 分库粘性**（`resolveScope` 四级回落 + `hrefFor` 统一出口 + localStorage 粘性）——`versions/v1.1/ui/scope.js`；
- ✅ **数学三条**（`calibrateDecay` 只报告不自动改 policy / 滞回双阈值 / brief·checkpoint 字符数进 metrics）——`versions/v1.1/src/cli/nightly.js`；
- ✅ **门禁**：Q11 写侧粒度与会话库契约；eval I37–I40；`versions/v0.5` 冻结在 0.5.0。

未做（有意留到 v0.6.1+）：titleEnforce 默认开启、CLAUDE.md 导入器、会话库 UI 投影、语义道进 nightly——入口见 `versions/v1.1/docs/DELTA.md` 末节。

## 6. 「记忆库本身也要能优化」

这是与「代码可优化」不同的第二件事：

- 记忆库的健康度用**指标**驱动（`dup_ratio` / `conflict_rate` / `stale_hit_rate` / `unit_cost`），每次整合写一份快照到 `metrics/<date>.json`，形成时间序列。优化决策看趋势，不看单点。
- 库的**结构**也可演化：`kind` 取值、`HALF_LIFE_MS`、`kindWeight`、批大小、配额都是数据（配置），不是代码常量。v0.1 用 `versions/v0.2/config/policy.json` 承载，允许 A/B。
- 任何自动整合都必须**可回放**：`events.jsonl` 记录每个决定，`memo replay --since` 能重建当时的视图，用于回答「为什么这条被忘了」。
