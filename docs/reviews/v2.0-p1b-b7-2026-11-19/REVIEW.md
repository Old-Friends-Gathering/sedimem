# B7 审核记录：P1b 真管线（R2 对抗审核 + 修订）

> doc-kind: history
> doc-version: 1.4

审核对象：`pilot/p1b/tools/pipeline.mjs`、`pilot/p1b/tools/assertion-checks.mjs`、`pilot/p1b/tools/evidence.mjs`、`pilot/p1b/tools/pipeline-events.mjs` 与 `pilot/p1b/tests/`。
上位规格：[09-extraction-pipeline](../../design/v2.0/09-extraction-pipeline.md)（§5 R4.5、§6 决策矩阵、§8 提交/并发/恢复）、[01-candidate-schema](../../design/v2.0/01-candidate-schema.md)（§2 状态机、§3 幂等）。
审核轮次：R2（实现级对抗审核）→ 修订 → R3（delta 复核）。

## R1：审核结论

**不通过：blocker 1 / major 10 / minor 5**（当时 64 条 p1b 测试全绿，但多项规格行为只在测试注入的 ctx 后门上成立）。

| 编号 | 严重度 | 发现 | 依据 |
|---|---|---|---|
| B1 | blocker | 跨 runKey 同 claim 不 noop（candidateId 含 rangeId/inputHash），同一事实可两次进真相层 | 09 §2「跨 runKey 同 claim 仍是 noop」；探针：r1/r2 两次 ingest 均 created=1，最终 truth 2 条 |
| M1 | major | 行 2「跨 scope」仅靠 `ctx.targetScope` 后门，真实路径不可达 | 09 §6 行 2；探针：truth 有 `repo:other` 同 subject，decide 无 ctx → accept |
| M2 | major | 行 4「identity-unknown」同为后门，`role:null` 证据直接 accept | 09 §6 行 4；探针：role 缺失仍 accept |
| M3 | major | 行 8（可消解异议）排在行 6/7 之前，绕过冲突 hold 与配额停机；「重入」只是注释 | 09 §6「自上而下命中即停」；探针：超配额+可消解异议 → accept |
| M4 | major | R3 不查 epoch 撤销（§3 第 5 条前半句缺失） | 09 §3；探针：revokeEpoch 后 decide → accept |
| M5 | major | audit-pending 不阻塞后续新写入 | 09 §8；探针：failAuditOnOp('op-1') 后 op-2 正常提交 |
| M6 | major | CAS 三元组中 evidenceHash 完全不参与比较 | 09 §8；探针：expected.evidenceHash='WRONG' 仍 committed |
| M7 | major | `maxCasRefresh` 是空转循环，无真实刷新重评 | 09 §8；探针：刷新计数增加但状态与版本不变 |
| M8 | major | reconcile 的 `revision-mismatch` 分支不可达；补收据不校验 revision/evidenceHash | 09 §8 恢复对账 |
| M9 | major | 否定标记子串匹配误报：`note`/`cannot`/`没错` 被判否定 | 09 §5 表第 2 行「含否定标记」——标记是词不是子串 |
| M10 | major | complete 把「完成了吗」当用户确认（未做变已做漏报） | 09 §5 表第 4 行 |
| m1 | minor | 两套断言实现不一致，且 `assertion-checks.mjs` 从未被管线引用 | 09 §5 |
| m2 | minor | inline 的 suggest 检查加了规格没有的反向判据，过度拒绝 | 09 §5 表第 3 行 |
| m3 | minor | `commit` 的 epoch 复查读 `c.meta.sourceEpoch`，但 ingest 从不拷贝该字段 | 09 §8 |
| m4 | minor | T-C10 穷尽性测试是同义反复（`forceUnmatched` 后门） | 09 §6 |
| m5 | minor | relations 未落真相层；candidateVersion 恒 1，无修订递增路径 | 01 §3、09 §8 |

已核验通过（不改动）：`evidence.mjs` 的 R3 核心机判（quote 非 span 前缀、span 切代理对、quote 二义、越界、快照 stale/缺失、quote>200、全码点计数）；同 opId 重放幂等；R7 锁内 epoch 复查优先于 CAS；隔离候选不进读取面；accept 不提权（truth 恒 T2）；`pipeline-events` 与 §9 枚举映射一致；`amountCny` 必填键、成本未知用 `null` 且绝不填 0。

## R2：修订落地对照

| 编号 | 修订 | 落点 |
|---|---|---|
| B1 | 引入 `semanticKey()`（scope+subject+predicate+value+归一 claim），ingest 先去重：已提交 → `noop(already-committed)`；已有候选 → `noop` | `pilot/p1b/tools/pipeline.mjs` `ingest()` |
| M1 | 行 2 改为真实判据：候选 `scope` ≠ 来源绑定 `sourceScope`，或真相层存在同 subject/predicate 异 scope 记录 | 同上 `evaluate()` 行 2 |
| M2 | 行 4 改为证据事件 `role` 缺失或不在 `user/assistant/tool/tool:*` 闭集 | 同上 行 4 |
| M3 | 行 8 移到行 1–7 之后；命中即 `relations.push(supersedes)` + `version += 1` + **真重入** `evaluate()`；行 6 冲突可被 supersede 关系消解（`conflict-superseded`） | 同上 `decide()` / `evaluate()` 行 6 |
| M4 | 行 1 开头查 `revoked` → `evidence-unsupported(source-revoked)` | 同上 |
| M5 | `commit()`：`auditPending.size>0 && !has(opId)` → `E_AUDIT_PENDING`；`reconcile()` 解除 | 同上 |
| M6 | `casMatch()` 三元组含 `evidenceHash` | 同上 |
| M7 | 刷新循环内真实重跑 `decide()` 且 `version += 1`；超 `maxCasRefresh` 转 `hold(cas-conflict)` 并记录 `refreshed` | 同上 |
| M8 | `reconcile()` 分支：`receipt-repaired` / `no-record-for-op` / `duplicate-records` | 同上 |
| M9 | 否定判据改英文词边界（`\b(not|never|no|none|cannot|...)`）+ 英文短语排除（not only/not just/no longer/no doubt）+ 中文排除词占位（不仅/不但/不过/不确定/没问题/没错…） | `assertion-checks.mjs` `hasNegation()` |
| M10 | `QUESTION_RE=/[?？]|吗|呢|是否/`：含确认词但为疑问句 → 不算用户确认 | 同上 `checkComplete()` |
| m1 | 删除 inline 实现，`pipeline.mjs` 直接 `import { checkAssertion }` 作为唯一权威 | `pipeline.mjs` 头部 |
| m2 | 随 m1 一并移除 | — |
| m3 | `ingest()` 落入 `meta.sourceEpoch`，`commit()` 与 `evaluate()` 均读它 | `pipeline.mjs` |
| m4 | 删除 `forceUnmatched` 后门；穷尽性改为结构保证（`DECISION_ROWS` 9 行、决策集闭合） | `pipeline.test.mjs` T-C10 |
| m5 | 真相层记录带 `relations` 与 `candidateVersion`；修订时 `version += 1` | `pipeline.mjs` `commit()` |

测试：p1b 由 64 → **97**（pipeline 16→25，assertion-checks 17→21，其余不变），全部改为真实信号路径；pilot 全量 236/236；quality 15/15、security 9/9、docs-drift 无 finding。

## R3：delta 复核

（见下节，R3 结论回填）

## 保留门禁

- R3 delta 复核通过前不合并 PR；CI 全绿 + 分支保留。
- 桩绿灯 ≠ 质量通过（09 §10.1）：P1b 放行仍需「真实现全绿 + 参考集钉死 goldset-v1/model-dual-blinded/pairing@v1 + 七类严重错误零容忍 + 时序指标先冻结」。
- 异议生成器（R4）尚未实现：`objection.resolvable` 仍由调用方声明，属 P1b 剩余缺口，须在放行前关闭或如实列入遗留。
