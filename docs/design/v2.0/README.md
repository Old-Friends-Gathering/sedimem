# v2.0 规格包（规划）

> doc-kind: contract
> doc-version: 2.0
> status: planned

本目录是 **v2.0 目标契约的规格暂存区**：全部文件 planned，不是 v1.4 现行行为；冻结与 CURRENT 切换时按 [docs/11](../../11-doc-governance.md)「规划契约暂存区」条款同步进现行契约文档。上位权威：[future-architecture.md](../../plans/future-architecture.md)；施工计划：[v2.0-p1.md](../../plans/v2.0-p1.md)。

## 当前策略修订 r2（2026-11-18）

用户明确取消人工复核/人工标注前置。当前权威：[08自动记忆与历史纠正](08-auto-memory-and-correction.md)。默认自动接纳、按聊天证据纠正；不自动提升来源trust，不要求手工promote才能使用结构化记忆。

下面九项冻结表是**r1已交付资产记录**，不是r2实现放行。受影响的1a/1b/5/8及评测流程须按08补自动接纳/纠正保护测试并重冻结；其他资产复用。取消人工前置不抹去旧标注来源限制，也不放宽数值/安全阈值。

## 索引

| 文件 | 冻结决策（计划 §2） | 内容 |
|---|---|---|
| [01-candidate-schema.md](01-candidate-schema.md) | 1a 候选状态机 / 1b 幂等协议 / 3 双时间 / 4 kind 映射 | 候选对象、状态机、幂等五元组、CAS、失败枚举、闭集类型 |
| [02-evidence-and-deletion.md](02-evidence-and-deletion.md) | 2 证据范围与删除语义 | 规范化算法、sourceEpoch、stale、删除动作表、数据级回滚 |
| [03-trust-promotion.md](03-trust-promotion.md) | 5 来源信任 r2 | 自动接纳不提权，T2结构化陈述可用；待r2冻结 |
| [04-scoring-and-splits.md](04-scoring-and-splits.md) | 8 测试切分与打分规约 | 家族切分、TP/FP/FN、六硬规则、七类严重错误、防泄漏 |
| [05-threshold-manifest.md](05-threshold-manifest.md) | 8（数字部分） | 阈值清单与变更协议；机读镜像见 pilot/p1a/config/eval-manifest.json |
| [06-annotation-spec.md](06-annotation-spec.md) | D2 标注规范 | 参考字段、自动盲评/裁决、来源声明、防泄漏（r2） |
| [07-benefits-observability.md](07-benefits-observability.md) | P1b/P1c 新增范围（非原九项冻结） | 收益看板、任务对照、报告导出、token/净成本/质量口径；planned，未实现 |
| [08-auto-memory-and-correction.md](08-auto-memory-and-correction.md) | 用户修订r2，替代人工前置 | 自动沉淀/聊天纠正/自动评测；planned，尚未实现生产管线 |
| [09-extraction-pipeline.md](09-extraction-pipeline.md) | P1b 施工（r2） | 阶段 R0–R8、自动决策矩阵、聊天纠正规则、恢复与幂等、r2 保护测试 T-A1..T-A16、P1b 放行条件 |
| [adr-101-tokenizer.md](adr-101-tokenizer.md) | 6 tokenizer | DeepSeek 计数 + 生成模型声明；zai 查证记录 |
| [adr-102-cost-quota.md](adr-102-cost-quota.md) | 7 成本/容量上限 | 闸门、额度项、出站安全、配置就绪验收 |

机读阈值：`pilot/p1a/config/eval-manifest.json`（manifestVersion 1，2026-11-18 冻结）。

## r1九项冻结核验表（对齐计划 §2）

| # | 冻结决策 | 规格/ADR | 冻结证据 | 状态 |
|---|---|---|---|---|
| 1a | 候选状态机 | [01](01-candidate-schema.md) §2 | [01 §2](01-candidate-schema.md) + [protocol-sim.test.mjs](../../../pilot/p1a/tests/protocol-sim.test.mjs)（状态机非法迁移/终态用例） | frozen（2026-11-18） |
| 1b | 幂等协议 | [01](01-candidate-schema.md) §3 | [01 §3](01-candidate-schema.md) + [protocol-sim.test.mjs](../../../pilot/p1a/tests/protocol-sim.test.mjs)（同输入重放 noop / CAS 冲突 / 收据重放） | frozen（2026-11-18） |
| 2 | 证据范围与删除语义 | [02](02-evidence-and-deletion.md) | [02](02-evidence-and-deletion.md) + [corpus-validate.test.mjs](../../../pilot/p1a/tests/corpus-validate.test.mjs)（span 解析/PII/quote 唯一） | frozen（2026-11-18） |
| 3 | 双时间字段 | [01](01-candidate-schema.md) §5 | [01 §5](01-candidate-schema.md) + [contract-guards.test.mjs](../../../pilot/p1a/tests/contract-guards.test.mjs)（双时间守卫：asserted* 不得作系统区间、asOf 穿越反例） | frozen（2026-11-18） |
| 4 | kind 映射（闭集 6 类） | [01](01-candidate-schema.md) §4 | [01 §4](01-candidate-schema.md) + [corpus-validate.test.mjs](../../../pilot/p1a/tests/corpus-validate.test.mjs)（闭集枚举校验） | frozen（2026-11-18） |
| 5 | 信任提升路径 | [03](03-trust-promotion.md) | [03](03-trust-promotion.md) + [protocol-sim.test.mjs](../../../pilot/p1a/tests/protocol-sim.test.mjs)（真相层 trust 恒 T2） | frozen（2026-11-18） |
| 6 | tokenizer | [adr-101](adr-101-tokenizer.md) | [adr-101](adr-101-tokenizer.md)（accepted）+ [contract-guards.test.mjs](../../../pilot/p1a/tests/contract-guards.test.mjs)（计数快照：同输入同计数 + TOKENIZER_DECLARATION）+ [v2.0-p1.md §6](../../plans/v2.0-p1.md) 查证记录 | frozen（2026-11-18） |
| 7 | 成本/容量上限 | [adr-102](adr-102-cost-quota.md) | [adr-102](adr-102-cost-quota.md)（accepted）+ [contract-guards.test.mjs](../../../pilot/p1a/tests/contract-guards.test.mjs)（闸门：无配置拒绝发起 / 超上限显式停机）+ [eval-manifest.json](../../../pilot/p1a/config/eval-manifest.json) | frozen（2026-11-18） |
| 8 | 测试切分与打分规约 | [04](04-scoring-and-splits.md) + [05](05-threshold-manifest.md) | [04](04-scoring-and-splits.md) + [05](05-threshold-manifest.md) + [score.test.mjs](../../../pilot/p1a/tests/score.test.mjs) + [split-corpus.test.mjs](../../../pilot/p1a/tests/split-corpus.test.mjs) | frozen（2026-11-18） |

出口核验：`node pilot/p1a/tools/exit-check.mjs .`只检查r1资产完整性、语料及参考产物；annotation-dual保留历史键名，模型参考模式允许通过但必须标来源，缺产物才pending，不等人工标注。工具ok不代表r2实现/质量通过。

## 冻结说明（2026-11-18）

- **冻结日期**：2026-11-18（九项全部 frozen，见上表逐行状态）。
- **冻结前置 = 保护测试绿**，实测：pilot 测试 79/79 绿（`pilot/p1a/tests/` 下 protocol-sim、corpus-validate、baseline-runner、score、review、split-corpus、annotation-pass 七个文件）；exit 语料校验 0 errors（218 场景 / 347 gold / split 校验通过）；门禁 quality 15/15 + security 9/9 + docs-drift 无 finding。设计审核 R1/R2/R3 三轮通过（[REVIEW.md](../../reviews/v2.0-design-spec-2026-11-18/REVIEW.md)）。
- **冻结 ≠ 实现完成**：P1b 起按本规格包实现；任何规格修订须出新版本并保留旧版（[docs/11](../../11-doc-governance.md) 规划契约暂存区条款）。
- **历史r1说明**：当时要求人工标注；该要求现已由用户取消，旧产物保留原annotationMode，不能冒充人工真值。

## 2026-11-18 收益展示增补与当前限制

规格07是用户新授权的后续交付范围，**未冻结**，不修改九项冻结或manifest。P1a已有runner/score/基线复用；P1b采集、P1c看板/对照/报告待开发。

最新出口实跑：9✅+1⚠️，标注为`model-dual-blinded`（[执行证据](../../reviews/v2.0-p1a-exit-2026-11-18/ANNOTATION.md)），不是`dual-independent`；r2不再等待人工标注/复核。两套gold版本不可混用，自动粒度规范与聊天纠正测试待补；不宣称人工gold或客观真实准确率。
