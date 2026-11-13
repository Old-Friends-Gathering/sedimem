# 架构审核：v0.1.3 / v0.2 Web UI（只读层）

- 日期：2026-11-02 ｜ 审核人：架构审核（AI）｜ 范围：`src/web/**`、`src/api/read-only.js`、`ui/**`、`src/cli/{memo,nightly}.js`、门禁 Q9/S9、覆盖率排除、docs/02 §3.9–3.10、docs/06–08、plans/v0.2-web-ui-plan.md
- 验证环境：node（DSH runtime）跑通 146/146 测试、eval I1–I14、quality 9/9、security 9/9、coverage 93.48/79.13/91.85；另写 /tmp 探针验证 disputed 写入门禁与图谱边行为
- 结论速览：**无阻断项**；5 严重（1 个数据面 bug、1 个结构性死功能、3 个契约/文档-代码漂移）+ 9 建议

---

## 一、分层与依赖方向（审核点 1）

**结论：import 级单向成立；文件级有一处越层（严重 S5）。**

- `src/web/server.js:7` → `../api/service.js`；`src/web/handlers.js:9` → `../config/policy.js`；`src/web/static.js` 仅 node 内置。无任何对 `hygiene/storage/index` 的 import，Q9 规则 1 与裁决 34 一致，实测门禁通过。
- `src/api/read-only.js` 读 `events.jsonl` 属 service 内部实现搬迁（同层），不构成两套真相；但见严重 S4 的私有成员耦合。
- **越层点**：`src/web/handlers.js:352-361 readMetrics()` 直接读 `$MEMO_HOME/metrics/*.json`，`handlers.js:94-102 appVersion()` 直接读 `package.json`。metrics 的文件名契约（`<date>.<scopeKey>.json`、`scopeKey = scope.replace(/[^a-z0-9._-]+/gi,'-')`）被复制到 web 层——正则全文重复出现在 `src/cli/nightly.js:206、235、236` 与 `src/web/handlers.js:354` 共 4 处。任何一侧改命名规则，趋势图静默变空（`readMetrics` 返回 null 不报错）。这是最接近「两套真相」的地方。appVersion 读 package.json 属展示元数据，可接受，但同理应在冻结清单登记。

## 二、只读性的结构性保证（审核点 2）

**结论：无任何请求路径会写 items/events/metrics；唯一写路径是 close→flushHits，且被 CLI 层吞错（严重 S1）。**

- 7 个端点只调 `stats/brief/events/exportRecords/get/dedupeScan/doctor`，全部只读。hits 累加只发生在 `search()`（service.js:383），web 层不调 search，因此 `close()→flushHits()` 实际无增量可写——只读性成立，但它是「无路径会写」+ S9 grep 门禁 + 调用纪律的合成，不是类型级隔离（没有 ReadonlyService 投影接口）。v0.2 可接受；v0.3 加写端点前建议引入显式只读门面。
- `server.js:88-91` 关闭顺序正确：先 `server.close`（等在途请求）再 `svc.close()`，flushHits 错误沿 `close()` 上抛，不漏。
- **但 CLI 把不吞错约定打穿了**：`src/cli/memo.js:494-500` 的 `shutdown()` 是 `try { await web.close(); } finally { process.exit(0); }`——`web.close()` 抛出的 flushHits 错误在 `finally` 的 `process.exit(0)` 中被吞，进程仍 exit 0、错误不打印。裁决 21「close 不吞错」在顶层失效（见 S1）。
- `static.js` 路径解析：decode→NUL 检查→`..`/反斜杠/重拼校验（46 行）→resolve 前缀复核（50）→`lstat` 拒 symlink/目录→readFile。多层防御到位，I13 用裸 `http.request`（绕过 fetch 的路径规范化）实测穿越全 404。残余面见建议 B3。

## 三、服务端派生 vs UI 拼接（裁决 33/37，审核点 3）

**结论：label/边/聚合全部服务端产出，UI 无语义二次计算；但 `disputed-with` 边结构性不可渲染（严重 S2）。**

- `ui/app.js` 只消费服务端 `label`（167、189 行），无 `subject/predicate` 拼接；`charts.js` 只按服务端 `activeRatio`（裁决 38）画百分比。核过 `app.js/charts.js/graph.js` 无重算。
- `handlers.js` 内部 `decisionKey` 聚合在 apiToday/apiTimeline/apiHygiene 三处复用同一函数，无漂移。
- **S2**：`handlers.js:334-345` 的 `disputed-with` 边 `from` 是 disputed 记录 id，而节点采样集只含 `active/superseded`（238 行）——disputed 记录永远进不了 nodes，`ui/graph.js:377-379` 对 `nodeById.get(e.from)` 为空的边直接 `continue`。即：只要真的出现同 slot 的 disputed+active 对（disputed-with 唯一成立的场景），边必然悬空、必然被 UI 丢弃。**该边类型在当前结构下是死功能**，与裁决 33 承诺的四类边不符。探针验证：conflict 写入后图谱只剩 1 个节点、0 条边（该场景无 active 对，属正常；悬空逻辑由代码结构直接可证）。

## 四、read-only.js 搬迁与契约（裁决 30，审核点 4）

**结论：委托契约保形；私有成员耦合未登记（严重 S4）。**

- `service.js:861-868` 委托方法签名、默认值（`events limit=200`、`exportRecords status='active', limit=2000`）、`[since,until)` 半开、`truncated/limited`、suspicious 遮蔽全部与裁决 30 一致；`events-query.test.js` 10 例覆盖。
- `read-only.js:18,62-63` 访问 `service._ensureOpen()` 与 `service._records`——下划线私有成员的隐式耦合。同仓内搬迁可接受，但契约上完全空白：docs/02 §3.10 的「Web 只读层冻结导出清单」只登记了 `src/web/*`，`read-only.js` 的 `queryEvents/queryExportRecords` 既不在冻结表也不在 contract-exempt——**质量门禁 Q5 自己每轮都在报这两条**（96.4% 通过是因为下限 90%）。应把「read-only.js 可依赖 `_ensureOpen/_records/memoHome/scope`」写成显式契约（或提供只读访问器），防止后续重构 service 时静默破坏。

## 五、可迭代性（docs/03 六 Port，审核点 5）

**结论：六个 Port 扩展点不受影响；v0.3 演进有两处需提前设计但不构成阻碍。**

- Web 层只消费 service 公开读方法，Storage/Index/Judge/Renderer/Clock/Policy 六 Port 的替换面不经过 web，`sqlite-index`（v0.2.2）对 Web 透明。
- v0.3 写端点：`ROUTES` 表可加路由，但 GET-only 检查硬编码在 `server.js:54-59`，写端点需引入方法分发与鉴权层——当前单函数 `handle()` 结构可插入中间件，不阻碍。
- v0.3 远程访问：`createWebServer` 的 `host` 参数运行时可传 `0.0.0.0`，S9 只检查源码里的默认值字面量（见建议 B5）。届时需要 auth hook + 运行时断言，建议在 ADR 里预先约定。

## 六、测试与门禁形状（审核点 6）

- **I13 真测边界**：裸 `http.request` 发原始路径（fetch/new URL 会吞 `/../`）、非 GET 405、回环断言、目录/穿越/内容类型——是边界测试，不是单测重复。I14 三视角对账（exportRecords/events/graph/today 同窗计数自洽）是新增的截面一致性维度，有价值。
- **Q9/S9 可绕过性**：`// q9-allow`（quality-check.mjs:313）对该行的外链+innerHTML+eval 三类检查同时豁免，且理由只要求「PR 里说明」无机器可查记录（对比 contract-exempt.json 有理由字段）。import 边界（规则 1）不可豁免，S9 完全无豁免通道——好的不对称。滥用风险中等，见建议 B6。
- **覆盖率排除 ui/**：理由（浏览器代码 node 侧无意义）成立，且 `graph.js` 已把 `layoutTick` 纯函数化并被 `graph-layout.test.js` 单测——排除不等于放水，但被测的纯函数也不计入覆盖统计。替代方案见建议 B7。
- **Q9 实现缺项**：docs/08 §8 Q9 声明的「ui/ 无 package.json/node_modules/构建物、单文件 ≤600 行、总量 ≤2500 行、script/link 仅相对路径」在 `q9WebUiBoundary()` 里**一项都没实现**（grep 无 600/2500/构建物检查）；docs/07 的 Q9 描述已改写成实现子集，两份文档互相矛盾，且 `ui/graph.js` 实测 605 行已超 08 的 600 阈值。归入严重 S3。

## 七、文档-代码偏差逐条核对（审核点 7，对 docs/08 §12 与 plan 执行记录）

docs/08 §12 声明的三处偏差（裁决 35 时间链、标签防重叠跳过、热身 80 帧）与代码一致，已正确升格到 docs/02 §3.10。其余偏差：

| # | 文档说 | 代码是 | 归级 |
|---|---|---|---|
| 1 | docs/08 §8：I13=API 契约、I14=时间过滤 | i13=static-security、i14=cross-section；7 端点形状与 tzOffset=0/480 断言落在 `tests/unit/web-server.test.js:55-176`。plan §194 记录了这次改名，但 08 是「以本文件为准」的权威契约，未改 | S3 |
| 2 | docs/08 §8：Q9 含行数/构建物阈值全绿 | 门禁未实现这些阈值；graph.js 605 行超标 | S3 |
| 3 | docs/02 §3.10：冻结清单登记 Web 只读层导出 | `read-only.js` 两个导出漏登记（Q5 每轮报） | S4 |
| 4 | docs/02 §3.10：`createWebServer` 「SIGINT/SIGTERM 优雅关闭」 | 信号处理在 `cli/memo.js:503-504`，server.js 无信号逻辑 | B1 |
| 5 | docs/02 裁决 36：裁决键实现见 `curateKeyOf()`，ids「排序拼接」 | 实现是 `decisionKey()`（handlers.js:139-144），`ids.join(',')` **未排序** | B2 |
| 6 | plan W6：`tests/injection/i13-api-contract.test.js`、`i14-time-filter.test.js` | 文件名不同（plan §194 已说明），plan §63 WBS 表未更新 | 可忽略（plan 已自记） |

---

## 严重（应在本次修）

**S1 · `memo serve` 关闭时吞掉 flushHits 错误并 exit 0（违背裁决 21）**
- 位置：`versions/v0.1/src/cli/memo.js:494-500`（shutdown）
- 复现：向 web.close() 注入会抛错的场景（如 memoHome 只读）→ SIGINT → 进程 exit 0、stderr 无错误。`finally { process.exit(0) }` 在拒绝传播前终止进程。
- 修法：`catch (err) { process.stderr.write(...); process.exitCode = 1; } finally { process.exit(process.exitCode ?? 0) }`；或去掉 finally 里的 exit，让拒绝自然退出非零。

**S2 · `disputed-with` 边结构性不可渲染（裁决 33 死条款）**
- 位置：`versions/v0.1/src/web/handlers.js:334-345`（边生成）+ `versions/v0.1/ui/graph.js:377-379`（`if (!a || !b) continue`）
- 证据：节点集只含 active/superseded（handlers.js:238），disputed 记录永不入 nodes；disputed-with 的 `from` 恒为 disputed id → 恒悬空 → 恒被 UI 丢弃。红线冲突边在产品里永远看不见。
- 修法（任选其一，需回写裁决）：a) 把 disputed 记录纳入节点采样（外观红描边，docs/08 §5.2 第 4 条本来就定义了 disputed 红描边外观——文档其实预期了 disputed 节点存在）；b) 边改为「同 slot 的两条 active/胜者之间的双向提示」；c) 若 v0.2 不做，从契约里显式移除该边类型并在 UI 隐藏开关项。推荐 a，与 §5.2 已有外观定义对齐。

**S3 · docs/08 §8 与实现的门禁/用例漂移（08 为权威契约）**
- 位置：`docs/08-web-ui.md:142-147`（Q9/I13/I14 表）vs `tools/quality-check.mjs:284-343`、`tests/injection/i13-static-security.test.js`、`tests/injection/i14-cross-section.test.js`、`ui/graph.js`（605 行）
- 证据：门禁输出 `Q9 Web UI 层边界（ui 5 文件：无越界 import/外链/innerHTML/eval，static 白名单）`——无行数/构建物检查；grep quality-check.mjs 无 `600|2500`。
- 修法：要么把 §8 阈值实现进 Q9（同时把 graph.js 拆到 ≤600 行，如把渲染与布局分开），要么改 §8 使其与实现一致并同步 docs/07；I13/I14 的语义重命名回写 §8（引用 plan §194 的执行记录）。

**S4 · read-only.js 契约缺位：导出未登记 + 私有成员隐式耦合**
- 位置：`versions/v0.1/src/api/read-only.js:18,62-63`（`service._ensureOpen()`、`service._records`）；`docs/02-data-model-and-contract.md` §3.10 冻结清单
- 证据：quality-check 每轮打印 `export queryEvents 未在 docs/ 契约中登记`（通过只因下限 90%）。
- 修法：冻结清单补 read-only.js 两导出及「允许访问 `_ensureOpen/_records/memoHome/scope`」的依赖契约；或给 service 加只读访问器消除下划线耦合。后者的重构成本低且一劳永逸。

**S5 · metrics 命名规则四重复制 + web 层直读文件（两套真相风险）**
- 位置：`src/cli/nightly.js:206、235、236` + `src/web/handlers.js:352-361`
- 证据：同一正则 `/[^a-z0-9._-]+/gi` 出现 4 次；`readMetrics` 读不到时返回 null，趋势图静默缺数（无告警路径）。改名漂移 = 静默数据丢失，与裁决 31 要修的问题同类。
- 修法：把 scopeKey 归一化 + metrics 读取下沉为 service（或 read-only.js）的 `readMetricsSnapshot(date)` 单一实现，web 只调方法；nightly 写侧 import 同一 helper。

## 建议（可延期，附理由）

- **B1** docs/02 §3.10 冻结清单把 SIGINT/SIGTERM 归属说成 server.js 导出的职责；改为「由 CLI 层负责」或把信号处理移入 createWebServer。理由：纯文档措辞，不影响行为。
- **B2** 裁决 36 写「ids 排序拼接」但 `decisionKey()`（handlers.js:139-144）未排序。同一 pair 的 loser/winner 两条事件 ids 顺序一致时聚合正确，跨顺序（理论上 a/b 互换）会分裂计数。修实现（`[...d.ids].sort().join(',')`）成本一行，顺手修。
- **B3** `static.js:53-59` 只 `lstat` 最终组件；若 `ui/` 内某子目录是指向外部的 symlink，父目录会被跟随，可越出 ui 根。威胁模型内（本地信任仓）风险低；可在 resolve 后对每个父目录 realpath 复核，或 CI 检查 ui/ 无 symlink。
- **B4** `server.close()` 未调 `closeIdleConnections()`：浏览器 keep-alive 连接可能让 SIGINT 后关闭挂住数秒（node ≥18.2 有该 API）。`shutdown()` 的 `process.exit(0)` 兜底了挂死，但也放大了 S1。建议 close 里加 `server.closeIdleConnections()`。
- **B5** `createWebServer({host})` 运行时可绑 `0.0.0.0`，S9 只挡源码默认值。建议 server.js 加运行时断言：host 非回环地址（127.x/::1）时抛 E_INVALID_ARG，把 D1 从「门禁纪律」升级为「结构保证」。
- **B6** `// q9-allow` 一行同时豁免三类检查且无机器可查的理由登记。建议改成 per-rule token（如 `// q9-allow:external-url 理由`）+ 汇总进 contract-exempt.json 式的理由文件，保持与豁免清单同等审计强度。
- **B7** 覆盖率排除 ui/** 的替代方案：把 `layoutTick` 等 DOM-free 纯函数拆到 `ui/pure.js`（仍零构建），coverage 对该文件不排除——既不污染后端阈值，又能让布局逻辑进统计。
- **B8** `apiRecords`（handlers.js:215-227）的 `q` 过滤发生在 limit 截断**之后**，且 `exportRecords` 不排序（`_records` Map 插入序）：记录数 >2000 时 `q` 搜索结果可能不完整，`total/limited` 反映的是过滤前口径。契约虽未违规（limited 已提示），建议：exportRecords 按 createdAt 排序，或 q 存在时文档化「在截断集内搜索」。
- **B9** `apiToday/apiHygiene/apiGraph` 每请求全量读 `events.jsonl` 与全量 exportRecords（limit 1e6）。本地单用户可接受；v0.3 若远程/多客户端化需要缓存或增量读（`_reload` 已有尾部 fold 能力可复用）。现在不做，记录为演进约束。

## 复现/验证附录

- 全套验证命令在本机通过：`node --test "tests/**/*.test.js"`（146/146）、`node eval/run.js`（I1–I14 PASS）、`node tools/quality-check.mjs`（9/9）、`node tools/security-check.mjs`（9/9）、`node tools/coverage-gate.mjs`（93.48/79.13/91.85）。
- disputed 探针：连续两次 `svc.write` 同 `subject/predicate` 不同 value → 第二次 action='disputed'；`/api/graph` 节点仅剩 1 个 active，无任何边产出路径覆盖「disputed+active 同 slot」场景（见 S2 的静态证明）。

---

**阻断项：no**（无必须修才能合的问题；S1–S5 建议随本次提交修，其中 S1/S2 是行为缺陷，S3–S5 是契约与漂移面，均不阻塞只读正确性的主路径。）
