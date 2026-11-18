# 04 · 测试切分与打分规约（v2.0 规格草案）

> doc-kind: contract
> doc-version: 2.0
> status: planned

状态：**planned**——冻结前允许修订。来源：[future-architecture.md](../../plans/future-architecture.md) §7.1/§7.2；施工映射 [v2.0-p1.md](../../plans/v2.0-p1.md) §2 冻结决策 8、§3 D2（标注规范并入或独立见 [06-annotation-spec.md](06-annotation-spec.md)）。阈值数字一律以 [05-threshold-manifest.md](05-threshold-manifest.md) 为准，本文只定**口径**。

## 1. 场景家族切分（冻结决策 8）

- 语料按**场景家族**（同一真实任务的不同变体）组织；家族是切分与 bootstrap 的最小聚类单位。
- dev/test 按家族切分：**同家族成员不跨集合**（近重复不跨集）；test 家族与 dev 家族互斥。
- 切分确定性：给定语料版本号，切分结果唯一可复现（种子 + 排序规则写进 manifest）；语料任何变更 = 新版本号 = 重新切分并报告 diff。

## 2. TP/FP/FN 一对一计分

| 判定 | 规则 |
|---|---|
| TP | 候选 claim 与 gold claim 一对一匹配（同实体+同命题+同断言框架）；**同一 gold 只计一次 TP** |
| FP | 匹配不到任何 gold 的候选；同一 gold 的**额外重复候选**也计 FP（一对一纪律） |
| FN | 范围内 gold 因被过滤/拒绝/`evidence-unsupported` 漏掉 → 计 FN（**不是**从分母剔除）；gold 本身错漏见 §4 漏标流程 |

- 匹配是 claim 级不是场景级：一个场景内多条 gold 分别配对。
- precision = TP/(TP+FP)；recall = TP/(TP+FN)。

**零输出**：场景零输出（无任何候选）时，该场景 precision **未定义**，聚合口径整体按「未定义且不通过」处理——**禁止**把零输出场景记成 precision=100% 或从分母剔除。

## 3. 六条硬规则（R1 修订锚定）

1. **零输出 precision 未定义不通过**（§2）。
2. **漏标 gold 先裁决再重跑**：「语义正确但 gold 漏标」→ 先走 gold 裁决流程（[06-annotation-spec.md](06-annotation-spec.md) §4）并**版本化** gold，然后**重跑全部组**（含对照组），不得临时把该候选加成 TP。
3. **FN 含过滤拒绝**：因管线过滤、人工 reject、`evidence-unsupported` 导致的漏报都是 FN；评测不放管线「自我豁免」。
4. **固定配置 ≥3 次运行**：每次运行独立达标（中英分别），报三次的分布，不只报最好一次。
5. **截断/超时/解析失败保留原分母**：`token-truncated`/`timeout`/`parse-failure` 场景保留在分母计缺失，**不得**作为「空场景」剔除。
6. **家族聚类 bootstrap 主口径**：置信区间以场景家族为聚类单位 bootstrap；Wilson 区间仅描述性、禁止宣称独立样本置信；报告必报：拦截率、每场景复核数量/耗时、无可记场景误报率。

## 4. 七类严重错误（拦住 vs 逃逸分开计数）

| # | 严重错误 | 定义 |
|---|---|---|
| 1 | 无依据事实 | 候选 evidence 无法定位到输入 |
| 2 | 角色错归 | speaker 归属错误（把用户说的归给 assistant 等） |
| 3 | 否定反转 | negated 标错，语义翻转 |
| 4 | 建议变批准 | speechAct: suggest 被记成 agree/decide |
| 5 | 未做变已做 | 工具失败/计划中的动作被记成 complete |
| 6 | 跨 scope 泄漏 | A scope 的内容进了 B scope 的候选/读取面 |
| 7 | 撤回当当前 | retract 后的命题仍以当前有效口径输出 |

- **拦住**：对抗样例中管线正确拒绝/标错的情形 → 拦截率分子。
- **逃逸**：错误进入最终候选 → **任一逃逸即阻断**（manifest 阈值）；两类分开计数、分开报告。

## 5. 三层报告

每轮评测报三层：① 原始抽取输出（含失败枚举）；② 机器校验后候选（schema/证据/闭集校验后的集合）；③ 人工复核后记录。层间差异本身是指标（过滤率、复核改动率），不得只报最好一层。

## 6. 防泄漏条款

- `queryTime` 边界：评测请求带显式 queryTime，晚于 queryTime 的语料对本次评测不可见。
- **评分器隔离**：打分器只读 gold 与候选输出，禁止读基线实现/提示词；标注者反向隔离见 [06-annotation-spec.md](06-annotation-spec.md)。
- **test 暴露转 regression**：test 场景一经用于调优即视为暴露，转入 regression 集；泛化声明必须换新 holdout——**不得在同一测试集反复改到过关**再宣称泛化。

## 7. 保护测试

打分器对固定样例的 TP/FP/FN 快照测试锁定行为，必含断言：零输出场景、分母保留（截断场景）、3 次运行口径、一对一重复 FP、家族切分确定性。快照样例随 manifest 版本化。
