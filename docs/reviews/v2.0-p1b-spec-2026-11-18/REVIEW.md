# P1b 抽取管线规格 · 对抗审核记录（2026-11-18）

> doc-kind: history
> doc-version: 1.4

被审对象：[docs/design/v2.0/09-extraction-pipeline.md](../../design/v2.0/09-extraction-pipeline.md)（planned，新建）
审核者：两个独立 GLM-5.3 实例（`provider=zai-coding-cn`, `model=glm-5.3`），只读实测，互不可见
- 审核者一：管线 / 并发 / 崩溃恢复视角
- 审核者二：r2 自动策略 / 评测口径 / 风险视角
参照：上位 `future-architecture.md`、`08-auto-memory-and-correction.md`（r2 权威）、`01`/`02`/`03`/`04`/`05`/`06`/`07`、`adr-101`/`adr-102`、`pilot/p1a/tools/{protocol-sim,score}.mjs`、`BASELINE.md`、`ANNOTATION.md`

## R1 结论

| 审核者 | 结论 | 问题数 |
|---|---|---|
| 一（管线/恢复） | 不通过 | 5 blocker + 7 major + 4 minor |
| 二（r2 策略/评测） | 不通过 | 2 blocker + 4 major（含 1 低） |

合计 23 条，**全部已修订**；无遗留 blocker/major。

## 审核者一：管线 / 并发 / 崩溃恢复

| 编号 | 严重度 | 发现 | 修订落地 |
|---|---|---|---|
| B1 | blocker | 决策矩阵大量用 `hold(unresolved)`，但 01 §2 状态机闭集无 `hold`；且「`reject` + `stale` 额外进 `hold`」造成同一候选双态 | 01 §2 新增「hold 不是状态」澄清：候选保持 `pending`，`workflow.hold` 落注解（含 reason/decidedAt/policyVersion/unresolved）；删除 reject+hold 二义，stale 走 `failed` 或新候选版本（§4） |
| B2 | blocker | sourceEpoch 撤销与 R7 提交的竞态未覆盖：CAS 三元组不随撤销变化，撤销发生在 R6→R7 之间仍会提交 | 09 §8「锁内核验四项」：CAS 之外**必须重查全部 evidence 的 sourceEpoch 有效性**，失效 → 批量 `cancelled(source-revoked)`；新增 T-A17；02 §4 同步补第 4/5 条 |
| B3 | blocker | 纠正匹配键 `scope+subject+predicate` 在 01 不可实现（01 只有 scope/about/claim）；`speaker=quoted`、`status` 也不在 01 枚举 | 01 §1 新增 planned 扩展字段 `assertion.subject/predicate/value` 与 `speaker=quoted`；09 §7 声明依赖并给出退化匹配（`correctionMatcher=degraded`）；列入 §11.1 重冻结清单 |
| B4 | blocker | 恢复对账「按 opId + 决策记录对比真相层末尾版本」信息缺口：真相层记录不带 opId，无法反查；`recovery-required` 判定无边界 | 01 §3 提交点补「真相层记录必须带 opId + candidateId + revision」；09 §8 给出四分支判定树（收据在/无记录/有记录/对不上）；T-A13 按树断言 |
| B5 | blocker | 决策矩阵不穷尽：「全过但超配额」不命中任何行；「异议可消解」无落点 | 矩阵补第 7 行（超配额 → `policy-blocked` 停机）与第 8 行（可消解异议 → 纠正是后重新入阵）；新增「穷尽性」条款：未命中即 fail-closed 抛错入审计 |
| M1 | major | stale 落点与 02 §4 冲突（02 写 `failed`，09 写 `rejected`+hold） | 09 §4 对齐 02：stale → `failed(evidence-unsupported)` 或重新圈定出新候选版本，**不叠加 hold**；矩阵第 1 行同步 |
| M2 | major | 「失败枚举（进 01 §3.4）」悬空（01 无 §3.4）；`recovery-required` 被放进失败枚举列，而 01 枚举闭集不含它 | 引用改「01 §3.1 末」；`recovery-required` 移出失败枚举，标注 opId 级标记；01 枚举标题改为「对齐上位 §3.4」并显式声明该点 |
| M3 | major | `decider`/`opId` 与 01 的 `decidedBy`/`acceptOpId` 命名不一致，schema 校验对不上 | 09 §6 决策记录处写明映射 `decider ≡ workflow.decidedBy`、`opId ≡ workflow.acceptOpId` |
| M4 | major | T-A2/T-A7/T-A10 依赖未定义接口（query/asOf/permission/pack），无上下文实现者写不出断言 | 新增 §10.0 桩接口契约表（8 个签名 + 用途 + 归属），把 pack/asOf/权限面变成可断言桩；T-A2/T-A7/T-A10 改用桩调用 |
| M5 | major | T-A1/T-A6 是否定存在断言，被否定对象（promote 入口、待办队列）未定义 → 同义反复 | 改写为可执行形式：T-A1 = `truthRecords().every(trust==='T2')` + `trustWrites()` 无非 T2 写入；T-A6 = `holdAnnotations()` 出现 + `queueAssets()` 为空 |
| M6 | major | 遗漏并发两 run / 同一候选两次决策（上位 §3.5 要求） | §8 补「并发两条 accept → 锁串行化，第二条 CAS 冲突」；新增 T-A18 |
| M7 | major | 遗漏审计写入失败处理（01 要求候选与审计先持久化） | §8 补 fail-closed 条款：审计未落盘不得追加真相层，op 标 `audit-pending` 并补偿重放 |
| m1 | minor | 「补快照」由谁触发未写，与 02 §3「禁止自动重新 capture」边界模糊 | 09 §4 与 02 §4 第 5 条：只允许**未撤销 epoch** 的显式重新授权导入；禁止从备份复活 |
| m2 | minor | `extractionRunKey` 含 model 而 candidateId 不含，跨模型同 claim 路径未提 | §2 补「跨 runKey 同 claim → 写入幂等 noop，provenance 首写为准；不许写成修订」 |
| m3 | minor | R0 无失败枚举；R1 行未出现 `no-recordable-content` | §1 表：R0 补 `config-missing`/`range-invalid`；R1 补 `no-recordable-content`（非错误，进统计） |
| m4 | minor | 「七类严重错误」未显式引用闭集，口径易漂移 | §11.4 明确引用 [04 §4] 闭集 |

审核者一正面核查：锁边界（R1 锁外/R7 锁内）、`extractionRunKey` 派生与 01 §3.1 一致、R6 决策带 `expectedTruthRevision` 与 01 一致、r2 无人工硬前置、§3 证据逐码点规则扎实、§9 与 07 衔接正确。

## 审核者二：r2 策略 / 评测口径 / 风险

| 编号 | 严重度 | 发现 | 修订落地 |
|---|---|---|---|
| 1 | blocker | §11.3 未钉死参考集（存在两套不可混用 gold：语料内嵌 347 vs goldset-v1 778），可实现者自选「顺手」参考集自评通过；且无防自我循环条款 | §11.3 三条硬约束：① 报告写死 `goldsetVersion + annotationMode + 匹配规约版本`（goldset-v1 / model-dual-blinded / pairing@v1），P1b 期间禁止换集；② 被测模型不得与盲评/judge 同族，否则声明同源偏差且不得单独作为放行依据（须叠加 T-A19 确定性交叉验证）；③ 必附 `confirmedByBoth` 比例（当前 5.6%）并据此限定结论强度 |
| 2 | blocker | 「允许以 protocol-sim 桩通过」+ 放行条件只写「16 条全绿」= 桩绿灯通道（§11.6 只防工具绿灯） | 新增 §10.1「桩通过 ≠ 放行」：桩全绿仅 TDD 中间态；放行要求真实现全绿 + 回填构建物与日志；§11.2 同步 |
| 3 | 中 | 四类严重错误（角色错归/否定反转/建议变批准/未做变已做）在生产管线无 reject 路径，只靠评测兜底 | 新增 §5「R4.5 断言框架机判」五项确定性核对 → `reject(assertion-mismatch)`；矩阵第 5 行；T-A19 构造四类反例；并如实声明语义级误归属仍靠 R4/评测兜底 |
| 4 | 中 | stale 决策定为 reject 且「额外进 hold」，与单值枚举 decision 冲突；§4 与 §6 语义混写 | 由 B1/M1 一并解决：stale → `failed`，不叠加 hold；decision 枚举保持 `accept|reject|hold` 单值 |
| 5 | 中 | 多条测试在同义反复边缘（T-A15 无可观测判据、T-A9 依赖桩内置分类器、T-A6 测不存在性），缺负对照 | T-A15 改为「事件计数与普通文本 run 逐字节一致」；新增 §10.2 变异自检（两个破损实现必须让保护测试变红）；T-A7/T-A8 改为逐字比对具体返回值 |
| 6 | 低 | 07 与 09 术语未互指（07 的 success/failure/missing/degraded vs 09 的 incomplete/missing/degradedReason） | §9 显式声明「本表即 07 §4 所指 P1b 冻结 schema 的抽取/决策部分」，并给出枚举映射；07 侧后续同步一行引用 |
| 风险1 | — | hold 不入分 → precision 虚高（难例全判冲突则 P/R 双高） | §11.3 明确 **hold 一律计 FN**（保守口径）+ 单独必报 hold 率 |
| 风险2 | — | 保守抽取 + 参考集粒度噪声 → 全指标虚高 | §11.3 要求按家族分层 recall 下界（bootstrap 聚类）+ 放行前冻结命题粒度规范 |

审核者二正面核查：§6 与 08 的 r2 语义逐行等价、无偷设人工环节（stale 圈定显式标可选不阻塞）、§7 与 08 §3 同构且要求纠正走全链、§2 不静默截断、§3 逐码点、§4 禁 fuzzy、§8 不盲写、§9 缺数不填 0、§11.6 继承「工具绿灯≠质量通过」。

## 修正后自检

| 项 | 结果 |
|---|---|
| 决策矩阵穷尽性 | 9 行，含超配额与可消解异议；未命中即 fail-closed |
| hold 表达一致性 | 01 §2 注解（候选仍 pending）↔ 09 §6 决策记录 ↔ T-A6 断言，三处一致 |
| 撤销竞态 | 09 §8 锁内核验四项 + 02 §4 第 4 条 + T-A17 |
| 恢复对账 | 真相层带 opId（01 §3）+ 09 §8 四分支判定树 + T-A13 |
| 参考集口径 | goldset-v1 / model-dual-blinded / pairing@v1 钉死；禁换集；同源偏差声明；hold 计 FN |
| 桩绿灯 | §10.1 + §10.2 变异自检 |
| 测试可证伪 | 19 条全部给最小可执行断言；8 个桩接口已定义 |

## 保留门禁

- push/PR 前的对抗审核已完成一轮；P1b 实现落地时按 [docs/11](../../11-doc-governance.md) 对 `pilot/p1b/**` 与规格改动再做一次 delta 复核（R2），结论并入本文件补充节。
- 本文件不构成 P1b 质量通过证据：`exit-check` 与桩测试全绿均不代表抽取质量达标（§11）。
