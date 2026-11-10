# sedimem · Twitter/X 推广文案（EN）

> 用途：英文首发 thread。**1 条 hook + 6 条正文 + 1 条结尾 CTA**，每条 ≤280 字符，每条一张 1200×675 配图。
> 事实基线：数字全部来自本仓库自测（`tools/`、`eval/`），改文案先改这里；不要新增未测过的数字。
> 语气：技术人向、具体、不吹牛。不用 "revolutionary / game-changer / best" 这类词。

---

## 0. 结构与「一条一个点」

| # | 角色 | 只讲一个点 | 配图 |
|---|---|---|---|
| 1 | Hook | 换会话就失忆，于是所有人都在写 AGENTS.md | 会话断裂对比图 |
| 2 | 痛点 | 这不是检索问题，是治理问题 | AGENTS.md 腐烂剖面 |
| 3 | 解法 A | 真相层只追加，`as-of` 能回到任意时点 | JSONL 真身 + as-of 查询 |
| 4 | 解法 B | 三道去重，最后一道由「你正在用的 Agent」当裁判，0 API 成本 | 三段漏斗 |
| 5 | 解法 C | 过时失效不删除；投毒内容默认遮蔽 | 时间轴 + tombstone |
| 6 | 解法 D | 一个 MCP server，三端共用同一份真相层 | 三端汇一流 |
| 7 | 自测 + 边界 | 391 tests / I1–I36 / 9+9 门禁，以及刻意不做什么 | 数字墙 + 边界清单 |
| 8 | CTA | 本地跑，不要云 | 仓库卡片 + 安装命令 |

配图与文案一一对应：第 N 张图只承载第 N 条的那个点，叠字直接取自该条推文的关键句（见每节「叠字」）。

---

## 1. 正文（可直接复制，已按字符数校对）

### Tweet 1 / 8 · Hook

```text
Every new session, your agent starts with amnesia. So you write AGENTS.md. Six months later it's 400 lines, the same fact sits in there 7 times, and two versions contradict each other.

We stopped storing memory as prompt text and started treating it as a database.
```

- 字符数：265 / 280
- 要突出的一个点：**换会话=失忆，于是大家靠 AGENTS.md 硬撑，撑到自相矛盾。**
- 配图 1200×675：「画面」左右分屏。左半是 Session 1 的对话气泡，右侧一个绿色 ✓ 和一行记忆条目；右半 Session 2 同样位置是空的灰框，只有一个问号。「一眼看到」两屏之间一条断裂的虚线，写着 `context reset`。「叠字」左上角小字 `SESSION 1` / `SESSION 2`，底部一行大字 `It forgot. Again.`

### Tweet 2 / 8 · 痛点

```text
This is not a retrieval problem. It's a governance problem.

Nothing dedupes on write. Nothing retires the old version. Nothing stops a pasted instruction from becoming permanent context. A bigger context window just gives the rot more room.
```

- 字符数：241 / 280
- 要突出的一个点：**烂掉的不是检索准确率，是没人管的写入与失效。**
- 配图 1200×675：「画面」一张 `AGENTS.md` 文件截图被放大，正文里同一句事实重复出现 7 次（叠加半透明红框标出），其中两条互相矛盾，用红笔划掉一条。「一眼看到」右侧竖排计数 `×7` 与一个红色 `which one wins?`。「叠字」顶部 `AGENTS.md · 400 lines`，底部 `More context ≠ better memory.`

### Tweet 3 / 8 · 真相层

```text
The truth layer is one append-only JSONL per scope:
$MEMO_HOME/items/<scope>.jsonl

Nothing is overwritten. "Changing the past" = appending a new version. Each entry keeps valid-from / valid-to, so an as-of query answers: what did I actually believe last Tuesday?
```

- 字符数：263 / 280
- 要突出的一个点：**真相层只追加，历史时点可回查；索引和摘要都是可重建的派生物。**
- 配图 1200×675：「画面」深色终端窗口，`items/repo:sedimem.jsonl` 逐行追加，每行是高亮 JSON 片段（`validFrom` / `validTo` / `supersededBy`）。右下角一个 `--as-of` 查询返回两行不同版本。「一眼看到」文件顶部标签 `append-only`，右侧派生层用小字标 `index · brief · views — rebuildable`。「叠字」底部 `Nothing is overwritten.`

### Tweet 4 / 8 · Agent 当裁判

```text
Dedup in three stages, and only the first has to be perfect:

1. write gate — hash/slot equality, zero false kills
2. candidate scan — containment + Chinese bigram Dice
3. the agent you're already running judges the pairs: 0 extra API cost, works offline
```

- 字符数：254 / 280
- 要突出的一个点：**去重的语义判断复用当前会话的 Agent，不额外花钱。**
- 配图 1200×675：「画面」横向三段漏斗。第一段窄口标 `write gate`，旁注 `0 false kills`；第二段两路并行标 `containment` 与 `bigram Dice`；第三段落在一个终端光标上，标 `agent as judge`。「一眼看到」漏斗右侧一枚绿色价签 `API cost: 0`。「叠字」底部 `Cheap enough to run forever.`

### Tweet 5 / 8 · 失效而非删除

```text
Stale is not deleted.

Superseded facts get a validTo and leave the context. Deletion is a tombstone plus a grace period, with exactly one physical-cleanup entry point.

Same read path withholds instruction-shaped text by default. 10 poisoning variants, 0 leaked.
```

- 字符数：263 / 280
- 要突出的一个点：**过时=失效不是删除，删除=墓碑+宽限期；投毒内容读路径默认遮蔽。**
- 配图 1200×675：「画面」一条水平时间轴，三个节点：`active` → `superseded (validTo)` → `tombstoned`，最后一段是虚线，标 `grace period`。轴下方一行被打了 `[suspicious withheld]` 遮条的文本。「一眼看到」时间轴右上角 `as-of still works`。「叠字」底部 `Invalidate, don't erase.`

### Tweet 6 / 8 · 三端共用

```text
One MCP server, three clients: DSH, Codex CLI, Claude Code. Same 10 memory_* tools, same names, same on-disk truth layer. Switch clients mid-project and nothing is lost.

Optional per-step injection is capped at 1200 chars and off by default.
```

- 字符数：242 / 280
- 要突出的一个点：**三端读同一份真相层，换客户端不失忆。**
- 配图 1200×675：「画面」左侧三个终端窗口并排，标题分别是 `DSH`、`Codex CLI`、`Claude Code`；三条箭头汇入右侧一个圆柱体，标注 `~/.memo`。「一眼看到」圆柱体上写 `items/<scope>.jsonl`，下方一行 `10 × memory_*`。「叠字」底部 `One truth layer. Three clients.`

### Tweet 7 / 8 · 自测数字 + 诚实边界

```text
Measured, not promised: 391 tests green, 36 injection eval cases (I1–I36), 9 quality gates + 9 security gates, ~93% line coverage.

Boundaries: no cloud sync, no team sharing, no auto-write. Semi-auto capture waits for a human to accept.
```

- 字符数：237 / 280
- 要突出的一个点：**数字是跑出来的；同时明确不做云端同步 / 团队共享 / 自动写入。**
- 配图 1200×675：「画面」上半是四块数字卡：`391 tests`、`I1–I36`、`9 + 9 gates`、`~93% lines`；下半是一条浅色分隔线，下面四行灰色小字，前三个带 `✗`：`cloud sync`、`team sharing`、`auto-write`，最后一个带 `✓`：`human accepts captures`。「一眼看到」数字用等宽字体，边界用细体，视觉上一眼分得清「做了」和「没做」。「叠字」底部 `Numbers first. Then the limits.`

### Tweet 8 / 8 · 结尾 CTA

```text
Runs local. Not cloud.

git clone https://github.com/Old-Friends-Gathering/sedimem
cd sedimem && scripts/install-dsh-plugin.sh

Node >= 22, zero runtime deps, node:sqlite built in. Then open the read-only observer at 127.0.0.1:7788.
```

- 字符数：232 / 280（X 按链接计 23 字符则 207）
- 要突出的一个点：**本地跑，不要云；一条命令装插件，观察台只绑回环。**
- 配图 1200×675：「画面」一张仓库卡片：`Old-Friends-Gathering/sedimem`，MIT，`Node >= 22`，`runtime deps: 0`；卡片下方两行等宽命令高亮。「一眼看到」右侧一个 `127.0.0.1:7788` 的小窗，标 `read-only`。「叠字」底部大字 `Runs local. Not cloud.`

---

## 2. 配图规范（8 张统一）

- 尺寸：**1200×675**（1.78:1），安全边距 80px，导出 PNG。
- 底色：深色 `#11141B`；浅色卡面 `#F5F6F8`。正文色 `#CFD6E4`，强调色只用一个（建议 `#5B9CF5`），红色仅用于「矛盾 / 失败」。
- 字体：代码与数字用等宽（JetBrains Mono / SF Mono），叙述用 Inter；单图叠字 ≤12 词，字号 ≥48px 保证手机端可读。
- 每张图只允许一个视觉焦点；第 7 张允许两段（数字 / 边界），用分隔线切开。
- 可直接复用的真实素材：`docs/shots/today.png`（第 5 张时间轴参考）、`docs/shots/graph.png`（第 6 张汇流示意参考）、`docs/shots/hygiene.png`（第 7 张数字卡参考）、`docs/shots/search.png`（第 3 张检索依据参考）。截图务必裁掉浏览器边框与个人信息。
- 禁止：伪造指标、把未实现的功能画成界面、出现任何内部系统名或内网地址。

---

## 3. 引用转推短评（3 条，单发或引用时用）

**QT-1**

```text
Most "agent memory" is a vector DB with no lifecycle. This one is a JSONL with a lifecycle: append-only truth, validTo instead of deletes, and the agent you already pay for as the dedup judge. No second model bill.
```

- 字符数：214 / 280 · 配图：无（引用原 thread 的 hook 图）

**QT-2**

```text
The design bet I keep coming back to: quality control doesn't need a second model. Reuse the agent that's already in the loop as the judge, and hygiene becomes something you can afford to run every day.
```

- 字符数：202 / 280 · 配图：无（引用原 thread 的第 4 张漏斗图）

**QT-3**

```text
Also honest about the boring parts: no cloud sync, no team sharing, no auto-write. Local-first means local-only, and it says so instead of implying otherwise.
```

- 字符数：158 / 280 · 配图：无（引用原 thread 的第 7 张边界图）

---

## 4. 发布检查清单

- [ ] 8 条全部 ≤280 字符（已校对：265 / 241 / 263 / 254 / 263 / 242 / 237 / 232）
- [ ] 外链只出现在第 8 条（避免前 7 条被降权），第 8 条同时是唯一 CTA
- [ ] 每条配图按上表 1:1 出图，编号与推文编号一致，文件名 `01-hook.png` … `08-cta.png`
- [ ] 数字与仓库一致：391 tests、I1–I36、9 + 9 门禁、~93% lines、1200 字符注入预算
- [ ] 全文无内部域名、无客户名、无未公开路线图
- [ ] 发布后 30 分钟内用 QT-1 自引一条，把 hook 再顶一次
