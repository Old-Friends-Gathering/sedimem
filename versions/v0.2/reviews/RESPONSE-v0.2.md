# v0.2 Web UI 双审核处置表

> 审核对象：`feat/v02-web-ui-impl`（v0.1.3 只读 Web UI）
> 审核者：架构审核 `reviews/arch-v0.2.md`（117 行）+ 对抗审核 `reviews/adversarial-v0.2.md`（154 行）
> 两路结论均为 **阻断项 no**；本表记录每条严重/建议项的处置，以及处置后的复验证据。
> 日期：2026-11-02

## 一、严重项（两路共 9 条）

| # | 来源 | 问题 | 处置 | 证据 |
|---|---|---|---|---|
| S1 | arch | `memo serve` 关闭时 `finally { process.exit(0) }` 吞掉 `flushHits` 错误（裁决 21 失效） | **已修**：`catch` 打 stderr 并 `exit(1)`，成功才 `exit(process.exitCode ?? 0)` | `src/cli/memo.js` shutdown；人工注入失败路径验证非零退出 |
| S2 | arch | `disputed-with` 边结构性不可渲染（节点集不含 disputed） | **已修**：节点准入加 `disputed`（裁决 40） | `/api/graph` 返回 `status:'disputed'` 节点；`web-server.test.js` 断言三态 |
| S3 | arch | `docs/08 §8` 声明的 Q9 阈值（单文件 ≤600 / 总量 ≤2500）未实现，`ui/graph.js` 605 行越线；I13/I14 语义与文档不一致 | **已修**：Q9 真正实现零构建 + 行数阈值；`ui/graph.js` 拆为 `ui/layout.js`（188 行）+ `ui/graph.js`（448 行）；§8 表格按实际语义重写并新增 I15 行（裁决 43） | `node tools/quality-check.mjs` Q9 全绿；`docs/08 §8` 三行已更新 |
| S4 | arch | `read-only.js` 导出未登记契约 + 访问 `service._ensureOpen/_records` 私有耦合无契约 | **已修**：`docs/02 §3.11` 登记 `queryEvents`/`queryExportRecords`/`maskSuspiciousRecord`/`scopeKeyOf` 等六个导出，并写明允许访问的私有面 | Q5 契约覆盖 95.2%（60/63），零豁免 |
| S5 | arch | metrics 命名正则四处重复、`readMetrics` 静默缺数 | **已修**：`src/config/paths.js` 为唯一来源，nightly 写侧与 web 读侧共用（裁决 39） | `grep -c "\[\^a-z0-9._-\]" src` 仅余 paths.js 一处 |
| A1 | adv | 常驻服务 `_records` 冻结 → 「今日 +1、图谱/记录不变」的撕裂截面；I14 用同一 service 实例故测不到 | **已修**：`refreshView()` + 每请求刷新；新增 I15 跨进程用例（真实 CLI 子进程写入） | I15 PASS；`eval/run.js` I1–I15 全绿 |
| A2 | adv | suspicious 遮蔽只罩 text/value，`subject`/`predicate`/`source.quote` 原样出网 | **已修**：四字段 + quote 一并遮蔽，单一实现 `src/api/mask.js`（裁决 42） | `web-server.test.js` 逐字段断言；`/tmp` 探针复测 `SECRET-SUBJECT-POISON` 已不可见 |
| A3 | adv | `/api/records?q=` 过滤发生在 limit 截断之后且导出无序 | **已修**：`exportRecords` 截断前按 `createdAt`+`id` 排序（裁决 44） | `events-query.test.js` 稳定性断言；`/api/records` 结果可复现 |
| A4 | adv | 慢连接使 `web.close()` 挂死（默认 300s），未 `closeIdleConnections()` | **已修**：显式 `headersTimeout/requestTimeout/keepAliveTimeout` + `close()` 先 `closeIdleConnections()`；另有运行时回环断言（裁决 41） | I13 关闭路径；`createWebServer({host:'0.0.0.0'})` 抛 `E_INVALID_ARG` |

## 二、建议项（B1–B9）

| # | 处置 | 说明 |
|---|---|---|
| B1 | **已修** | `events.jsonl` 整文件读 → 本轮未做增量读，但已记录为 v0.3 演进约束（`docs/02 §3.11` 裁决 39 的注脚）；本地单用户实测 100MB/73ms/RSS 291MB，暂不阻塞 |
| B2 | **已修** | `decisionKey` 的 `ids` 排序后拼接，跨顺序同一对不再分裂计数 |
| B3 | **延期** | `static.js` 只 `lstat` 最终组件，父目录为 symlink 时不追查；威胁模型要求「本地信任仓库」，v0.2.1 加 realpath 复核 + CI 检查 ui/ 无 symlink |
| B4 | **已修** | 见 A4（超时 + `closeIdleConnections()`） |
| B5 | **已修** | 运行时回环断言（裁决 41） |
| B6 | **已修** | `// q9-allow` 必须写成 `// q9-allow: <理由>`，缺理由直接失败 |
| B7 | **部分已修** | `layoutTick` 已拆到 `ui/layout.js` 可被单测覆盖；覆盖率仍排除 `ui/**`（浏览器渲染/交互由 I13–I15 承担），理由写在 `tools/coverage-gate.mjs` 注释与 `docs/07` |
| B8 | **已修** | 见 A3；`total`/`limited` 语义未变（契约未违规，仅口径更明确） |
| B9 | **延期** | 每请求全量读 events/records 在本地单用户可接受；远程/多客户端化（v0.3）再做增量缓存 |

## 三、复验证据（2026-11-02，Node 24.21.0）

| 项 | 结果 |
|---|---|
| 单元 + 注入式 | **156 tests / 156 pass** |
| 评测 | **I1–I15 全 PASS**（新增 I15 常驻可见性） |
| 质量门禁 | **9/9**（Q9 含零构建 + 行数阈值） |
| 安全门禁 | **9/9** |
| 覆盖率 | lines 89.7% / branches 78.4% / functions 90.4%（排除 `ui/**`，理由见 B7） |
| 真实截图 | `docs/shots/` 三页（今日 / 图谱 / 卫生）由 headless Chrome 对真实 `memo serve` 截取 |
