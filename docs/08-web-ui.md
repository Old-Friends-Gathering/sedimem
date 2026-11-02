# 08 · v0.2 只读 Web UI（记忆观察台）

> 本文件是 v0.2 Web UI 的**设计契约**：页面规格、只读 HTTP 接口、图谱语义、安全边界、门禁增项、分阶段交付。
> 实现与本文件不一致时，以本文件为准；要改先改本文件并提 issue。
> 线框图见 `docs/ui-mockup.html`（自包含静态页，无需启动服务即可打开）。

---

## 1. 要回答的三个问题

用户原话（2026-11-02）：想在浏览器里看到 ——「记忆图谱可视化」「每天记忆了什么」「有什么冗余或者清除了重复的什么」。

翻译成三个页面（一页一个主问题，不做大杂烩）：

| 页面 | 回答的问题 | 数据源 |
|---|---|---|
| **今日**（Today） | 今天/某一天，库里的**变化**是什么？新增了什么、被谁取代、删了什么、合并了什么 | `events.jsonl` + 记录 |
| **图谱**（Graph） | 这些记忆之间**是什么关系**？同一实体是什么样、版本链怎么长、谁和谁疑似重复 | `items/<scope>.jsonl` + `dedupeScan` |
| **卫生**（Hygiene） | 库在**变健康还是变脏**？待裁决多少、合并了多少、冗余率/冲突率走势 | `metrics/` + `dedupeScan` + `doctor` |

设计顺序原则：**先「今天变了什么」，再「长什么样」，最后「健康度」**。因为前者是日常高频，后者是每周一次。

## 2. 硬约束（不可协商）

1. **零运行时依赖、零构建**：纯静态 HTML/CSS/JS，无 npm 包、无 CDN、无打包步骤。与 Q1「零依赖」一脉相承 —— 一个记忆工具不该为了看图表引入 200MB `node_modules`。
2. **只读**：v0.2 的任何页面都**不提供写操作**。写入永远只有两个入口（CLI、MCP），否则「真相层只追加」的因果链会出现第三个写入者，审计与回放全部失效。
3. **只绑回环**：`127.0.0.1`，不监听 `0.0.0.0`；不做账号体系（本机单用户）。需要给局域网/手机看时，另行讨论（见 §11）。
4. **不越过读路径遮罩**：`suspicious` 记录在 API 和 UI 里默认都是 `[suspicious withheld]`，沿用 [裁决 16](02-data-model-and-contract.md)。
5. **离线可用**：断网、无 CDN、无字体外链也能完整渲染。
6. **不改 core**：UI 只消费 `MemoryService` 的读方法，不碰 `src/core`、`src/storage`、`src/hygiene` 的判定逻辑。

## 3. 架构：三层，单向依赖

```
磁盘真相层            现有服务层                新增只读层             静态 UI
items/*.jsonl  ──►  MemoryService       ──►  src/web/server.js  ──►  ui/*.html
events.jsonl        (已有读方法)              (node:http, 无依赖)      ui/app.js
metrics/*.json       + 2 个新读方法            /api/*                  ui/style.css
brief/<scope>.md     + 1 个查询辅助
```

- **新增依赖方向**：`src/web/*` → `src/api/*` → 更下层。禁止反向（`api` 不认识 `web`）。
- **不进 MCP 工具面**：Web 是给人看的，不是给 Agent 用的；MCP 工具数量保持 10 个不变，避免模型被界面概念污染。
- **不做 SSR**：静态页 + `fetch('/api/...')`，页面本身可 `file://` 打开看线框（数据为空时显示空状态说明）。

## 4. 数据契约

### 4.1 `MemoryService` 新增两个读方法

```js
// 事件流：按时间倒序，按 scope 过滤，支持 op 白名单与时间窗
async events({ since, until, ops, limit = 200 } = {}) → {
  events: [{ ts, op, scope, id, detail }],   // 与 events.jsonl 行同形，原样返回
  scanned: number,                            // 扫了多少行（用于「可能被截断」提示）
  truncated: boolean                          // true 表示命中行数超过 limit
}

// 记录导出：按状态/类型/时间窗过滤，默认只给 active
async exportRecords({ since, until, status = 'active', kind, limit = 2000 } = {}) → {
  records: [{ id, subject, predicate, value, text, kind, status, validFrom, validTo, createdAt,
              hits, tags, source }],
  total: number, limited: boolean
}
```

两个方法都**只读**，不得写 `events.jsonl`（读事件不产生事件，否则 `hit` 会自我放大）。

### 4.2 只读 HTTP 接口（全部 `GET`，全部返回 JSON）

| 路径 | 参数 | 返回（顶层字段） | 用途 |
|---|---|---|---|
| `/api/summary` | – | `{ scope, memoHome, version, policy: { maxActive, nearDupThreshold, scanThreshold, scanDiceThreshold }, stats }` | 顶栏与全局状态 |
| `/api/brief` | `lines=80` | `{ text, generatedAt }` | 「现在注入给 Agent 的是什么」 |
| `/api/today` | `date=YYYY-MM-DD`（缺省=今天） | `{ date, counts: {created,superseded,forgotten,merged,hit}, timeline: [{ts, op, id, label, action, reason}] }` | 今日页主表 |
| `/api/records` | `status, kind, since, limit, q` | `{ records, total, limited }` | 图谱节点、详情面板 |
| `/api/graph` | `limit=300, days=90` | `{ nodes: [{ id, label, kind, status, subject, createdAt, hits, degree }], edges: [{ from, to, type, weight }], sampled: { shown, total } }` | 图谱页 |
| `/api/hygiene` | – | `{ candidates: [cluster], merged: [{ ts, loserId, winnerId }], superseded: [...], suspicious: { count }, series: [{ date, dupRatio, conflictRate, active, total }], doctor: {...} }` | 卫生页 |
| `/api/timeline` | `days=30` | `{ series: [{ date, active, total, created, superseded, merged, dupRatio, conflictRate }] }` | 趋势折线 |

约定：
- 所有时间字段一律 **UTC ISO8601 字符串**（UI 负责转本地时区显示）。
- 所有响应带 `{ "ok": true, ... }`；错误统一 `{ ok: false, code, message }` + 4xx/5xx（`E_INVALID_ARG` → 400，`E_CORRUPT_JSONL` → 500 且带 `file/line`）。
- `label` 的生成规则在服务端（`subject/predicate` 优先，unstructured 用 `text` 前 60 字），**UI 不拼接语义**，避免两端规则漂移。

### 4.3 图谱的边语义（`type`）

| type | 含义 | 视觉 |
|---|---|---|
| `same-entity` | 两条记录的 `subject` 相同（同一个人/服务/组件） | 细灰实线 |
| `supersedes` | 版本链：`to` 是 `from` 的继任者（`validTo` 已置） | 蓝色实线箭头 |
| `duplicate-of` | 近重复候选（来自 `dedupeScan` 的 `pairs`） | **橙色虚线**，`weight` = `pairs[].score`，`strength` 附在边上 |
| `disputed-with` | 同 slot 冲突中落败方与胜出方 | 红色虚线 |

边权重 `weight ∈ [0,1]`；`same-entity` 恒为 1（布尔关系），其余取相似度或排序分。

## 5. 页面规格

### 5.1 今日（`#/today`）

自上而下：
1. **日期选择器**（默认今天，可点前后天）+ 四个数字卡：新增 / 被取代 / 删除（墓碑）/ 合并。
2. **时间线**：当天每条事件一行 —— 时间、op 徽章（新增/取代/删除/合并/命中）、`label`、`reason` 原文（折叠，点开展开）、跳转记录详情。命中（`hit`）默认折叠成「今天被读过 N 次」一行，避免淹没真正变化。
3. **空状态**：当天无变化时显示「今天没有写入。上次写入是 <date>（N 天前）」，而不是空白页 —— 空白会让人以为坏了。

### 5.2 图谱（`#/graph`）

1. **画布**：canvas 绘制的力导向图（手写 ~120 行：斥力 + 弹簧 + 向心 + 阻尼，60fps 上限，`requestAnimationFrame` 逐帧 tick）。
2. **节点**：颜色 = `kind`（fact/pref/decision/gotcha/state 五色）；形状/描边 = 状态（active 实心、superseded 半透明加斜线、disputed 红描边、tombstone 灰色小点且默认隐藏）；半径 = `sqrt(hits)+3`（被回忆过的更大）。
3. **交互**：拖拽节点、滚轮缩放、点击节点 → 右侧详情面板（全文、slot、时间、版本链上下游、来源 agent）；点击边 → 显示 `type/weight/strength`。
4. **过滤器**（顶部）：scope（只读当前）、kind 多选、状态多选、时间窗（7/30/90/全部）、文本框即时过滤 label。
5. **采样**：节点上限 300。超出时按「最近创建优先 + hits 降序」采样，并在画布右上角常驻提示 `已采样 300 / 1 284 条，缩小时间窗可看全`。**绝不静默截断**。
6. **性能**：1000 节点以内 tick 预算 16ms；超过上限只降不采样之外的额外处理（不做 LOD、不做 WebGL）。

### 5.3 卫生（`#/hygiene`）

1. **待裁决候选区**（`dedupeScan` 的 clusters）：每簇一张卡，列出成员 `label` 与两两 `pairs`（containment / dice / strength）。**v0.2 这里只显示「建议」和复制给 Agent 的话术**（`请对以下簇用 memory_curate 裁决`），不提供按钮 —— 写操作在 v0.2.1。
2. **清理史**：最近 30 天的合并（`curate_apply` 事件）与失效（`supersede`），每条给出「谁取代了谁 / 合并前后 active 数」。
3. **趋势**：`dupRatio`、`conflictRate`、`active` 三条折线（手写 SVG `polyline`，30 天窗口，悬停显示当天数值与样本量）。
4. **体检摘要**：`doctor()` 的 issues 列表（`corrupt_jsonl` / `duplicate_content_hash` / `quota_exceeded` / `suspicious` 计数），严重度徽章。

## 6. 前置缺陷（必须先修，否则页面数字是错的）

| 缺陷 | 位置 | 影响 | 修法 |
|---|---|---|---|
| metrics 文件只有日期 | `src/cli/nightly.js:204` `${plan.date}.json` | 多分库同日互相覆盖 → 趋势图缺分库 | 改 `metrics/<date>.<scope>.json`（scope 里的 `:` 替换为 `-`）；读路径兼容旧文件名；保留 `<date>.json` 的迁移读取 |
| 事件无 `session` 字段 | `events.jsonl` | 「本次会话记了什么」做不到（只能按天） | v0.2 不引入；如需按会话聚合，作为 v0.2.2 候选并单独出 ADR |
| `hit` 事件噪声 | `flushHits` | 时间线被读命中淹没 | UI 层折叠（不删数据） |

## 7. 安全设计

- **绑定**：`server.listen(port, '127.0.0.1')`，并用单测断言 `server.address().address === '127.0.0.1'`。
- **CSP**：静态页 `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'">`，禁一切外链。
- **输出转义**：所有记录正文经 `textContent` 写入，禁止 `innerHTML` 拼接用户数据（XSS 面即投毒面）。
- **遮蔽**：`suspicious` 内容由服务端替换为 `[suspicious withheld]`，UI 无开关（想看得用 CLI `--include-suspicious`）。
- **不写状态**：无 cookie、无 localStorage 存正文（只存 UI 偏好：过滤器 + 缩放锚点）、无上传。
- **端口**：默认 `7788`，`--port` 可改；占用时报错并提示换端口，不静默递增。

## 8. 门禁增项（与 `docs/07` 同步）

| 编号 | 门禁 | 检查内容 | 阈值 |
|---|---|---|---|
| **Q9** | 质量 | UI 零构建：`ui/` 下无 `package.json`/`node_modules`/构建产物；单文件 ≤ 600 行；`ui/` 总量 ≤ 2500 行；HTML 内 `<script src>`/`<link href>` 只允许相对路径 | 全绿 |
| **S9** | 安全 | UI 无外链：`ui/**` 与 `docs/ui-mockup.html` 不含 `http(s)://` 资源引用（注释里也不许） | 0 命中 |
| **I13** | 行为 | API 契约：起 server 于临时端口 → 断言 7 个端点形状、`ok:false` 错误形状、suspicious 遮蔽、非法参数 400 | 7/7 |
| **I14** | 行为 | 时间过滤：造 3 天事件 → `/api/today?date=...` 与 `/api/timeline?days=3` 计数与日期正确（含时区边界） | 全对 |

## 9. 分阶段交付

### v0.1.3（补丁，先修数据面；1 天内）

1. metrics 按 scope 分文件（含旧文件迁移读取）+ 单测。
2. `service.events()` / `service.exportRecords()` + 单测（含 `truncated`、`limited` 语义）。
3. `memo serve` 骨架 + `/api/summary`、`/api/today` → 先能看「今天变了什么」。
4. 门禁：I14（时间过滤）先上；Q9/S9 随 UI 目录引入。

### v0.2.0（只读三页；核心交付）

1. `/api/graph`、`/api/hygiene`、`/api/timeline`、`/api/brief`、`/api/records`。
2. `ui/`：`index.html` + `app.js`（路由、fetch、渲染）+ `style.css` + `graph.js`（力导向）+ `charts.js`（SVG 折线）。
3. 三页规格全实现；采样提示、空状态、遮蔽、CSP 全就位。
4. I13 全绿；Q9/S9 全绿；`docs/07` 与 `docs/06`（怎么启动、端口、排障）更新。

### v0.2.1（可选，写操作）

- 「合并/保留两条」按钮 → 调 `curateApply`，**二次确认对话框显示将失效哪些 id**，成功后写一条 `curate_apply` 事件。
- 这是唯一允许 UI 产生写的地方，需单独 ADR + 审计测试（I15）。

### v0.2.2+（原路线）

`sqlite-index`（FTS5+WAL）、`memo curate auto`、投毒防线加固、hybrid 检索（有实测痛点才做）。

## 10. 明确不做

1. 不做登录/账号/多用户（本机单用户，回环绑定）。
2. 不做写入编辑（v0.2），不做「界面里手改记忆」——那是真相层的核弹按钮。
3. 不做 WebSocket 实时推送（刷新即可；轮询 `/api/summary` 5s 一次足够）。
4. 不做移动端适配（先桌面；手机看用后续方案）。
5. 不做导出 PDF/分享链接（本地工具，无分享面）。
6. 不引入图表库/图算法库（手写 200 行内解决）。
7. 不做暗色/亮色主题切换（跟系统 `prefers-color-scheme` 即可）。

## 11. 未决问题（需用户拍板）

1. **访问范围**：只本机 `127.0.0.1:7788` 够吗？还是想在手机/平板上看（需要局域网绑定 + 简单 token）？
2. **图谱边的优先级**：默认同时画「同实体 + 版本链 + 重复候选 + 冲突」四类，会不会太密？建议默认只开前两类，重复候选单独开关。
3. **「每天记了什么」的粒度**：按自然日够吗？还是想要「按会话」（需要给事件加 session id，属数据层变更）。
4. **是否需要日报导出**：把「今日」页导出成 Markdown 追加进 `brief/` 或发到某处（会引入外部依赖，默认不做）。
