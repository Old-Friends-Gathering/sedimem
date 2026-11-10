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
| `/api/today` | `date=YYYY-MM-DD`（缺省=今天）、`tzOffset=480`（分钟，默认 0=UTC） | `{ date, counts: {created,superseded,forgotten,merged,hit}, timeline: [{ts, op, id, label, action, reason}] }` | 今日页主表 |
| `/api/records` | `status, kind, since, limit, q` | `{ records, total, limited }` | 图谱节点、详情面板 |
| `/api/graph` | `limit=300, days=90` | `{ nodes: [{ id, label, kind, status, subject, createdAt, hits, degree }], edges: [{ from, to, type, weight }], sampled: { shown, total } }` | 图谱页 |
| `/api/hygiene` | – | `{ candidates: [cluster], merged: [{ ts, loserId, winnerId }], superseded: [...], suspicious: { count }, series: [{ date, dupRatio, conflictRate, active, total }], doctor: {...} }` | 卫生页 |
| `/api/timeline` | `days=30`、`tzOffset=480` | `{ series: [{ date, active, total, created, superseded, merged, dupRatio, conflictRate }] }` | 趋势折线 |

约定：
- 所有时间字段一律 **UTC ISO8601 字符串**；「哪一天」由 `tzOffset`（分钟，东为正）换算成 `[from, to)` UTC 时刻后再过滤，服务端不猜时区（用户决策：按自然日）。
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

**必须是活的**（用户 2026-11-02 明确要求"动态"），不是静态布局图：

1. **实时力导向**：`requestAnimationFrame` 每帧跑一次模拟（斥力 O(n²) 但 n≤300 可接受；弹簧 + 向心 + 阻尼 0.85），`alpha` 衰减到 0.005 停止；拖拽节点时该节点固定（`fx/fy`），松手后重新加入模拟。
2. **交互**：拖拽节点 / 滚轮缩放（0.4×–2.5×）/ 拖拽空白平移 / 点击节点开右侧详情（该节点的全文、slot、版本链上下游、来源 agent、命中次数）/ 双击节点锁定或释放。
3. **边默认只开两类**（用户 2026-11-02 决策）：默认 `same-entity` + `supersedes`；工具栏有「全开」开关，一次点亮 `duplicate-of` + `disputed-with`（也可单独勾）。开关状态存 `localStorage`（只存偏好，不存正文）。
4. **节点**：颜色 = `kind`（五色）；外观 = 状态（active 实心、superseded 半透明 + 斜线、tombstoned 灰点且默认隐藏、disputed 红描边）；半径 = `sqrt(hits)+3`。
5. **采样**：节点上限 300，按「最近创建优先 + hits 降序」采样，画布右上角常驻 `已采样 300 / 1 284 条`。**绝不静默截断**。
6. **性能预算**：300 节点 60fps；超过 300 不降级渲染（采样已经封顶）。

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

- **绑定**：`server.listen(port, '127.0.0.1')`，并用单测断言 `server.address().address === '127.0.0.1'`；`createWebServer({host})` 另有**运行时回环断言**（非 `127.0.0.0/8`、`::1`、`localhost` 一律 `E_INVALID_ARG`），门禁 S9 只能挡源码默认值，挡不住调用方传参（裁决 41）。
- **超时**：`headersTimeout=10s`、`requestTimeout=15s`、`keepAliveTimeout=5s`；`close()` 先 `closeIdleConnections()` 再 `server.close()`，避免浏览器常驻标签页把关闭拖住（裁决 41）。
- **CSP**：静态页 `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'">`，禁一切外链。
- **输出转义**：所有记录正文经 `textContent` 写入，禁止 `innerHTML` 拼接用户数据（XSS 面即投毒面）。
- **遮蔽**：`suspicious` 内容由服务端替换为 `[suspicious withheld]`，UI 无开关（想看得用 CLI `--include-suspicious`）。
- **不写状态**：无 cookie、无 localStorage 存正文（只存 UI 偏好：过滤器 + 缩放锚点）、无上传。
- **端口**：默认 `7788`，`--port` 可改；占用时报错并提示换端口，不静默递增。

## 8. 门禁增项（与 `docs/07` 同步）

| 编号 | 门禁 | 检查内容 | 阈值 |
|---|---|---|---|
| **Q9** | 质量 | UI 零构建：`ui/` 下无 `package.json`/锁文件/`node_modules`/`dist`/`build`；单文件 ≤ 600 行；`ui/` 总量 ≤ 2500 行；HTML 内 `<script src>`/`<link href>` 只允许相对路径；`// q9-allow` 必须带理由 | 全绿 |
| **S9** | 安全 | UI 无外链：`ui/**` 与 `docs/ui-mockup.html` 不含 `http(s)://` 资源引用（注释里也不许） | 0 命中 |
| **I13** | 行为 | 静态面安全：起 server 于临时端口 → `/` 与 `/app.js` 200 + Content-Type、5 条穿越路径（含裸 `../`、编码、绝对路径）404、`/ui/` 与目录 404、非 GET → 405、未知 `/api` → 404、无 CORS 头、绑定地址为 `127.0.0.1` | 全绿 |
| **I14** | 行为 | 截面一致性：同一时间窗内 `exportRecords` / `events` / `/api/graph` / `/api/today` 自洽；suspicious 遮蔽；`created` 事件可回查；图谱节点数 ≤ limit；same-entity 边 ≤ n−1 | 全对 |
| **I15** | 行为 | 常驻可见性：`memo serve` 启动后由**另一个进程**（真实 CLI）写入 → 下一次 `/api/summary`、`/api/records`、`/api/graph` 立即可见，且时间线 label 不退化为操作名 | 全绿 |

## 9. 分阶段交付

> 施工级任务分解（谁改哪些文件、并行范围、风险与回滚）见 [`plans/v0.2-web-ui-plan.md`](plans/v0.2-web-ui-plan.md)。

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
- 这是唯一允许 UI 产生写的地方，需单独 ADR + 审计测试（届时新增 I16，I15 已被常驻可见性占用）。

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

## 11. 决策记录（用户 2026-11-02 拍板）

| # | 问题 | 决策 | 对设计的影响 |
|---|---|---|---|
| D1 | 访问范围 | **仅本机** `127.0.0.1`，不做 token、不做局域网 | 无鉴权层；绑定地址写进单测 |
| D2 | 图谱边 | **两者都要**：默认只开「同实体 + 版本链」，提供「全开」开关点亮「重复候选 + 冲突」 | §5.2 第 3 条；开关持久化到 localStorage |
| D3 | 图谱形态 | **必须动态**：实时模拟 + 拖拽 + 点击看详情 | §5.2 第 1–2 条（否决静态布局 / 一次性动画） |
| D4 | 粒度 | **自然日** | `/api/today`、`/api/timeline` 增 `tzOffset` 参数 |
| D5 | 日报导出 | **不做** | §10 第 5 条维持 |

四个问题全部关闭，不再留"待定项"。

---

## 12. 实现说明与偏差（2026-11-02，v0.1.3 落地记录）

> **第九轮：双审核整改（arch 5 严重 + adversarial 4 严重，均无阻断）**
>
> 1. **常驻进程截面撕裂**（A1）：`MemoryService.refreshView()` + 每个 `/api/*` 请求前刷新；新增 I15 跨进程回归用例（真实 CLI 子进程写入 → 下一次请求可见）。
> 2. **suspicious 遮蔽漏洞**（A2）：`subject`/`predicate`/`source.quote` 一并遮蔽，单一实现下沉到 `src/api/mask.js`（裁决 42）。
> 3. **图谱缺 disputed 节点**（S2）：节点准入加 `disputed`，冲突红边才画得出来（裁决 40）。
> 4. **serve 关闭吞错**（S1）：`close()` 失败改为 stderr + exit 1（裁决 21）。
> 5. **metrics 命名单一来源**（S5）：`src/config/paths.js` 的 `scopeKeyOf` / `metricsFileName` / `legacyMetricsFileName`，夜间任务与 Web 读侧共用（裁决 39）。
> 6. **回环绑定与超时**（B4/B5）：运行时断言 + 显式超时 + `closeIdleConnections()`（裁决 41）。
> 7. **导出顺序稳定**（A3/B8）：`exportRecords` 按 `createdAt`+`id` 排序后再截断，`q` 过滤不再在随机子集里搜（裁决 44）。
> 8. **Q9 阈值落地**（S3）：零构建 + 单文件 ≤600 + 总量 ≤2500 真正实现；为此把 `ui/graph.js` 拆成 `ui/layout.js`（纯布局）+ `ui/graph.js`（渲染交互）（裁决 43）；`// q9-allow` 必须带理由（B6）。
> 9. **契约登记**（S4）：`read-only.js` / `paths.js` / `mask.js` 的导出与私有耦合写入 `docs/02 §3.11`，Q5 覆盖率 98.3%。

三页与 7 个端点按 §4–§7 实现（`versions/v0.3/src/web/{server,handlers,static}.js` + `versions/v0.3/ui/`，CLI 子命令 `memo serve`）。以下三处与本文设计不一致，均已冻结为 `docs/02` §3.10 裁决 35–38，冲突时以 02 为准：

1. **图谱 same-entity 边改为时间链（裁决 35）**：§5.2 原描述「同一 subject 两两连边」在全连时是 O(n²) 且视觉上不可读（17 节点 136 条重叠边）。实现改为按 `createdAt` 升序只连相邻两条，表达同一实体的时间序列。
2. **图谱节点标签做了防重叠跳过**：标签绘制前做包围盒碰撞检测，重叠时只画部分标签（缩放到 `scale ≥ 0.45` 且不重叠才画）。语义仍全部由服务端 label 承载（裁决 37），被跳过的标签点节点看详情兜底——这是绘制层的取舍，不是数据缺失。
3. **布局加了「同步热身 80 帧 + 自适应缩放」**：`rAF` 在后台标签页会被浏览器节流，若纯靠异步动画收敛，首帧往往是一小团。实现改为先同步跑 80 帧模拟再自适应缩放到画布，保证打开即是一个铺满视口的稳定布局；之后的拖拽/缩放仍走实时模拟。

## 13. 多分库浏览（v0.1.5，issue #23）

观察台最初只服务启动时解析出的**一个**分库，导致「Codex 在别的项目写了记忆，观察台看不见」。
现在三处改动，都是只读的：

| 端点 | 行为 |
|---|---|
| `GET /api/scopes` | 列 `$MEMO_HOME/items/*.jsonl` 里的全部分库：`{scope, records, bytes, mtime, current}`，按 mtime 降序；启动分库即使还没有文件也列出（空库下拉不消失） |
| `GET /api/{summary,today,records,graph,hygiene}?scope=<scope>` | 按指定分库返回；未传则用启动分库 |
| 顶栏 | 分库徽章变 `<select>`（带记录数）；切换写入 URL `#/today?scope=repo:x`，可刷新可分享 |

**安全约束（这条最要紧）**：`scope` 直接进文件路径（`items/<scope>.jsonl`），所以 `?scope=` 必须过
`SCOPE_PATTERN`（`^(repo|dir|user|global):[a-z0-9][a-z0-9._-]{0,63}$`）。非法值返回 **400 `E_INVALID_ARG`**，
不触盘。单测覆盖 `../etc/passwd`、`../../etc/passwd`、`nope`、`repo:`、`repo:a/b` 五类拒绝。

服务端按 scope 懒建 `MemoryService` 并缓存（`Map<scope, service>`），`close()` 时统一关闭；
未列出的分库也可以直接用 `?scope=` 访问（只要名字合法），列表只是 UI 的便利。

**图谱页也必须跟随（v0.2.0，issue #25）**：`initGraph({..., scope})` 会把 scope 拼进
`/api/graph?limit=300&days=90&scope=...`；`#/graph?scope=x` 的路由解析只取 path 部分（否则
`graph?scope=x` 不匹配 ROUTES 会回落成 today 页）；同一路由下分库变化时 `loadGraph()` 先
`destroy()` 再重建，避免复用旧实例继续画老库。

**为什么不做「跨分库聚合视图」**：分库的意义是隔离（不同项目的事实不该互相污染）；一个混在一起的
"全部分库" 页面会立刻把 scope 隔离的价值抹掉。要看别的项目就切过去看。

## 14. v0.4 搜索页与两个新端点

竞品调研（`docs/research/competitive-dsh-plugins-2026-11.md`）里「检索」是我们最大的短板，
v0.4 先补「可解释的检索」与「界面能搜」，语义道本身是可选增强。

### 14.1 `GET /api/search`

| 参数 | 约束 | 说明 |
|---|---|---|
| `q` | **必填**，非空 | 空 q 直接 `400 E_INVALID_ARG`（绝不返回全库） |
| `limit` | 1–100，默认 10 | 越界 400 |
| `scope` | 过 `SCOPE_PATTERN` | 缺省用服务启动分库 |

返回 `{ok, items:[{id, scope, kind, title, text, score, basis, status, validFrom, ...}], degraded, degradedReason, scope}`：

- `basis` ∈ `bm25` / `vector` / `bm25+vector`：告诉调用方「这一条是凭什么被召回的」；
- `degraded` + `degradedReason`：语义道关闭时 `semantic-disabled`，语义路故障时给具体错误码
  （`E_EMBED_UNAVAILABLE` / `E_EMBED_DIM_MISMATCH`）。**UI 必须显示这条提示**，
  否则用户会把「只有词法」误读成「记忆里没有」。

### 14.2 `#/search` 页面

- 路由 `#/search?q=<query>`（query 与 scope 都在 hash 里，刷新保持）。
- 顶部输入框回车写 hash；切分库后按当前 query 重查。
- 结果卡片：title（无 title 退正文首句）、kind 徽标、`basis` 徽标、score、正文片段。
- 渲染是**纯函数** `ui/search-view.js: renderSearchResults()`，返回 HTML 字符串且所有插值都
  `escapeHtml`；挂载用 `DOMParser` 解析后 `replaceChildren`，**不用 innerHTML**（Q9 硬约束）。

### 14.3 `GET /api/conflicts`

分歧（disputed）的一等公民视图，与 `memo conflicts` 同一份 `listConflicts()`：
`{ok, slots:[{key, records, pairs:[{aId,bId,sim}], disputedCount}], disputedCount, supersededCount, scanned}`。
只读——裁决仍走 CLI 的 `memo conflicts resolve`（UI 不产生写，S9 约束不变）。

### 14.4 测试

- I25 语义融合与降级、I26 脱敏、I27 分歧、I28 捕获、I29 注入预算、I30 `/api/search` 契约。
- 单元：`tests/unit/search-view.test.js`（转义）、`tests/unit/hybrid.test.js`（RRF 性质）、
  `tests/unit/embedder.test.js`（假 fetch：超时/维度漂移/未就绪）。

## 15. 浅色外观适配（v0.4.2）

观察台跟随系统外观（`prefers-color-scheme`）。深色底与浅色底对同一套色值的要求不同：

| 元素 | 深色底 | 浅色底（v0.4.2 起） |
|---|---|---|
| 节点填充 | kind 原色 | 与黑混合 26% 压暗（`contrastColor(...,node)`） |
| 节点描边 | 无 | 1.25px 近白描边（把点从浅底里「抠」出来） |
| 连线 | kind 原色 + 雾化下限 0.12 | 压暗 58% + 雾化下限 0.46 + 线宽 +0.45px |
| 标签 | `#cfd6e4` | `#1f2430`，superseded 用 `#6b7280` |
| superseded 节点 | alpha 0.4 | alpha 0.62（浅底要更实） |

实现位置：`ui/palette.js` 的纯函数（`parseColor` / `contrastColor` / `fogAlphaFloor` / `nodeStroke`）+
`ui/graph-style.js` 的取色函数；`ui/graph.js` 只负责绘制。单测：`tests/unit/palette-contrast.test.js`。
真实截图：[`docs/shots/graph-light.png`](shots/graph-light.png)。
