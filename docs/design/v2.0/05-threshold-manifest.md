# 05 · 阈值 Manifest（v2.0 规格草案）

> doc-kind: contract
> doc-version: 2.0
> status: planned

状态：**planned**——冻结前允许修订。来源：[future-architecture.md](../../plans/future-architecture.md) §7.1；施工映射 [v2.0-p1.md](../../plans/v2.0-p1.md) §2 冻结决策 8、§3 D1-05。

## 1. 原则

- **先冻结后实验**：全部阈值数字在**看任何 holdout 结果之前**写入机读 manifest（`pilot/p1a/config/eval-manifest.json`）；本文是其人读镜像与变更协议。
- **改数字 = 版本化事件**：任何阈值变更必须走版本化 diff（git commit 显式引用本文件）+ 维护者签署（执行结果表回填）；禁止「跑完再调阈值」。
- **每项标来源**：manifest 每个数字带 `source`（future-architecture §7.x 行号或本文 §），带 `rollback`（回滚方法）。

## 2. 冻结数字清单

| 阈值 | 值 | 来源 | 回滚方法 |
|---|---|---|---|
| 候选 claim precision | ≥98%（中英分别达标） | future-architecture §7.1 | 调低 = 计划级修订 + 对抗审核重审，禁止评测后下调 |
| 候选 claim recall | ≥90%（中英分别达标） | future-architecture §7.1 | 同上 |
| 语料场景总数 | ≥200（dev 100 / test 100，家族切分；pilot ≥40 全集） | future-architecture §7.1 / v2.0-p1 §3 D3 | 出口级语料不足 = P1a 不出出口 |
| gold claims | ≥200（出口级） | future-architecture §7.1 | pilot 阶段 ≥60（D3 规模），出口级以本表为准 |
| 无可记场景 | ≥50（出口级；pilot ≥6） | future-architecture §7.1 | 同上 |
| 对抗样例 | **test 集**每类 ≥10（出口级；pilot 每类 ≥3，作用于 pilot 全集） | future-architecture §7.1「每类 test 至少 10 例」 | 同上 |
| test 中/英 | 各 ≥40（出口级，作用域 = test 集）；pilot 各 ≥12（作用域 = pilot 全集，pilot 未切分 dev/test） | future-architecture §7.1 | 同上 |
| 近重复判定 | Dice ≥0.85（与主库判重口径一致） | future-architecture §7.1 | 变更口径需同步主库 config 并注明 |
| 运行次数 | 每配置 ≥3 次 | [04-scoring](04-scoring-and-splits.md) §3 | 减少 = 评测口径修订 |
| bootstrap | 家族聚类，B=2000 重采样，置信 95% | [04-scoring](04-scoring-and-splits.md) §3 | 参数写入 manifest，可调但须版本化 |
| 严重错误逃逸 | 任一即阻断（七类，[04](04-scoring-and-splits.md) §4） | future-architecture §7.1 | 不可回滚——此为红线 |
| 证据解析率 | 100% | future-architecture §7.1 | 不可回滚 |

**范围声明（消除引用悬空）**：保留期、条数/字节上限、扫描路径等**数据治理数值不在本 manifest**——归属 docs/12-data-map.md，登记框架见 [02-evidence-and-deletion.md](02-evidence-and-deletion.md) §8 逐资产登记表。本 manifest 只冻结评测阈值。

**frozenAt 惯例**：manifestVersion 每次变更（新增键或改数值）都必须刷新 `frozenAt` 并在 `revisionNote` 说明改了什么——冻结时间是「这一版内容」的冻结时刻，沿用上一版时间会误导审计者。

## 3. 加载与校验

- corpus-validate 与 scorer **必须**加载 manifest 并校验语料/结果；manifest 缺失或解析失败 = 工具拒绝运行（fail-closed）。
- manifest 内含 `manifestVersion`（整数）与 `frozenAt`（ISO 时间）；工具输出报告必须引用所用 manifestVersion。

## 4. 与 pilot 的关系

pilot 阶段（单标注、小语料）使用同一 manifest，但结果**一律标 pilot**，不得引用 pilot 结果宣称达标（[06-annotation-spec.md](06-annotation-spec.md) §3）。出口判定以出口级语料 + 出口级 gold + 本表全量门槛为准。
