# v2.0 规格包（规划）

> doc-kind: contract
> doc-version: 2.0
> status: planned

本目录是 **v2.0 目标契约的规格暂存区**：全部文件 planned，不是 v1.4 现行行为；冻结与 CURRENT 切换时按 [docs/11](../../11-doc-governance.md)「规划契约暂存区」条款同步进现行契约文档。上位权威：[future-architecture.md](../../plans/future-architecture.md)；施工计划：[v2.0-p1.md](../../plans/v2.0-p1.md)。

## 索引

| 文件 | 冻结决策（计划 §2） | 内容 |
|---|---|---|
| [01-candidate-schema.md](01-candidate-schema.md) | 1a 候选状态机 / 1b 幂等协议 / 3 双时间 / 4 kind 映射 | 候选对象、状态机、幂等五元组、CAS、失败枚举、闭集类型 |
| [02-evidence-and-deletion.md](02-evidence-and-deletion.md) | 2 证据范围与删除语义 | 规范化算法、sourceEpoch、stale、删除动作表、数据级回滚 |
| [03-trust-promotion.md](03-trust-promotion.md) | 5 信任提升路径 | accept≠promote、批量复核约束、传播控制 |
| [04-scoring-and-splits.md](04-scoring-and-splits.md) | 8 测试切分与打分规约 | 家族切分、TP/FP/FN、六硬规则、七类严重错误、防泄漏 |
| [05-threshold-manifest.md](05-threshold-manifest.md) | 8（数字部分） | 阈值清单与变更协议；机读镜像见 pilot/p1a/config/eval-manifest.json |
| [06-annotation-spec.md](06-annotation-spec.md) | D2 标注规范 | gold 字段、双独立标注、pilot 诚实标注、漏标裁决 |
| [adr-101-tokenizer.md](adr-101-tokenizer.md) | 6 tokenizer | DeepSeek 计数 + 生成模型声明；zai 查证记录 |
| [adr-102-cost-quota.md](adr-102-cost-quota.md) | 7 成本/容量上限 | 闸门、额度项、出站安全、配置就绪验收 |

机读阈值：`pilot/p1a/config/eval-manifest.json`（manifestVersion 1，2026-11-18 冻结）。

## 九项冻结核验表（对齐计划 §2）

| # | 冻结决策 | 规格/ADR | 状态 |
|---|---|---|---|
| 1a | 候选状态机 | [01](01-candidate-schema.md) §2 | planned（未冻结） |
| 1b | 幂等协议 | [01](01-candidate-schema.md) §3 | planned（未冻结） |
| 2 | 证据范围与删除语义 | [02](02-evidence-and-deletion.md) | planned（未冻结） |
| 3 | 双时间字段 | [01](01-candidate-schema.md) §5 | planned（未冻结） |
| 4 | kind 映射（闭集 6 类） | [01](01-candidate-schema.md) §4 | planned（未冻结） |
| 5 | 信任提升路径 | [03](03-trust-promotion.md) | planned（未冻结） |
| 6 | tokenizer | [adr-101](adr-101-tokenizer.md) | proposed（未冻结） |
| 7 | 成本/容量上限 | [adr-102](adr-102-cost-quota.md) | proposed（未冻结） |
| 8 | 测试切分与打分规约 | [04](04-scoring-and-splits.md) + [05](05-threshold-manifest.md) | planned（未冻结） |

冻结动作 = 维护者把对应行状态改为 **frozen + 日期**，并回填 [v2.0-p1.md](../../plans/v2.0-p1.md) §10 执行结果表；保护测试绿是冻结前置。九项齐备 + 出口级 gold + 语料达标才开 P1b（计划 §0）。
