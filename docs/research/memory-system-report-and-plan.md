# 本地跨会话「自我迭代」记忆系统：调研报告与落地计划

> 版本 2026-11-02 ｜ 目标宿主：DeepSeek Harness（DSH）+ OpenAI Codex CLI + Claude Code 共用同一份记忆
> 证据文件（同目录）：`agent-memory-projects-survey-2026-11.md`（8 个开源项目实测）、`memory-ecosystem-2026.md`（编码 Agent 记忆生态）、`ai-memory-hygiene-survey.md`（记忆卫生机制与论文）
> 口径：star/license/push 均于 2026-11-02 经 GitHub REST API 实测；论文编号均核验过 abs 页；凡未核实的地方逐处标「未核实」或 ⚠️，不填充推测。

---

## 0. 结论先行

**不要选一个现成产品，而是自建一个「薄」的治理层。** 具体建议：

1. **自建一个约 1.5k 行的 MCP memory server（代号 `memo`）**，真相层是 append-only JSONL（人可读、可 git、可 diff、可重建），索引层是 SQLite FTS5（可选向量），治理逻辑是「四条卫生路径 + Agent 裁决回路」。
2. **跨三端只走一条缝**：MCP。DSH 用自带的 `@deepseek-ai/dsh-mcp-client`，Codex 用 `~/.codex/config.toml` 的 `[mcp_servers]`，Claude Code 用 `claude mcp add` —— 三者工具命名规则本身就是同一套 `mcp__<server>__<tool>`。
3. **指令层只维护一份 `AGENTS.md`**：DSH 与 Codex 都原生读它，Claude Code 读 `CLAUDE.md`（可 `@AGENTS.md` 导入），三个 home 目录用软链指向同一文件。
4. **LLM 只做裁决，不做扫描**：写路径 0 次 LLM；只有「相似度超阈值的候选对」才导出成批次，由**你当前正在用的那个 Agent**（DSH/Codex/Claude 谁在跑就谁判）裁决后回写。这样既不用额外 API key，又天然可审计。
5. **P0 半天可用，P3 三天补齐治理**。不需要 Neo4j、不需要向量库、不需要联网。

为什么不能直接装一个：调研的 12 个候选里，**没有一个同时满足**「本地零 key + 三端共享 + 去重 + 冲突失效 + 自治整合」。生态整体在优化 *检索*，只有极少数在优化 *治理*；而 BEAM（ICLR 2026，arXiv:2510.27246）的结论是：所有记忆系统最弱的恰恰是**矛盾消解**，其次时序推理与知识更新——正是你最痛的那三项。

---

## 1. 把需求变成可打分的判据

| # | 判据（你的诉求 → 硬指标） | 验收方式 |
|---|---|---|
| C1 | **本地离线**：无 API key、无外部服务、断网可用 | 拔网线后写入 + 跨会话召回成功 |
| C2 | **三端同一份记忆**：DSH / Codex / Claude Code 写入即互相可见 | A 端写 → 新开 B 端会话 → 召回并正确使用 |
| C3 | **重复不增长**：同一事实换 5 种措辞写 5 次 | 存储条数不增长，召回不重复，token 不膨胀 |
| C4 | **冲突可失效**：事实变更后旧值不再命中，但仍能 as-of 回查 | 冲突注入测试 + `as_of` 查询 |
| C5 | **自治**：无需人工整理，库自己变干净 | 夜间自动整合 + 裁决队列清空 + 三项指标不恶化 |
| C6 | **轻**：≤1 个进程、无 Docker、无图库 | 装机 5 分钟内完成，常驻内存 <100MB |

---

## 2. 现状扫描（三份证据的汇总）

### 2.1 编码 Agent 的原生记忆：都只解决「指令 + 文本」，没有治理

| 产品 | 机制 | 能否跨 Agent | 治理能力 |
|---|---|---|---|
| **Claude Code** | `CLAUDE.md` 四层 + `.claude/rules/` + auto memory（`~/.claude/projects/<project>/memory/MEMORY.md`，每次只载前 200 行/25KB，跨 worktree） | 私有 store，不通过 MCP 暴露 | 无去重、无冲突消解、无过期淘汰 |
| **Codex CLI** | `AGENTS.md`（`~/.codex/AGENTS.md` + 仓库级，就近优先）；官方 Memories 默认**关闭**（`[features] memories=true`，`~/.codex/memories/`，后台异步整理 + redact） | 私有 store | 有 consolidation，但无冲突裁决、不可跨端 |
| **DSH** | 官方 `packages/` 下**没有** memory 包；接缝是 `ctx.systemPrompt.section()` + 工具。指令层由 `dsh-agent-instructions` 读 `~/.dsh/AGENTS.md`、`~/.agents/AGENTS.md` 与项目链 `AGENTS.md`/`CLAUDE.md`（默认 `instructionFileCandidates: ['AGENTS.md','CLAUDE.md']`，字节相同的内容自动折叠） | 官方无，社区 639 个 memory 插件 | 分化：guardian/steward 有 provenance 与冲突复核，dsh-memory 这类只有 INSERT/DELETE |
| **Cline Memory Bank** | 6 个 markdown 约定文件，纯人工维护 | 天然可读 | 无检索、无治理 |

**结论**：文本约定层（AGENTS.md/CLAUDE.md）解决的是「指令可移植」，不是「记忆可治理」。它能当**入口**，不能当**存储**。

### 2.2 8 个「记忆系统」项目实测（2026-11-02）

| 项目 | Star | MCP 可用性 | 冲突失效 | 本地离线 | 关键缺陷 |
|---|---:|---|---|---|---|
| mem0 | 68,255 | 云端要 key；本地插件仅 1 个只读 `search_memories` | **无**（v3 改 ADD-only，"Memories accumulate; nothing is overwritten"） | 部分（需 LLM+embedding） | OSS 显式不支持 decay/timestamp；图记忆已移除；898 open issues，`duplicate` 175 条 |
| Letta / letta-code | 25,318 / 3,758 | 仅云后端 `api.letta.com/mcp` | 部分（block 覆写） | 部分（默认云） | Python 服务端已进 archive；本地后端=文件+git（MemFS，`~/.letta`） |
| Graphiti (+Zep) | 32,422 | 参考实现、**无鉴权**、README 自述 not production | **有（bi-temporal invalidate）** | 可，但需图库 + 结构化输出 LLM | 重（Neo4j/FalkorDB）；每 episode ≥3 次 LLM |
| cognee | 32,993 | 有（`cognee-mcp` :8001） | 无显式 | 可（GLiNER 本地抽取，官方说是 demo 级精度） | 1,075 open issues |
| MemOS | 12,225 | 内置 stdio/http | 未查到 | 插件可、服务端不可 | 服务端需 Neo4j+Qdrant |
| memU | 14,593 | **无官方 MCP** | 无（服务不做 LLM 判断） | 部分 | topics 里的 mcp 是虚标 |
| Supermemory | 31,497 (MIT) | 托管 + 开源自托管 | **有（矛盾消解 + 自动遗忘）** | 基本可（`npx supermemory local`，内置 bge-base） | 自动遗忘缺审计；云优先 |
| Memobase | 2,946 | 仅模板 | 部分（覆盖无历史） | 否（PG+Redis） | **停滞**（2026-01-11 后无 push），官方指向 Acontext |

编码 Agent 侧的三个「看起来最像」的候选，也各有硬伤：

- **claude-mem**（109,548 ⭐，Apache-2.0）：三层渐进披露很聪明，但**无去重/冲突/过期**；且成本有硬证据——issue #3848「比真实编码贵约 64%」、#2643「静默烧 649M tokens」、#3497「历史不裁剪 ~10x」、#1089/#803 孤儿进程 2.3G/13.6G、#1185 chroma 500–700% CPU、#4068 配额死锁、#4782 monorepo 隔离缺陷。默认路径还是在线登录优先。
- **basic-memory**（4,445 ⭐，**AGPL-3.0**）：Markdown 为真相 + SQLite 索引 + FastEmbed ONNX 混合检索，**架构方向与我们最接近**；但治理只有 `schema infer/validate` 与 `bm doctor`，无自动去重/冲突/过期；AGPL 也限制二次分发。
- **mcp-memory-service**（2,058 ⭐）：**自我维护最强**——consolidation、beliefs+置信度、矛盾检测（superseded）、controlled forgetting、entity extraction、quality scoring。但 issue #530 是致命的：hooks 静默失败导致 218+ session 零记忆；且 Python + ONNX 模型下载 + 非 bi-temporal 存储。

### 2.3 DSH 生态：639 个插件，但治理只是少数派的自觉

awesome 清单 memory 分类收录 639 个插件（flowix ⭐493、movo ⭐475、seriousz158/dsh-memory ⭐180、Aik358/dsh-auto-memory ⭐172、dsh-noema ⭐129，fork 噪声严重，`dsh-noema` 重复约 20 次）。

已单独评估过的 **dsh-memory v0.1.0**（MIT，26KB/5 文件，源自 pi-mentis 重写）：
- 优点：零依赖离线、无 key、`memory:recall` prompt section **自动注入**（pinned + 最近 N 条，promptRecentCount=10、promptMaxChars=2000）、FTS5 token 字面引号化防语法错、fail-loud 配置、Cordis effect 干净卸载。
- 硬伤：`lib/index.js` 420 行**只有 INSERT 与 DELETE，没有 UPDATE/supersede/去重/冲突**；词法检索非语义（"部署"搜不到"上线"）；单 db 全 profile 共享无隔离；明文落盘；peer `^0.1.0-rc.6` 易断。

它的价值是**验证了 DSH 侧的注入缝隙怎么用**，不是「选它」。

### 2.4 标准层：可移植记忆还没落地

- `AGENTS.md` 已成事实标准（Linux Foundation 下 Agentic AI Foundation 托管，60k+ 项目）——但只规范「指令」，不规范「记忆数据」。
- `draft-saihm-memory-protocol` 的 ISE 流程 2026-07-29 结束、正转 IETF；W3C CG `ai-agent-memory-interop` charter v1.0 于 2026-06-19 通过。
- **2026 年没有任何产品原生支持可移植记忆**。所以「三端共用」今天只能靠 **一个自建 MCP server + 一份共享文件**，这正是 MCP 官方参考实现连跨进程文件锁（`.lock`，15s 续锁/30s 破锁/60s 超时，不支持 NFS）都要手写的原因。

---

## 3. 五个决定性洞察

1. **生态的最大空洞就是你的痛点。** BEAM 的评测结论：所有系统最弱的是矛盾消解；Mem0 v3 直接放弃（ADD-only），Memobase 停滞，只有 Graphiti 做对 bi-temporal、Supermemory 同时做「矛盾 + 遗忘」。**去重与冲突不是「记忆系统的功能之一」，而是它唯一值得自建的部分。**
2. **「记忆」被做成了检索问题，其实是数据治理问题。** 12 个候选里 10 个在比召回率（LoCoMo/LongMemEval），只有 2 个在管「库有多脏」。而用户感受到的痛（冗余/重复/冲突）是治理指标，benchmark 里根本测不到。
3. **MCP 是唯一成熟的跨三端接缝**，且 DSH 已内置客户端。工具命名 `mcp__<server>__<tool>` 在 DSH/Claude Code/Codex 三边一致，会话历史与权限规则可跨重启存活。
4. **过时的正解是「失效」而不是删除。** bi-temporal 四时间戳（`valid_at/invalid_at` + `created_at/expired_at`），旧事实可 as-of 回查。但 Graphiti 自报 knowledge-update 反而 −3.36%——**有失效机制 ≠ 检索会正确用它**，读路径必须显式过滤 `valid_to`。
5. **过度加工本身就是腐化。** FlexA-Mem（arXiv:2610.33274）：历史只写一次到不可变存储，每次按预算用**固定规则（不调 LLM）**渲染「时间线 + 细节」，紧预算下追平甚至超过 LLM 加工过的记忆。→ 我们必须有「确定性渲染」这一层，否则每次整理都在引入漂移。

---

## 4. 选型打分：为什么是「自建薄层」

评分：✗=不满足，△=部分，✓=满足。

| 方案 | C1 离线零key | C2 三端共享 | C3 去重 | C4 冲突失效 | C5 自治 | C6 轻 | 合计 |
|---|:--:|:--:|:--:|:--:|:--:|:--:|---|
| mem0 | △ | △ | △ | ✗ | ✗ | △ | 2.5 |
| Letta / letta-code | △ | △ | ✗ | △ | △ | ✓ | 3.5 |
| Graphiti | ✓ | △ | △ | **✓** | △ | ✗ | 4 |
| cognee | ✓ | ✓ | △ | ✗ | ✗ | ✗ | 3.5 |
| MemOS | △ | ✓ | ✓ | ✗ | △ | ✗ | 4 |
| Supermemory | ✓ | ✓ | △ | ✓ | ✓ | △ | **5** |
| mcp-memory-service | ✓ | ✓ | ✓ | ✓ | ✓ | △ | **5** |
| claude-mem | △ | ✓ | ✗ | ✗ | △ | △ | 3 |
| basic-memory | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | 3 |
| dsh-memory 0.1.0 | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | 2 |
| **自建 `memo`（本方案）** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **6** |

两个 5 分候选为什么仍不采用：

- **Supermemory**：唯一「矛盾消解 + 自动遗忘」双全，但自动遗忘**没有审计与回滚**（你不知道它忘了什么、为什么忘），且核心能力在云侧；本地模式仍是黑盒。对「记忆」这种资产，不可审计的删除等于不可接受的风险。
- **mcp-memory-service**：功能最接近，但 #530 的 hook 静默失败说明它的写入可靠性工程不到位（218+ session 零记忆）；且它的矛盾检测**不是 bi-temporal**——superseded 只改状态，丢时间轴，没法 as-of。

> 取舍的本质：**用检索能力换治理能力**。P0 的检索只靠 FTS5（BM25）+ 实体匹配就够用——你的记忆量级是「个人跨项目几千条」，不是企业知识库。等治理闭合再考虑 embedding（P4 可选）。

---

## 5. 选定架构

### 5.1 分层

```
┌─ L3 入口层 ────────────────────────────────────────────────┐
│  MCP server `memo-mcp` (stdio)                             │
│  tools: memory_write / memory_search / memory_brief /      │
│         memory_get / memory_supersede / memory_forget /     │
│         memory_curate / memory_stats                        │
│  指令层: 一份 AGENTS.md（DSH+Codex 原生读，Claude 走 CLAUDE.md）│
├─ L2 索引层（派生，可删可重建）──────────────────────────────┤
│  ~/.memo/index.db : items(当前视图) + FTS5 + entities 别名表 │
│  重建: memo reindex（永远不会在 load 路径里做 mutation）      │
├─ L1 真相层（append-only，人可读）───────────────────────────┤
│  ~/.memo/items/<scope>.jsonl   不可变记忆事件                │
│  ~/.memo/events.jsonl          操作审计（write/supersede/…）  │
│  ~/.memo/entities.json         canonical_id 别名表           │
│  ~/.memo/queue/curate-*.json   待裁决批次                    │
│  ~/.memo/brief/<scope>.md      确定性渲染的记忆简报           │
└────────────────────────────────────────────────────────────┘
```

**为什么真相层是 JSONL 而不是 SQLite/向量库**：① append-only 天然抗「重建复活」与「load 路径 mutation」两类反模式；② 可 git、可 diff、可人工 review —— 记忆是需要审计的资产；③ 换实现不丢数据，索引坏了 `reindex` 即可；④ FlexA-Mem 的证据支持「写一次 + 确定性渲染」。SQLite 只做物化视图与索引，随时可弃。

### 5.2 记录模型

```json
{
  "id": "mem_01JBXYZ...",
  "scope": "repo:<项目名>",
  "kind": "fact | pref | decision | gotcha | state",
  "subject": "monitor.server",
  "predicate": "port",
  "value": "8642",
  "text": "本地监控台后端固定跑在 8642 端口",
  "valid_from": "2026-11-02T10:00:00Z",
  "valid_to": null,
  "created_at": "2026-11-02T10:00:00Z",
  "expired_at": null,
  "status": "active | superseded | disputed | tombstoned",
  "supersedes": "mem_01JBXW...",
  "confidence": 0.9,
  "source": { "agent": "dsh", "session": "s_abc", "quote": "用户原话或代码位置" },
  "content_hash": "sha256:…",
  "hits": 0,
  "privacy": "private | shared",
  "tags": []
}
```

四条不变式：
1. `id` 是 ULID，**永不**用列表下标；
2. 任何「改变过去」的操作只能**追加**一条新记录（supersede 时旧记录只追加一条 `valid_to`/`status` 的修正事件，物理行不改写）；
3. 删除 = `status=tombstoned` + 读路径过滤 + **延迟**物理清理；
4. 方向性函数（衰减、置信度、排序权重）必须有单调性单测。

### 5.3 四条卫生路径（这就是「自我迭代」）

```
写路径（同步 <50ms，0 次 LLM）
  write → 归一化 → content_hash
        → ① hash 命中 → NOOP（hits++，返回既有 id）
        → ② (scope,subject,predicate) 命中且值相同 → NOOP（合并变体文本）
        → ③ 命中且值不同 → 确定性裁决：
             时间/数字可解析 → 新值更新：追加 supersede（旧 valid_to = 新 valid_from）
             不可解析 或 来源权威性不明 → 双方标 disputed，入 queue
        → 追加记录 + outbox（异步重建索引）

近线裁决（秒级，LLM 可选）
  memo_curate action=export → 生成 ≤20 对的批次（含双方原文 + 来源 + 时间）
  → 当前正在用的 Agent（DSH/Codex/Claude 任一）读批次、给 decision
  → memo_curate action=apply decisions.json → 写 supersede / merge / keep-both
  预算：每批 ~2–4k token，夜间一次；不用额外 key。

离线整合（夜间 / 空闲，默认全确定性）
  · 合并精确重复（hash 簇）
  · TTL / 类型化半衰期标记（身份/偏好月级，临时状态小时级）→ 只标 expired，不删
  · 配额执行：按 (kind 权重 × hits × 新近度) 淘汰最低价值，写墓碑
  · 分层摘要（事件 → 主题 → 画像）只在超阈值时做，且保留关键槽位（数字/否定/截止时间/责任主体）
  · 重建 brief/<scope>.md（≤80 行，确定性渲染，无 LLM）
  · 输出 metrics，异常进 queue

检索期过滤（读路径 <200ms）
  search → FTS5(BM25) [+ 实体匹配] → 过滤 status=active AND valid_to IS NULL
        → 打分 = bm25 × kind_weight × recency_decay × confidence
        → 返回时带 valid_from / source / disputed 标记
  as_of 查询：显式传 valid_to > as_of，取历史值（审计与「为什么当时那样做」）
```

**关键分工**：机器只做**确定性**的事（hash、实体键、时间比较、TTL、配额）；**判断**交给 Agent，且是批量、离线、可审计的。这一条把「自我迭代」从「让 LLM 乱整理」变成「让 LLM 在受限候选集上签字」。

### 5.4 跨三端接入（全部已验证的机制）

**① 存储同一份**：三端都通过 MCP 连同一个 `memo-mcp`，`MEMO_HOME` 指向同一目录。scope 由 git remote + 相对路径哈希自动推导，非 git 目录退化到目录名，因此「同一个项目在三个 Agent 里看到同一份记忆」。

**② DSH**：`~/.dsh/profiles/<profile>/cordis.patch.yml`（或 `~/.dsh/cordis.patch.yml` 全 profile 生效）：

```yaml
- insert:
    - id: memory-memo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memo
        transport: stdio
        command: memo-mcp
        args: []
        env:
          MEMO_HOME: ~/.memo
        cwd: !!js process.cwd()
```

（`serverName` 必填；工具名会变成 `mcp__memo__memory_search` 等。stdio 会 scrub 含 KEY/PASSWORD/SECRET/TOKEN 及 `DSH_*` 的环境变量，`MEMO_HOME` 不受影响。）

**③ Codex**：`~/.codex/config.toml`

```toml
[mcp_servers.memo]
command = "memo-mcp"
args = []
[mcp_servers.memo.env]
MEMO_HOME = "~/.memo"
```

**④ Claude Code**：`claude mcp add --scope user memo -- memo-mcp`（等价于在 `~/.claude.json` 的 `mcpServers` 里加一条 stdio 条目）。

**⑤ 指令层：一份文件，三个软链**

| 客户端 | 用户级 | 项目级 |
|---|---|---|
| DSH | `~/.dsh/AGENTS.md`、`~/.agents/AGENTS.md` | 项目 `AGENTS.md`、`CLAUDE.md`（字节相同自动折叠） |
| Codex | `~/.codex/AGENTS.md` | 项目 `AGENTS.md`（就近优先） |
| Claude Code | `~/.claude/CLAUDE.md` | 项目 `CLAUDE.md` |

推荐做法：内容写一次在 `~/.agents/AGENTS.md`，其余三个做软链；项目级只在仓库根放一个 `AGENTS.md`（Claude Code 2026 已原生支持 AGENTS.md，若不支持则 `CLAUDE.md` 写一行 `@AGENTS.md`）。

统一的 5 行指令（不要写成"请记住一切"，那必然导致污染）：

```markdown
## 记忆（memo）
- 会话开始：调用 memory_brief 取当前项目简报（≤80 行）；需要细节再 memory_search。
- 用户明确说"记住/以后都这样/不要再…"时，立即 memory_write（kind=pref/decision，附 quote）。
- 事实变更时用 memory_supersede，不要写一条与旧值并存的记录。
- 不确定是否重复时先 memory_search(subject=...) ；查到相同就 NOOP。
- 不要把猜测写进记忆；不要写入密钥、token、个人隐私。
```

**⑥ 验证脚本（MCP 官方同款三步，必做）**：

1. 会话 A：`记住我的验证饮料是 lapsang-<随机后缀>` → 确认调用 `mcp__memo__memory_write` 且返回成功；
2. 同 Host 新开会话 B（不复制 A 对话）：`我的验证饮料是什么？查记忆` → 确认调 `memory_search` 并答对；
3. 会话 B：`用这个偏好给会议推荐一杯饮料` → 确认答案真的用了召回值。

---

## 6. 落地计划

总计 **3 个工作日**（P0 半天即可产生可用价值）。

| 阶段 | 工时 | 交付 | 验收（硬门禁） |
|---|---|---|---|
| **P0 可用闭环** | 0.5d | `memo` CLI + MCP server：`write/search/brief/get/forget/stats`；JSONL 真相层 + SQLite 索引 + hash 去重 + 每项目 scope + 三端配置 + 指令层软链 | C1 + C2 通过：三端各写一条，另两端都能召回；同一条重复写 5 次条数不涨 |
| **P1 冲突治理** | 1d | 实体键 `(scope,subject,predicate)`、`supersede`、bi-temporal 字段、`disputed` 队列、读路径过滤、`as_of` 查询、`reindex` | C3 + C4 通过：注入式回归前 4 项全绿（重复/冲突/过时/删除） |
| **P2 自治回路** | 1d | `curate export/apply` 批次协议 + 裁决 prompt 模板 + 夜间自动整合（launchd/cron）+ 审计事件 + 配额与 TTL | C5 通过：连续 3 晚自动跑，裁决队列清空，dup_ratio 单调下降 |
| **P3 观测与门禁** | 0.5d | `memo doctor`、三项卫生指标、注入式回归进 CI、`AGENTS.md` 指令定稿、迁移 `dsh-memory` 旧库 | 指标基线落盘；6 项注入测试全绿 |
| **P4 可选增强** | — | embedding 混合检索（sqlite-vec + 本地 bge/FastEmbed）、分层摘要、跨机 git 同步 | 仅在 P0–P3 指标不达标时启动 |

### P0 实施要点（防坑清单）

- **不要**在 P0 加向量/图：你的量级下 FTS5 + 实体键足够，加向量会把「半天可用」拖成一周。
- **不要**沿用 dsh-memory 的单 db 全 profile 共享：一定要 `scope` 分区，否则 monorepo 与个人项目互相污染（claude-mem #4782 就是这个坑）。
- 旧数据迁移：一次性把 `$DSH_HOME/memory/memory.db` 的 `memories` 表导成 `items/default.jsonl`（`SELECT id,text,tags,pinned,created_at`），随后**停用 dsh-memory**，避免双源。
- 索引重建必须与写路径解耦（outbox/事件），避免「建索引顺手改数据」这类反模式。
- 三端同时写会有并发：JSONL 追加用 `O_APPEND` + `<64KB` 单行原子写，或 `flock`；SQLite 用 WAL。MCP 官方参考实现为跨进程锁花了 15s/30s/60s 三档超时，我们直接复用同一策略即可。

---

## 7. 评测与回归（这一步决定「自我迭代」是不是真的）

**① 注入式回归（进 CI，测机制而不是测模型）** —— 6 项，每项 <1s，无需 LLM：

| 测试 | 注入 | 期望 |
|---|---|---|
| 重复 | 同一事实 5 种措辞写 5 次 | 条数不变；召回不重复；同 id 返回 |
| 冲突 | 先写「截止 3/1」，再写「截止 4/1」 | 旧值 superseded；当前查询只回新值；`as_of=2/1` 能回旧值 |
| 过时 | 写入已被官方否定的旧结论 | 旧结论命中率 → 0；不进入 brief；不污染画像 |
| 删除 | 删除后立即查 + 触发 `reindex` | 读路径立即不可见；重建后仍不可见（防复活） |
| 投毒 | 记忆正文夹带「忽略之前指令…」 | 不当指令执行；不晋级稳定区；有告警 |
| 容量 | 灌到配额上限 | 按价值淘汰（kind×hits×新近度），无静默丢失关键记忆 |

**② 卫生指标（自己建基线，没有现成 benchmark）**：
- `dup_ratio = 1 - unique_facts / stored_items`（hash 聚类粗估 + 人工抽 200 条核对）
- `conflict_rate = disputed_pairs / pairs_with_same_entity_relation`
- `stale_hit_rate = 命中已 supersede 旧事实次数 / 总命中`（读路径必须能识别旧版本才统计得出）
- `unit_cost = 每千条有效记忆的写入+整合+检索总成本`

**③ 能力基准（可选，只做能力上限参照）**：LoCoMo（arXiv:2402.17753）、LongMemEval（arXiv:2410.10813，重点看 knowledge-update 与 abstention 两类）、MemBench（arXiv:2506.21605，唯一把延迟/成本与容量悬崖当一等指标）。注意 judge 模型必须版本化，换 judge 要重跑基线。

---

## 8. 风险与止损

| 风险 | 触发信号 | 处置 |
|---|---|---|
| 判决漂移（Agent 裁决不一致） | 同一批次换 Agent 结论冲突率 >20% | 裁决 prompt 固定 + 双跑比对；只对高影响条目做人工抽检 10% |
| 过度整合（摘要吃细节） | 关键槽位（数字/否定/截止时间）保留率 <90% | 摘要只进候选区，不覆盖原文；原文永不删 |
| 配额误伤 | 淘汰后出现「关键记忆丢失」 | 淘汰只写墓碑；`memo restore <id>` 回滚；关键 kind 不参与淘汰 |
| 索引与真相不一致 | `memo doctor` 报 orphan/missing | 一律以 JSONL 为准重建；禁止反向同步 |
| 变成另一个「黑盒记忆」 | 用户 3 天不用 `memory_brief` | 说明 brief 太长或不准 → 缩到 ≤40 行，只放 pinned + 最近 5 条 |

**明确不做**（这些是本次调研里翻过车的）：破坏性遗忘（MemoryBank 的 `pop` 与 `exp(-t/5*S)` 解析成 `((-t)/5)*S` 导致「越常回忆越快被删」）；在 load/建索引路径里做 mutation；用列表下标当 `memory_id`；只写新向量不删旧向量；让 LLM 现写 Cypher/SQL 查记忆；无 provenance 的写入；无上限 append；把 reflection 结果直接当事实；单次 LLM 打分决定重要性且无校准；只跑 benchmark 不做注入式回归。

---

## 9. 与现有资产的关系

| 资产 | 处置 |
|---|---|
| `dsh-memory` 插件 | 保留其**注入思路**（prompt section）作为 P2 的可选增强（写一个 30 行的 DSH 侧插件，把 `brief/<scope>.md` 塞进 system prompt，省掉一次工具调用）；数据迁移后停用插件本体 |
| 各项目 `CLAUDE.md` / `AGENTS.md` | 不迁移存量规则（那是「指令」不是「记忆」）；只在末尾追加 5 行记忆指令 |
| 本次三份调研 | 作为设计依据长期保留，`ai-memory-hygiene-survey.md` 的第 9 节（19 项机制清单）可直接当 P1/P2 的实施 checklist |

---

## 10. 附录：证据索引

**已核验论文**：MemGPT 2310.08560 ｜ Mem0 2504.19413 ｜ Zep 2501.13956 ｜ Sleep-time Compute 2504.13171 ｜ A-MEM 2502.12110 ｜ MemInsight 2503.21760 ｜ MemoryBank 2305.10250 ｜ Generative Agents 2304.03442 ｜ LoCoMo 2402.17753 ｜ LongMemEval 2410.10813 ｜ MemBench 2506.21605 ｜ Knowledge Conflicts 2403.08319 ｜ FlexA-Mem 2610.33274 ｜ BEAM 2510.27246

**关键数字**：Mem0 LoCoMo J 66.9%（Mem0g 68.4%）vs OpenAI memory 52.9%、Zep 66.0%；p95 1.44s vs full-context 17.12s；token −90%+。Zep DMR 94.8% vs MemGPT 93.4%；LongMemEval 71.2% vs full-context 60.2%；上下文 1.6K vs 115K（72×）；每 episode ≥3 次 LLM。MemInsight LoCoMo Recall@5 26.5 → 60.5。MemBench RetrievalMemory PS 0.692@10k → 0.833@100k。sleep-time compute 单查询成本摊薄约 2.5×。

**未核验 / 注意**：Mem0 v3 的 LoCoMo 92.5、LongMemEval 94.4 为官方平台自述（含 OSS 不具备的私有优化）；MemOS「35.24% token savings」、Memobase「LOCOMO SOTA」、Supermemory「extremely fast」均无第三方复现；Oracle RAG index drift 博客 403，结论未采用；export.arxiv 与 Semantic Scholar 多次 429，二手数字在证据文件中逐处标 ⚠️。
