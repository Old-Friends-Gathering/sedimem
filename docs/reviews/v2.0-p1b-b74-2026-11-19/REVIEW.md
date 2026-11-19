# B7.4/B7.5 对抗审核记录（R4 异议生成器 + 聊天纠正七类 matcher）

> doc-kind: history
> doc-version: 1.4

- 审核对象：`pilot/p1b/tools/objection.mjs`、`pilot/p1b/tools/corrections.mjs`、`pilot/p1b/tools/pipeline.mjs` 的 `resolveObjection()` / `correct()` / `decide()` 异议入口 / `evaluate()` reason 语义；规格 `docs/design/v2.0/09-extraction-pipeline.md` §5/§7。
- 审核员：独立实例（GLM-5.3，只读仓库 + `/tmp` 副本探针），与实现方互不可见。
- 结论：**不通过（blocker 0 / major 4 / minor 6）** → 全部修订后复跑；R2 delta 见文末。

## R1 意见与修订对照

| 编号 | 严重度 | 位置 | 发现 | 修订 |
|---|---|---|---|---|
| M1 | major | `pilot/p1b/tools/pipeline.mjs` decide() | 不可消解异议对决策零影响：只有 `resolvable:true` 才走行 8，`temporal-drift` / 不可消解 `quote-value-mismatch` 的候选照样 `accept(policy-accept)`（探针 P1） | `decide()` 增对称拦截：`objection.resolvable === false && 决策 accept` → 转 `hold(unresolved)`，`rulesHit` 记 `objection-unresolvable`，结果带 `objectionKind`；新增 T-C29 回归 |
| M2 | major | `pilot/p1b/tools/objection.mjs` CORRECTION_MARKERS | 可消解判据用裸「不是」子串，正文「端口不是 9090（维持 8080）」即可把已提交 8080 supersede 成 9090（探针 P2）；且只检查第一个声明数字 | 标记收紧为「不是…而是/应…」或显式改写词；可消解要求**全部**声明数字都在正文/引文出现；规格 §5 同步 |
| M3 | major | `pilot/p1b/tools/pipeline.mjs` correct() | 修订值无证据绑定：新值 9999 的修订记录可 commit，其 `evidenceHash` 指向不含 9999 的旧引文（探针 P5a） | `correction` 要求新值出现在某条证据引文中，否则 `reject(evidence-unsupported, detail=new-value-not-in-evidence)`；新增 T-C30；规格 §7 同步 |
| M4 | major | `pilot/p1b/tools/corrections.mjs` newValue | `nums.find(n => n !== 旧值)` 抓全文第一个不同数字：「超时改成 30 秒了，端口应为 8081」→ newValue=30，supersede 端口为 30（探针 P4a） | 改为在更正标记后 40 字符窗口内取数字（排除旧值），再退化为全文；规格 §7 记录窗口口径 |
| m1 | minor | pipeline decide() | `replayObjection` 无门禁，生产调用可直接注入异议（探针 P5b） | 新增 policy `allowReplayObjection`（默认 false），未开启抛 `E_REPLAY_NOT_ALLOWED`；T-C25 显式开启 |
| m2 | minor | objection.mjs numbersIn | `v2.0`/`2`、`30.0`/`30` 同值不同写法触发误报 | 数字归一（去版本前缀、按数值化）后比较 |
| m3 | minor | corrections.mjs pickTarget | 打分无下限，一个 bigram 重合即命中 → 多同名记录可能 supersede 错目标 | `pickTarget` 阈值 ≥2（重合 + 值命中），低于阈值视为无目标 |
| m4 | minor | pipeline.mjs DECISION_ROWS | 常量是装饰性的（evaluate 硬编码），T-C10/T-C16 同义反复 | `rowDecision(n)` 成为决策来源，`evaluate()` 返回 `row`；新增 T-C31 断言九行命中序与决策映射 |
| m5 | minor | corrections.mjs 输出 | 规格写 `confidence` 字段，代码没有 | 补确定性 `confidence`（exact 0.9 / degraded 0.6），不做概率推断 |
| m6 | minor | pipeline correct() | 无 `sourceScope` 时跨项目纠正可伪造 `${scope}#foreign` 直接 accept | 未配置 `sourceScope` 时 fail-closed：`reject(cross-scope-leak, source-scope-unbound)` |

## 探针复现（R1 实测，均在 `/tmp` 副本）

| 探针 | 构造 | 修复前 | 修复后 |
|---|---|---|---|
| P1a/P1b | `assertedValidFrom` 晚于证据 ts；引文 8080 声明 9090 无更正式 | `accept(policy-accept)` | `hold(unresolved)` + `objectionKind` |
| P2 | 正文「端口不是 9090（维持 8080）」+ value=9090 + 干净引文 | `accept(correction-applied)`，8080 被 supersede | `hold(unresolved)`（无「不是…而是」标记） |
| P4a | `超时改成 30 秒了，端口应为 8081` | `newValue=30` | `newValue=8081`（窗口内） |
| P5a | `correct(text='端口应为 9999', evidence=旧引文 8080)` | accept+commit（证据悬空） | `reject(evidence-unsupported)` |
| P3 | value=2 / quote=`v2.0`；value=30 / quote=`30.0` | `quote-value-mismatch` 误报 | 不产异议 |
| P5c | 同文本 `correct()` 两次 | 第二次 noop（正面） | 仍 noop（正面） |

## 修订后验证

- `node --test pilot/p1b/tests/*.test.mjs` → **128 条全绿**（objection 7 / corrections 9 / pipeline 40 / evidence 10 / assertion-checks 22 / pipeline-events 21 / r2-* 19）
- `node --test pilot/p1a/tests/*.test.mjs pilot/p1b/tests/*.test.mjs` → **287 条全绿**
- quality 15/15、security 9/9、docs-drift 无 finding（44 文档）
- 规格同步：09 §5（效力对称/可消解判据/数字归一/回放门禁）、§7（证据绑定/newValue 窗口/目标阈值/无人值守部署）

## 保留门禁

- 本批只证明「异议与纠正链路的机制正确」，**不代表** P1b 质量通过：参考集重跑与七类严重错误零容忍复核仍在 B7.6。
- `correct()` 的 `quote`/`assistant-claim`/`tool-failure` 三类只落「不覆盖既有值」的候选形态，其真实语义覆盖仍需 B7.6 用参考集验证。
- 矩阵九行的**语义正确性**仍依赖 R4 生成器与 R4.5 断言机判两条独立实现；二者同源偏差须在 REVIEW 声明。

## R2 delta 复核

（待填）
