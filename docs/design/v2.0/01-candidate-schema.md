# 01 · 候选 schema、状态机与幂等协议（v2.0 规格草案）

> doc-kind: contract
> doc-version: 2.0
> status: planned

状态：**planned**——本文是 v2.0 目标契约的规格草案，不是 v1.4 现行行为；冻结前允许修订。冻结标记由维护者在 [README](README.md) 核验表显式声明。
> 2026-11-18 r2：人工接纳前置已由[自动记忆策略08](08-auto-memory-and-correction.md)替代；[r1快照](history/2026-11-18-manual-r1/01-candidate-schema.txt)保留。现有P1a模拟器仅验证r1资产，r2实现前需补自动纠错测试并重新冻结。

来源：[future-architecture.md](../../plans/future-architecture.md) §3.2/§3.3/§3.4/§3.5；施工映射见 [v2.0-p1.md](../../plans/v2.0-p1.md) §2 冻结决策 1a/1b/3/4。

## 1. 候选对象（Candidate）

候选是抽取管线产出、**尚未进入真相层**的命题记录。候选 ≠ 事实：accept 只改变工作流状态，永不改变信任层（见 [03-trust-promotion.md](03-trust-promotion.md)）。

```jsonc
{
  "candidateId": "ulid",            // 候选主键，抽取时生成，重放不变
  "schemaVersion": 1,               // 本 schema 的版本号，整数递增
  "scope": "repo:sedimem",          // 记忆分库 scope，写入目标
  "inputRef": {                     // 输入范围（§3.2「输入范围 hash」）
    "sourceId": "dsh-transcript:<hash>",
    "sourceEpoch": 1,               // 来源世代（见 02 文件），撤销后新候选禁止挂此 epoch
    "rangeId": "ulid",              // 输入切段标识（capture 游标单位）
    "inputHash": "sha256:..."       // 规范化后的切段内容 hash
  },
  "claim": "单一命题原句（一句一候选，禁止复合命题）",
  "type": "fact",                   // 闭集 6 类，见 §4
  "assertion": {                    // 断言框架（§3.2）
    "speaker": "user|assistant|tool:<name>|unknown|quoted",
                                     // quoted = 引用他人/文档/外部内容（不是用户自己的陈述，r2 新增，见 09 §7）
    "subject": "主体（结构化，来自输入允许集合；未知 null）",
                                     // r2 新增（planned）：聊天纠正匹配键依赖 subject+predicate，见 09 §7
    "predicate": "谓词/槽位（如 port|owner|status；未知 null）",
    "value": "值文本（与 claim 一致时才填；未知 null）",
    "speechAct": "state|suggest|agree|decide|complete|retract",
    "about": "主体标识（来自输入允许集合，未知写 null）",
    "negated": false,               // 否定标记：原文明确否定时 true
    "condition": null,              // 条件从句（何时适用），无则 null
    "quote": "原文 span 引文（≤200 字）"
  },
  "time": {                         // 双时间（§5），独立于真相层 validFrom/To
    "observedAt": "2026-11-18T04:00:00Z",
    "assertedValidFrom": "2025-01-01",   // 业务时间起点；未知写 null，禁止猜
    "assertedValidTo": null
  },
  "evidence": [{                    // 证据定位（02 文件规范化算法）
    "eventId": "m00123",
    "span": { "start": 1024, "end": 1090 },  // Unicode 码点 offset
    "hash": "sha256:..."
  }],
  "relations": [{                   // 关系 ID 必须来自输入允许集合
    "kind": "supersedes|supports|contradicts",
    "targetId": "ulid|null"        // null 仅限一种含义，见下方空值语义
  }],
  "provenance": {                   // 血缘
    "provider": "glm|rule|human",
    "model": "glm-4.6|null",
    "promptVersion": "p1a-baseline-1",
    "configHash": "sha256:...",
    "runId": "ulid",
    "extractionRunKey": "ulid"      // 幂等五元组之一，见 §3
  },
  "workflow": {
    "state": "pending",             // 状态机，见 §2
    "failure": null,                // 失败枚举，见 §6
    "candidateVersion": 1,          // CAS 乐观锁
    "acceptOpId": null,
    "decidedBy": null,
    "decidedAt": null,
    "hold": null                    // 待决注解（r2）：{reason, decidedAt, policyVersion, unresolved{subject,predicate}}
                                    // 注意：hold 不是状态，候选仍在 pending；落盘的是注解，见 §2 澄清
  }
}
```

**空值语义（未知不猜）**：所有 `null` 字段都是显式「未知」，校验器把「猜出来的默认值」当错误。`speaker=unknown`、`about=null`、`assertedValidFrom=null` 均合法；但 `evidence` 为空数组不合法（候选必须有可定位证据，否则状态应为 `failed` + 失败枚举 `evidence-unsupported`）。

**relations.targetId=null 的唯一合法含义**（对齐上位 §4.1「跨段无身份绑定则弃权」条款）：目标实体在输入中出现了候选所需的参照（代词/别名/描述），但**无法解析为允许集合内的具体 ID**——此时关系记录弃权事实，必须附带漏抽原因（`unresolvedReason: "cross-range"|"alias-unresolvable"|"ambiguous"`），并计入评测漏抽统计。`targetId=null` + `unresolvedReason` 缺失 → schema 校验失败。除此之外任何情形下关系必须有非空 targetId。

## 2. 状态机（冻结决策 1a）

```
pending ──accept──▶ accepted ──来源trust不变；结构化陈述按08规则可用于上下文
   │ ├──reject──▶ rejected（留作评测负例，不删除）
   │ └──retract──▶ cancelled（抽取器自我撤回或来源失效）
   └──fail──▶ failed（含 failure 枚举；重试语义见 §3.1 澄清）
accepted ──supersede──▶ superseded（修订链：新候选 accept 时旧候选转此态）
```

合法迁移（闭集，校验器逐条测试）：

| from | to | 触发 | 备注 |
|---|---|---|---|
| pending | accepted | policy 自动 accept（带 acceptOpId） | 不提升 trust |
| pending | rejected | policy 自动 reject | 留评测负例 |
| pending | cancelled | 抽取器 retract / sourceEpoch 撤销 | 撤销触发的批量迁移见 02 文件 |
| pending | failed | 管线错误（带 failure 枚举） | |
| accepted | superseded | 后续候选 accept 且 relations.kind=supersedes | 修订链 |
| rejected/cancelled/failed/superseded | （终态） | — | 禁止任何迁出；错误输入即抛错 |

**非法迁移一律拒绝并返回冲突**（如 accept 已 rejected 的候选），不静默成功。

**hold 不是状态（r2 澄清，消除与 09 §6 的闭集冲突）**：自动决策的 `hold` 不引入新状态，候选**保持 `pending`**，改在 `workflow.hold` 落注解：

```jsonc
"hold": { "reason": "unresolved|stale-evidence", "decidedAt": "2026-11-18T12:00:00Z",
          "policyVersion": "policy:auto-memory-r2/1",
          "unresolved": { "subject": "db-primary", "predicate": "port", "value": null } }
```

- 状态机闭集不变（`pending|accepted|rejected|cancelled|failed|superseded`）。
- hold 之后仍可 accept/reject（注解清除）；hold 不阻塞其他候选、不生成人工待办。
- 「reject + hold」二义表述作废：stale 证据 → `failed`（`evidence-unsupported`）**或**退回重新圈定后出新候选版本（与 [02 §4](02-evidence-and-deletion.md) 一致），不叠加 hold。

**failed 重试澄清（消除与 §3 noop 的张力）**：failed 后重试若输入、模型、配置都未变，则按 §3 确定性 ID 规则命中**同一 candidateId** → noop，不产生新候选；只有 claim 内容、模型或配置变化时才产生新 candidateId（修订语义，见 §3.1）。

## 3. 幂等协议（冻结决策 1b）

幂等五元组：`sourceEpoch` + `rangeId` + `extractionRunKey` + `candidateVersion` + `acceptOpId`。

**写入幂等**：`extractionRunKey` 相同的重放产出同一批 `candidateId`（抽取器对同输入确定性生成 ID：candidateId = hash(sourceEpoch, rangeId, inputHash, claim 的规范化形式) 的 ULID 派生）；重复写入同 candidateId 是 noop，不产生第二条。

**Accept 幂等**：同一 `acceptOpId` 重放：
1. 若该 opId 的持久收据已存在 → 返回已有结果（noop receipt），绝不追加第二条真相层记录；
2. noop/merge 决策必须保存 **opId→目标记录的持久收据**（落盘，不靠进程内缓存），收据可重放恢复；
3. merge 类 accept 的收据记录目标记录 ID 与 merge 后的 revision。

**CAS 校验**（accept 提交时，同一数据锁内）：校验三元组 `candidateVersion` + `evidenceHash` + `expectedTruthRevision`。任一不匹配 → **返回冲突、自动刷新重评，不盲写**；冲突响应包含当前值供自动决策器刷新。

**提交点**：长期记录（真相层）成功追加 = 唯一提交点。候选与审计先持久化，真相层追加失败时恢复流程以「审计里的决定 + 收据」重放，不产生重复。

**真相层记录必须携带 `opId` 与 `candidateId`（r2 新增，恢复对账前提）**：真相层每条追加记录含 `opId`（本次 accept 操作）、`candidateId`、`revision`；收据缺失时据此反查「该 opId 是否已提交」（判定树见 [09 §8](09-extraction-pipeline.md)）。缺 `opId` 的记录视为 schema 不完整，恢复器不得猜。

**抽取游标**：仅在候选与审计持久化后提交；任何缺口写入 `missingRanges`（持久列表），**不得把缺口推进为已完成**。恢复运行必须先消费 missingRanges。

**崩溃窗口重放**：kill/restart 后按 `extractionRunKey` 重放，产出与首次相同的 candidateId 集合 → 全部 noop；部分成功的边界以游标 + missingRanges 判定。

**锁边界**：数据锁不覆盖 LLM 网络调用。顺序 = 先固化输入（inputHash/rangeId）→ 锁外抽取（网络）→ 锁内核对（inputHash 未变 + candidateVersion CAS）→ 落盘。

**recovery-required**：无法判定（如收据缺失但真相层疑似已追加）时，把该 opId 标 `recovery-required` 并**禁止自动重试成新写入**；恢复由自动对账器按持久化决定与目标版本确定性核对，无法证明结果则扣留，不盲写也不要求用户复核。

### 3.1 修订语义（模型差异 / 跨运行修订）

上位 §3.5：「同一输入范围/配置重试属于同一逻辑运行；模型差异保留为候选修订而非自动新事实。」落地口径：

- **同一逻辑运行**（同 extractionRunKey，同模型同配置）：重放产出同一 candidateId 集 → noop（§3 写入幂等）。
- **修订**（revision）：跨运行或跨模型产生的新候选，通过 `relations.kind=supersedes` 指向旧候选；旧候选在修订被 accept 时转 `superseded`（状态机）。修订是新 candidateId（内容变化的判定边界见下）——修订路径不冒充 noop，noop 也不吞并内容变化。
- **candidateVersion 自增只由工作流操作触发**：自动策略决策、修订链接建立及可选用户编辑。抽取管线绝不自行 bump candidateVersion（版本是 CAS 锁，不是迭代计数器）。
- **判定边界（R2-N1 修订，消除与 §3 写入幂等的矛盾）**：candidateId 派生**只含内容四元组**（sourceEpoch/rangeId/inputHash/claim 规范化形式），**不含 model/configHash**——这是重放幂等的关键不变量，不为此妥协。因此：模型/配置变化**且 claim 规范化形式不同** → 修订路径（新 candidateId + supersedes）；模型/配置变化但 **claim 相同** → 按 §3 写入幂等处理（同 candidateId → noop），**provenance 以首写为准**（首次写入的 model/configHash 落盘，后续 noop 不覆盖）。修订的本质是内容变化，不是执行环境变化。P1b 协议测试必含「跨模型同 claim → noop + provenance 不变」用例。

**失败状态枚举（对齐上位 future-architecture §3.4；本节位于 §3.1 末）**：`timeout` / `empty-response` / `parse-failure` / `token-truncated`（识别 finish_reason=length，不解析半截响应）/ `evidence-unsupported` / `no-recordable-content` / `policy-blocked`，附原始 finish_reason。`no-recordable-content` 不是错误——它是「无可记场景」的正常信号，进评测统计。`recovery-required` **不属于**候选 failure 枚举：它是 opId 级恢复标记（§3 recovery-required 段），落在收据/审计侧，不得写进 `workflow.failure`。

## 4. 类型映射（冻结决策 4，闭集）

| 候选 type（闭集 6 类） | 现有 kind 映射 | 说明 |
|---|---|---|
| fact | fact | 客观命题 |
| decision | decision | 已做的决定 |
| preference | pref | 偏好/要求 |
| gotcha | gotcha | 踩坑/约束 |
| task-state | state | 任务进度/状态 |
| hypothesis | fact + trust 保持 T2* | 假设/未证实命题；现有 5 类 kind 无对应，映射到 fact 但工作流标注 hypothesis 语义，是否新增 kind 由 P1b 施工时随 v2.0 写路径一并决策（本轮不扩现行 kind 枚举） |

*闭集决策记录：**不设第 7 类「其他」**，也不解释上位计划「fact/decision/preference/gotcha/task-state/hypothesis」的「等」字——上位文本枚举即全集（未来架构 §3.2 原文六类）。理由：开集类型会让抽取器把低置信命题倾倒进「其他」，破坏评测口径。若未来需要新类型，走 schemaVersion 升级 + 本表修订，不走运行时扩展。

## 5. 双时间字段（冻结决策 3）

- `time.observedAt`：抽取器观察到该命题的时刻（系统时钟）。
- `time.assertedValidFrom/To`：**业务时间**——命题声称的适用区间（「去年开始」「下月失效」）。解析自原文，未知写 null。
- 真相层 `MemoryRecord.validFrom/validTo` 是**系统可见区间**（P0b 语义：validFrom=提交时钟），与业务时间**互斥不混用**：候选层不做业务时间→可见区间的换算，换算语义属于 P1b 写路径规格。
- 防穿越反例（保护测试）：用户 2026-11 说「去年 3 月开始用 X」→ observedAt=2026-11，assertedValidFrom=2025-03；任何 asOf=2025-04 的读取**不得**因此命中该记录（它 2026-11 才进入系统）。

## 6. 验收（与 pilot 工具的对接）

1. pilot 校验工具（corpus-validate / protocol-sim，见 [v2.0-p1.md](../../plans/v2.0-p1.md) §3 D3/D4）按本文件实现 schema 校验、状态机枚举校验、非法迁移拒绝、五元组幂等与 CAS 冲突负向用例。
2. 每字段有「未知不猜」空值语义（§1）。
3. 本 schema 是 JSON Schema **草案**：P1b 施工时生成机读 schema 文件并做 round-trip 测试；P1a 以人读规格 + pilot 工具内嵌校验为准。
