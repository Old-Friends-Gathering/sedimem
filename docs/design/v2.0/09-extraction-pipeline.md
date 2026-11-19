# 09 · 证据约束抽取管线（P1b 施工规格）

> doc-kind: contract
> doc-version: 2.0
> status: planned

状态：**planned**——P1b 施工规格草案，冻结前允许修订；冻结标记由维护者在 [README](README.md) 核验表显式声明。本文不改变 v1.4 运行行为，不创建 `versions/v2.0/`，不切 `CURRENT`。

来源：[future-architecture.md](../../plans/future-architecture.md) §2（数据流）、§3.2–§3.5（候选/六道防线/崩溃提交）、§7（验收）；[策略08](08-auto-memory-and-correction.md)（r2 自动沉淀与聊天纠正，当前权威）；施工前置：[01](01-candidate-schema.md) 候选与幂等、[02](02-evidence-and-deletion.md) 证据与删除、[03](03-trust-promotion.md) 自动接纳与信任、[04](04-scoring-and-splits.md)/[05](05-threshold-manifest.md) 打分与阈值、[06](06-annotation-spec.md) 参考集、[adr-101](adr-101-tokenizer.md) 计数口径、[adr-102](adr-102-cost-quota.md) 出站与配额、[07](07-benefits-observability.md) 用量与收益事件。

> **r1 审核修订记录（2026-11-18）**：双实例对抗审核（管线/恢复视角 5B+7M+4m；r2 策略/评测视角 2B+4M+1L）共 23 条意见已全部修订，逐条对照见 [REVIEW](../../reviews/v2.0-p1b-spec-2026-11-18/REVIEW.md)。要点：hold 改为 pending 注解（不扩状态机）；R7 锁内重查 sourceEpoch；纠正匹配键落到 01 结构化断言字段；真相层记录带 `opId` 并给出对账三分支；决策矩阵补配额/可消解异议两行；放行条件禁止桩绿灯与自选参考集；hold 计入 FN；保护测试给出桩接口与可证伪化要求。

## 0. 本文负责什么、不负责什么

| 负责 | 不负责 |
|---|---|
| 抽取管线的阶段划分、每阶段输入输出与失败枚举、阶段间提交点与锁边界 | 候选字段定义（[01](01-candidate-schema.md)）、证据规范化算法（[02](02-evidence-and-deletion.md)）、信任语义（[03](03-trust-promotion.md)、[08](08-auto-memory-and-correction.md)） |
| 自动接纳/拒绝/扣留的**决策矩阵**与决策记录格式（决策者 = `policy:<version>`） | 打分器实现与门槛数值（[04](04-scoring-and-splits.md)、[05](05-threshold-manifest.md)） |
| 聊天纠正的匹配与生效规则、未决冲突的表示 | P1c 的 pack 装配与回执（另立规格） |
| r2 保护测试清单（可执行断言 + 桩接口契约）与 P1b 放行条件 | 收益看板/对照演示（[07](07-benefits-observability.md)） |

**一句话**：本文把「LLM 抽出一条候选」到「它成为可被上下文使用的结构化陈述」之间的每一步写成可测试的契约，并且**全程不需要用户逐条确认**。

## 1. 阶段与数据流

```
R0 范围确定 → R1 锁外抽取 → R2 结构校验 → R3 证据核对 → R4 语义核对
   → R5 冲突/纠正判定 → R6 自动决策 → R7 锁内核验+真相层追加（提交点）→ R8 派生失效与事件
```

| 阶段 | 输入 | 输出 | 失败枚举（闭集见 [01 §3.1 末](01-candidate-schema.md)） | 是否可重试 |
|---|---|---|---|---|
| R0 范围确定 | `sourceId`/`sourceEpoch`/游标 | `rangeId` + `inputHash`（规范化后切段 hash） | `config-missing` / `range-invalid`（fail-closed，不进候选） | 否 |
| R1 锁外抽取 | 切段文本 + 冻结 prompt/schema 版本 | `Candidate[]`（结构见 01 §1） | `timeout` / `empty-response` / `parse-failure` / `token-truncated`；`no-recordable-content`（非错误，进统计） | 是（同 `extractionRunKey` = 同一逻辑运行） |
| R2 结构校验 | 候选对象 | 通过/拒绝 + 违规字段 | `parse-failure`（schema 不合法）；`assertion-mismatch`（R4.5 机判，见 §5） | 否（改 prompt/schema 才重跑） |
| R3 证据核对 | 候选 `evidence[]` | 可定位/`stale`/缺失 | `evidence-unsupported` | 否（`stale` 只能重新圈定或补快照，见 §4） |
| R4 语义核对 | 候选 + 证据原文 | 异议列表（不裁决） | 无（异议进 R5） | 是 |
| R5 冲突/纠正判定 | 候选 + 既有记录/候选 | `relations` + 冲突分类 | 无（冲突不阻断，转 `hold`） | 是 |
| R6 自动决策 | 上述全部 | `accept` / `reject(reason)` / `hold` | `policy-blocked` | 否（决策带版本，重放走幂等） |
| R7 提交 | 决策 + CAS 三元组 + epoch 校验 | 真相层追加（带 opId）+ 收据 | 冲突 / `source-revoked` | 仅按收据重放，不新写 |
| R8 事件 | 提交结果 | audit + usage + 失效标记 | — | 是（事件投影可补） |

**R1 必须锁外、R7 必须锁内**（01 §3、上位 §3.5）：LLM 网络调用不持数据锁；锁只覆盖「核对版本 → 追加 → 写收据」这一小段。`recovery-required` **不是**候选失败枚举，它是 opId 级恢复标记（§8）。

## 2. R0/R1：范围与抽取

- R0 产出 `rangeId` 与 `inputHash` 后**先固化落盘**，再发网络请求；请求中不得携带可变游标（否则重试不可复现）。
- R1 的 prompt、schema 版本、模型标识、`configHash` 全部进 `provenance`；`extractionRunKey` 由 `(sourceId, sourceEpoch, rangeId, promptVersion, model, configHash)` 派生。
- **跨 runKey 同 claim 仍然是 noop**（对齐 [01 §3.1](01-candidate-schema.md) R2-N1 判定边界）：`candidateId` 只含内容四元组，不含 model/configHash——模型或配置变了但 claim 规范化形式相同 → 命中同一 `candidateId` → 写入幂等 `noop`，`provenance` 以**首写**为准；只有 claim 变化才走修订路径（新 ID + `supersedes`）。实现者不得把「换模型重跑」写成修订。
- 单来源候选/证据配额按 [adr-102](adr-102-cost-quota.md) 执行；超配额 → 该来源本阶段 `policy-blocked`，不静默截断（截断会让 precision 虚高）。
- **命题粒度原子性（硬要求）**：R1 输出的每条候选必须是 [06 §1.1](06-annotation-spec.md) 定义的原子命题；返回含 S1/S2/S3 形态的复合命题（并列谓词、多主谓分句、属性并列列举）视为结构校验失败 → 候选落 `schema-invalid`，不得进入 R3/R4。粒度的归一化与同一性判定（I1–I3）由 `pilot/p1a/tools/granularity-check.mjs` 提供（规则集 `granularity@v2`），实现侧必须复用同一规则集，不得自造第二套。

## 3. R3：证据存在（防线②的机判落地）

一条候选要通过 R3，必须同时满足（缺一即 `evidence-unsupported`，**不是**警告）：

1. `eventId` 在本次输入范围内存在；
2. `span` 按 [02 §2](02-evidence-and-deletion.md) 的码点/换行规则切出的子串，与该事件规范化文本**逐码点相等**；
3. 该事件文本的 `hash` 与快照一致；快照缺失但可重新定位时按 §4 规则处理；
4. span 不得跨事件边界；`quote ≤200` 字符且是切出子串的前缀；
5. 证据所在的 `sourceEpoch` 未撤销（R3 查一次，**R7 锁内必须再查一次**，见 §8）。

> 反例（必须被拒绝）：quote 是从**另一次**会话复制的相似句；span 指向助手转述用户原话的位置；多字节字符只覆盖半个 surrogate pair；用 UTF-16 `indexOf` 判定「原文包含」冒充码点 span（`score.mjs` 的 `evidenceSevere` 即此类，P1b 保护测试不得复用它判定 R3 通过）。

## 4. 快照缺失、stale 与重新定位

- 快照缺失 + 源文件 hash 不匹配 → 证据标 `stale`；该候选**不得 accept**，按 [02 §4](02-evidence-and-deletion.md) 转 `failed`（`evidence-unsupported`）**或**退回重新圈定证据后以**新候选版本**重走复核——只有这两条路。
- **禁止 fuzzy re-anchor**：不得按相似度把 offset 挪到新文本的「大概位置」。
- 「补快照」的边界：只允许对**未撤销 epoch** 的显式重新授权导入；撤销后禁止自动重新 capture（[02 §3](02-evidence-and-deletion.md)），也不得把旧快照从备份复活为可读面。
- stale 候选**不叠加 hold 注解**（避免「既 reject 又 hold」的二义）；可选的人工重新圈定是独立动作，不阻塞其他任务。

## 5. R4 语义核对：只提异议，不当裁判

- 第二模型（或规则集）对候选提出异议：主语错、否定反转、条件丢失、时间错位、把建议当决定、把未做当已做。
- 异议**不直接 reject**，进入 R5：可消解的走纠正（追加 `relations`）；不可消解 → `hold`。
- 审查者与被审查者若为同一模型/同一 prompt 版本，报告必须声明「同源偏差未排除」（[08 §5](08-auto-memory-and-correction.md)）。

**R4.5 断言框架机判（r1 审核新增，把四类严重错误拉进生产阻断路径）**：七类严重错误中「角色错归 / 否定反转 / 建议变批准 / 未做变已做」在评测期靠 [04 §4](04-scoring-and-splits.md) 兜底，但生产管线不能只靠模型异议。R4.5 对 `assertion` 与证据原文做**确定性核对**，任一项不符 → `reject(assertion-mismatch)`：

| 核对项 | 判据（机判，不看语义相似度） |
|---|---|
| `speaker` | 证据所在事件的 role 与 `speaker` 一致；`tool:<name>` 必须匹配工具名；转述/引用位置不得标 `user`（应 `quoted`，见 [01 §1](01-candidate-schema.md)） |
| `negated` | 引文含否定标记（`不/未/没有/never/not/no`）与 `negated=false` 矛盾，或引文无否定标记而 `negated=true` |
| `speechAct=suggest` | 引文含建议式（`建议/可以/不妨/could/should`）且 `status` 不是 `suggestion-only|conditional` |
| `speechAct=complete` | 候选 `type=task-state` 且证据必须是工具输出或用户直接确认；助手自称完成不得 `complete` |
| `speechAct=retract` | 引文含撤回式；`status` 必须 `retracted` |

> 取舍声明：这五条只能挡住**可机判**的形态错误；语义级误归属仍由 R4 异议 + 评测兜底。该取舍写入 §10 的 T-A19 断言（构造四类反例，断言 `reject(assertion-mismatch)`）。

## 6. R5/R6：自动决策矩阵（r2，替代人工复核）

**判定顺序**（自上而下，命中即停；矩阵必须穷尽，见下方「穷尽性」）：

| # | 条件 | 决策 | `reason` | 后续 |
|---|---|---|---|---|
| 1 | 证据不可定位 / 跨 epoch / 快照 stale | `reject` | `evidence-unsupported` | 候选转 `failed`；进评测负例 |
| 2 | 跨 scope 主体 / 同名但 scope 不同 | `reject` | `cross-scope-leak` | 记入对抗统计 |
| 3 | 注入疑似（正文含指令、越权请求、隐藏指令） | `reject` + 隔离 | `injection-suspected` | 进 quarantine，不进任何读取面；与成本停机 `policy-blocked` 分开统计 |
| 4 | 身份/角色不明（无法判定 speaker） | `reject` | `identity-unknown` | 记统计 |
| 5 | 断言框架机判不符（§5 R4.5） | `reject` | `assertion-mismatch` | 记入四类严重错误统计 |
| 6 | 与既有记录语义冲突且不可消解 | `hold` | `unresolved` | 写 `workflow.hold` 注解（候选仍 `pending`）；读取面标不确定；**不生成人工待办** |
| 7 | 检查全过但来源/运行超配额（[adr-102](adr-102-cost-quota.md)） | `reject` + 停机 | `policy-blocked` | 该来源本阶段停机，待配额恢复；不静默降级为规则档 |
| 8 | 异议存在但**可消解** | 走纠正路径 | `correction-applied` | 生成 `relations`（`supersedes`/`contradicts`）后**重新进入矩阵**第 1 行 |
| 9 | 通过全部检查且未超配额 | `accept` | `policy-accept` | 追加真相层（带 opId），trust 仍 T2（不提权） |

**穷尽性**：任一输入必然命中恰好一行——第 8 行显式兜住「可消解异议」，第 7 行兜住「全过但超配额」；若出现未命中任何行的输入，实现必须 fail-closed 抛错并入审计（不得默认放行）。

决策记录（与候选同锁写入，作为收据的一部分；字段名映射：`decider ≡ 01.workflow.decidedBy`，`opId ≡ 01.workflow.acceptOpId`）：

```jsonc
{
  "opId": "ulid",
  "decider": "policy:auto-memory-r2/1",   // 策略版本，改动须版本化 diff
  "decision": "accept|reject|hold",
  "reason": "policy-accept",
  "rulesHit": ["evidence-ok", "scope-ok", "no-conflict"],
  "inputHash": "sha256:...",
  "candidateVersion": 3,
  "evidenceHash": "sha256:...",
  "expectedTruthRevision": 42,
  "decidedAt": "2026-11-18T12:00:00Z"
}
```

- **`accept` 不等于提权**：不写 T0/T1、不增加 `taint` 信任、不授予工具/出站/权限能力（[03](03-trust-promotion.md)、[08 §2](08-auto-memory-and-correction.md)）。
- 决策矩阵的**任何**改动都是策略版本变更：新 `decider` 字符串 + manifest 版本化 diff + 回归全部保护测试。

## 7. R5：聊天纠正规则

**匹配键** = `scope + subject + predicate`（+ 业务时间区间）。依赖 [01 §1](01-candidate-schema.md) r2 扩展的结构化断言字段（`assertion.subject`/`predicate`/`value`）——这两个字段在 01 中为 planned 扩展，**属 §11.1 重冻结清单**；未落地前纠正只能按 `scope + about + 文本规范化` 退化匹配，并在 run 事件里标 `correctionMatcher=degraded`。

| 后续输入 | 处理 | 禁止 |
|---|---|---|
| 用户直接更正（「刚才说错了，端口应为 8081」） | 追加新版本（`supersedes`），旧值在当前读取面失效，历史 `asOf` 仍可查 | 不得就地改写旧记录 |
| 用户说「先别改，仍用 8080」 | 把前一变更标 `retracted`/未生效（`status=retracted`） | 不得视为对新值的确认 |
| 引用他人/文档/代码示例/远程内容 | `speaker=quoted`，不覆盖用户既有事实 | 不得当作用户更正 |
| 同名主体但不同 scope/项目、或不同有效时间 | 允许并存 | 不得跨边界覆盖 |
| 工具失败/退出码非 0 | 只更新该次执行状态（`task-state`，`status=not-done`） | 不得泛化为「该项目全部失败/成功」 |
| 助手自称「已完成」，无工具或用户直接证据 | 记为助手声称（`speaker=assistant`，`speechAct=state`） | 不得升级为已确认完成 |
| 两个合法来源冲突且关系不可判定 | 双方进 `disputed`/`unresolved`（`workflow.hold`），退出肯定回答 | 不得猜赢家、不得发人工审批请求 |

纠正同样走 R2–R7 全链（证据、scope、幂等、CAS、epoch），**不因「是纠正」而跳过校验**。

## 8. R7：提交、并发与恢复

- 提交点 = 真相层成功追加（[01 §3](01-candidate-schema.md)）；真相层记录必须带 `opId` + `candidateId` + `revision`（反查前提）。
- **锁内核验四项**：CAS 三元组 `candidateVersion + evidenceHash + expectedTruthRevision` **之外**，必须重查全部 evidence 的 `sourceEpoch` 有效性。撤销发生在 R6 决策后、R7 追加前时，CAS 全部通过也要拦截：候选批量转 `cancelled`（`reason=source-revoked`），不写真相层（[02 §3/§4](02-evidence-and-deletion.md)）。
- CAS 不匹配 → 自动刷新重评（次数/时间受 policy 限），**不盲写**；刷新后仍冲突 → `hold`。
- **并发**：两个并发 accept（不同 `opId`）同一候选 → 数据锁串行化，第二个执行时 CAS 冲突（`candidateVersion` 已变）→ 刷新重评；不得出现两条真相层记录。
- **审计持久化失败 = fail-closed**：审计未落盘不得进真相层追加；落盘失败 → 该 op 标 `audit-pending`（opId 级），启动补偿重放，期间不得提交新写入。
- **恢复对账判定树**（收据缺失时按此三分支，禁止猜）：

```
收据存在（opId → 目标记录）        → noop-receipt（返回已有结果）
收据缺失 且 真相层无该 opId 记录    → 允许重放（同 opId，产出仍幂等）
收据缺失 且 真相层有该 opId 记录    → 视为已提交，补写收据（不重复追加）
对不上（记录存在但 revision/evidenceHash 不符）→ recovery-required：
    扣留该 op、显示错误、不自动重试成新写入、不阻塞其他任务、不升级为人工硬前置
```

- `noop`/`merge` 必须留持久收据（`opId → 目标记录`），重放不得产生第二条事实。

## 9. R8：事件、用量与降级（接 [07](07-benefits-observability.md)）

**本表即 [07 §4](07-benefits-observability.md) 所指「P1b 实施前冻结的字段 schema」中的抽取/决策事件部分**；字段变更走版本化 diff，并与 07 同步。每次运行必须落三类事件，缺一即视为该 run 不可用于效果结论：

| 事件 | 关键字段 | 缺失时 |
|---|---|---|
| `extraction` | `runId`、`rangeId`、阶段耗时、候选数、失败枚举计数 | run 状态 `incomplete`（≈07 的 `missing`，两处枚举映射见下） |
| `usage` | 输入/输出 token（adr-101 口径）、计价版本、费用、重试次数 | 标 `missing`，**不得填 0** |
| `decision` | opId、decider、reason、rulesHit、结果 | run 不可用于质量结论 |

枚举映射（消除与 07 的术语漂移）：`incomplete → missing`（07 视角）、`policy-blocked → failure`、`degradedReason → degraded`；07 的 `success` 对应本表「三事件齐全且无阻断」。

降级必须显式：语义道未启用 → `degradedReason=semantic-disabled`；模型不可用 → 该 run `policy-blocked`，不许规则档结果冒充 LLM 档成绩。

## 10. r2 保护测试清单（P1b 开工前置，可执行）

> **落地状态（2026-11-19）**：T-A1..T-A19 已实现为可执行测试，载体 `pilot/p1b/tests/r2-*.test.mjs` + 模拟器
> `pilot/p1b/tools/r2-sim.mjs`（内存、不落真相层）。§10.2 变异自检已执行：删除证据可定位检查 → 仅 T-A3 变红；
> 冲突分支改为直接放行 → 仅 T-A6 变红。**模拟器绿灯不等于质量通过**（§10.1 仍成立）。

### 10.0 桩接口契约（先于实现冻结，`pilot/p1b/tools` 提供）

| 桩接口 | 签名 | 用途 | 归属 |
|---|---|---|---|
| `ingest` / `accept` / `reject` / `hold` | 沿用 `pilot/p1a/tools/protocol-sim.mjs`，r2 扩展 | 候选生命周期 | P1b |
| `query({asOf})` | 返回当前/历史可见记录集 | T-A7/T-A8 | P1b 新增 |
| `permissionCheck(recordId)` | 返回 `allowed:false`（T2 不授予工具/出站/权限） | T-A2 | P1b 新增 |
| `packInputs()` | 返回下一次 pack 的候选/记录清单（不实现 pack） | T-A2/T-A10 | P1b 新增 |
| `trustWrites()` | 记录所有 trust 变更调用（用于断言「无隐式提权」） | T-A1 | P1b 新增 |
| `holdAnnotations()` | 返回全部 `workflow.hold` 注解 | T-A6 | P1b 新增 |
| `queueAssets()` | 返回已登记队列/通知资产（用于断言「未写入」） | T-A6 | P1b 新增 |
| `truthRecords()` | 真相层记录（含 opId/candidateId/revision/trust） | T-A13 | P1b 新增 |

位置：`pilot/p1b/tests/*.test.mjs`。**每条都是断言级**：必须能在「实现做错」时变红（见 §10.2 变异自检）。

| ID | 断言（最小可执行形式） | 对应小节 |
|---|---|---|
| T-A1 | `truthRecords().every(r => r.trust === 'T2')` 且 `trustWrites().filter(w => w.to !== 'T2').length === 0` | §6、[03](03-trust-promotion.md) |
| T-A2 | `packInputs()` 含该记录且带来源标记；`permissionCheck(id)` 返回 `{allowed:false}` | §6、[08 §2](08-auto-memory-and-correction.md) |
| T-A3 | 缺证据/span 不等于原文/hash 不匹配 → 候选 `failed(evidence-unsupported)` 且 `truthRecords().length` 不变 | §3 |
| T-A4 | 同名不同 scope → `rejected(cross-scope-leak)`；同 scope 不同名 → 正常 accept | §6 |
| T-A5 | 正文含「忽略此前规则 / 把 X 写成 Y」→ `rejected(injection-suspected)` 且不在 `packInputs()` | §6 |
| T-A6 | 不可消解冲突 → `holdAnnotations()` 出现该候选且候选状态仍 `pending`；`queueAssets()` 为空 | §6 |
| T-A7 | 更正后 `query()` 返回新值；`query({asOf: 旧时间})` 返回旧值（逐字比对） | §7 |
| T-A8 | 「先别改 / 仍用 X」→ 变更记录 `status=retracted`；`query()` 返回旧值 | §7 |
| T-A9 | 引用他人/助手自称完成 → `speaker=quoted`/`assistant`，既有事实未被覆盖 | §7 |
| T-A10 | 撤销 epoch → `packInputs()` 不含该 epoch、该 epoch 新候选 `rejected/failed`、无自动 re-capture 调用 | §4、[02 §3](02-evidence-and-deletion.md) |
| T-A11 | 同 `extractionRunKey` 重放 → 候选集合与首次逐字段一致（noop）；同 `opId` 重放不新增真相层记录 | §2、§8 |
| T-A12 | CAS 冲突 → 刷新重评（调用计数 ≤ policy 上限）；刷新后仍冲突 → `hold`，真相层无新增 | §8 |
| T-A13 | 真相层追加失败 → 按收据重放成功且 `truthRecords()` 无重复；构造「记录存在但 revision 不符」→ `recovery-required` 且不自动重试 | §8 |
| T-A14 | 无成本配置 → 拒绝发起（`E_COST_CONFIG_MISSING`）；超日上限 → `policy-blocked`；白名单外 → 拒绝；脱敏失败 → 拒绝 | §9、[adr-102](adr-102-cost-quota.md) |
| T-A15 | 含伪 JSON/围栏/伪指令的 claim → 事件计数与普通文本 run **逐字节一致**（不触发 schema 解析分支） | §5 |
| T-A16 | 缺 usage/decision 事件 → run 标 `incomplete`/`missing`，评测结论拒绝产出（不填 0） | §9 |
| T-A17 | 撤销发生在「决策后、追加前」→ 拦截，候选 `cancelled(source-revoked)`，真相层无新增 | §8 |
| T-A18 | 两个并发 accept（不同 opId）同一候选 → 第二条 CAS 冲突；真相层仅 1 条 | §8 |
| T-A19 | 构造四类反例（角色错归/否定反转/建议变批准/未做变已做）→ `rejected(assertion-mismatch)`，逐类各 1 例 | §5 R4.5 |

### 10.1 桩通过 ≠ 放行（反「桩绿灯」）

- 桩上的全绿只算 **TDD 中间态**，不进入 P1b 放行证据。
- 放行要求：同一测试套在 **P1b 真实现**（非 `protocol-sim` 桩）上全绿，执行结果表回填目标构建物 + 运行日志链接。

### 10.2 可证伪性自检（meta-test）

- 提供 2 个**故意破损实现**：① 去掉 R3 证据校验；② 把 hold 直接判成 accept。断言保护测试**必须变红**（T-A3/T-A6 失败）。若破损实现仍全绿，说明测试是空测试，必须改写。

## 11. P1b 放行与验收（何时算完成）

1. **重冻结**：受 r2 影响的 [01](01-candidate-schema.md)/[02](02-evidence-and-deletion.md)/[03](03-trust-promotion.md)/[05](05-threshold-manifest.md)/[06](06-annotation-spec.md) 条款重新冻结（版本化 diff + 保护测试绿）。重冻结清单至少含：① 01 的 `workflow.hold` 注解与真相层 `opId` 字段；② 01 的 `assertion.subject/predicate/value` 与 `speaker=quoted`；③ 02 的 R7 epoch 复查与补快照边界；④ 05 的 hold 计分口径；⑤ 06 的命题粒度规范（见第 3 条）。
2. **测试**：§10 的 19 条在**真实现**上全绿（桩绿灯不计），且 §10.2 变异自检通过。
3. **抽取质量（口径必须钉死，禁止自选参考集）**：
   - 放行报告必须写死 `goldsetVersion + annotationMode + 匹配规约版本`（当前唯一可用：`goldset-v1` / `model-dual-blinded` / `pairing@v1`；P1b 期间禁止更换参考集）。
   - 被测抽取模型不得与两遍盲评/judge 模型同族；无法避免时按 [08 §5](08-auto-memory-and-correction.md) 声明「同源偏差未排除」，且不得单独作为放行依据——必须叠加确定性 fixture 交叉验证（T-A19 全绿）。
   - 报告必附参考集 `confirmedByBoth` 比例（当前 5.6%），并据此限定结论强度：**不得称「客观真值准确率」**。
   - 门槛：precision ≥98% / recall ≥90%（中英分别达标、固定配置 3 次运行，[04](04-scoring-and-splits.md)/[05](05-threshold-manifest.md) 口径）；**hold 一律计入 FN**（保守口径，防「难例全 hold」推高 P/R），并单独必报 hold 率。
   - 报告按家族分层的 recall 下界（bootstrap 家族聚类，[04 §3](04-scoring-and-splits.md)），禁止只报总均值；放行前完成一轮**命题粒度规范冻结**（否则 98%/90% 测的是标注噪声，见 [ANNOTATION](../../reviews/v2.0-p1a-exit-2026-11-18/ANNOTATION.md)）。
4. **七类严重错误零容忍**：任一出现即阻断（闭集见 [04 §4](04-scoring-and-splits.md)），不因平均值达标放行。
5. **时序指标**（纠正成功率、旧值误用率、错误覆盖/冲突扣留/撤销生效率）的分母与阈值在实现前冻结（细则 [07](07-benefits-observability.md)），本次不伪造数值。
6. **工具绿灯 ≠ 质量通过**：`exit-check` 一类工具只核资产完整性；放行需 1–4 同时成立并在执行结果表回填证据链接。

## 12. 明确不做

不改 `versions/`、不切 `CURRENT`、不改 v1.4 信任/权限与读写行为；不做 UI 复核队列（管理 CLI 仅查看/重放/可选干预）；不做 scheduler/adapter 与多来源采集（P4）；不引入图数据库；不做宿主级上下文压缩（那是 DSH 的事）；不自动提升信任、不自动执行外部动作。

## 13. 复用与新增资产

| 资产 | 复用/新增 | 说明 |
|---|---|---|
| `pilot/p1a/{corpus,config,tools,tests}` | 复用 | 语料/阈值/评分/参考集工具不动 |
| `pilot/p1a/tools/protocol-sim.mjs` | 扩展 | r2 决策/纠正/恢复/桩接口（§10.0），内存态，不写真相层 |
| `pilot/p1b/tools/*` | 新增 | `extract-pipeline` / `auto-decide` / `correction` / `run-events` |
| `pilot/p1b/tests/*` | 新增 | §10 的 19 条保护测试 + §10.2 破损实现 |
| 数据登记 | 新增 | 决策记录、纠正记录、阶段事件、提交收据与游标 → [docs/12 §12.7](../../12-data-map.md)；保留期/撤销传播同时登记进 [02 §8](02-evidence-and-deletion.md) 逐资产表 |
