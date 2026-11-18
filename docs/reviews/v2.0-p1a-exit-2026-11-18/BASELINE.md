# P1a 出口基线正式报告（2026-11-18）

> doc-kind: history
> doc-version: 1.4

测量对象：P1a 出口基线（分支 `p1a/exit-freeze`）——规则地板抽取器 baseline-runner 在 exit 语料上的端到端实测。上位权威：[docs/design/v2.0/](../../design/v2.0/README.md) 规格包 + [docs/plans/v2.0-p1.md](../../plans/v2.0-p1.md)。语料与审核记录见 [v2.0-p1a-b3-2026-11-18/REVIEW.md](../v2.0-p1a-b3-2026-11-18/REVIEW.md)。

## 一句话结论

规则地板抽取器在 exit 语料上实测 P=0.22% / R=0.58%（全语料），离出口门槛（P≥98% / R≥90%）差 2~3 个数量级——本报告是 P1b 证据约束 LLM 抽取的**地板证据**，不构成任何形式的验收结论；verdict 字段恒为 null（04 §5 fail-closed：pilot / 无第二标注人时不得出 pass/fail）。

## 方法论

- **语料**：218 场景（test 100 / dev 118），gold 347 条，对抗 10 类 test 每类恰 10（详见 B3 审核报告修订后验证节）。
- **抽取器**：规则地板 baseline-runner（句子切分 + 线索词匹配，无 LLM 参与）。
- **评分口径**：manifest v3（[04-scoring-and-splits.md](../../design/v2.0/04-scoring-and-splits.md) §3 六硬规则：TP/FP/FN 一对一匹配、零输出 precision 未定义、截断场景保留原分母）。**置信区间主口径 = 家族聚类 bootstrap**：`score.mjs` 已实现 `bootstrapCI`（重采样场景家族、保留簇内全部场景、percentile 法、2000 次、95%、seed=`20261118` 可复现）；Wilson 区间同时输出，仅作描述性对照，不得宣称独立样本置信。
- **运行**：实测于 2026-11-18T12:21Z，产物在 `pilot/p1a/out/exit/exit-20261118T12-21-40Z/`（gitignored，按下方复现命令重建；目录不入库故不作站内链接）。
- **固定配置 3 次运行（04 §3）**：连跑 3 次，`meta.contentDigest` 三次一致 = `e25c863db32635f3…`（摘要刻意剔除 `provenance.runId`，只覆盖抽取内容），证明规则地板在同一语料上逐字节可复现。
- **复现命令**（仓库根）：

```
node pilot/p1a/tools/baseline-runner.mjs pilot/p1a/corpus <out>
node pilot/p1a/tools/score.mjs <cand> pilot/p1a/corpus
```

- **标注状态声明**：corpus gold 为单标注（annotationMode: pilot 语义）。用户已决策自任第二标注人（显式偏离 06 §2 独立性要求），annotation-pass.mjs 盲评工作流（导出/导入/一致性报告/裁决工作表）已就绪；执行后 annotationMode 升为 dual-independent 才可宣称出口级 gold。

## 结果

### 全语料（218 场景，347 gold）

| 指标 | 值 | bootstrap 家族聚类 95% CI（主口径） | Wilson 95% CI（描述性） |
|---|---|---|---|
| tp / fp / fn | 2 / 888 / 345 | — | — |
| Precision | 0.22% | 0.00%–0.53% | 0.06%–0.82% |
| Recall | 0.58% | 0.00%–1.42% | 0.16%–2.08% |
| 零输出场景 | 0 | — | — |

> 表注：bootstrap 分母为 15 个场景家族（聚类单位），2000 次重采样、seed=20261118（`score-all.json` 的 `bootstrap` 字段可逐项复核）。家族聚类口径下区间下界为 0，说明「家族间差异主导方差」——单家族内的稳定命中不能外推为总体置信。

### test 拆分（100 场景，门槛作用域）

| 指标 | 值 | bootstrap 家族聚类 95% CI |
|---|---|---|
| tp / fp / fn | 0 / 484 / 210 | — |
| Precision | 0 | [0, 0]（全程零 TP，簇内分母恒 >0） |
| Recall | 0 | [0, 0] |

按语言组：

| 语言组 | tp | fp | fn |
|---|---|---|---|
| zh | 0 | 220 | 101 |
| en | 0 | 313 | 127 |

七类严重错误命中：

| 错误类 | 命中数 |
|---|---|
| negation-flip | 154 |
| speaker-misattribution | 266 |
| suggestion-promoted | 1 |
| retract-treated-current | 49 |
| 其余 3 类 | 0 |

对抗面：block 违规 80、emit-with-flag 未打标 20。

### dev 拆分（118 场景）

| 指标 | 值 | bootstrap 家族聚类 95% CI |
|---|---|---|
| tp / fp / fn | 2 / 404 / 135 | — |
| Precision | 0.49% | 0.00%–1.15% |
| Recall | 1.46% | 0.00%–3.76% |

### 04 §3 必报三项（本次全量补齐）

| 必报项 | 实测 | 说明 |
|---|---|---|
| 对抗拦截率 | **0%**（全语料 0/132；test 0/100） | 拦截 = 对抗场景未产生违规（block 类无候选触碰 target、emit 类触碰但已打标）。规则地板无不确定标记概念，132 个对抗场景**全部**逃逸 |
| 无可记场景误报率 | **100%**（54/54） | 无可记场景（寒暄/纯回显/无命题）被抽取出候选即误报；规则地板按句子切分不看语义，54 个场景全部产出了候选 |
| 每场景复核数量/耗时 | N/A（规则地板无人机复核环节） | 该项在 P1b 人工接纳流程落地后才有观测值；届时以 `review` 事件流统计每场景复核条数与耗时 |

> 口径：`scoreRun().shouldRejectEmission` 与 `.adversarialInterception` 机算（`score-*.json` 字段可直接复核）；拦截率分子=未违规场景数，分母=带 `adversarial.target` 的场景数。

## 与门槛的差距分析

出口门槛为 P≥98% / R≥90%（test 作用域）。实测 test P=0、R=0：差距为 2~3 个数量级，且这不是实现缺陷，而是规则地板的**结构性命中**——逐类说明：

- **negation-flip（154）**：规则地板无否定建模。句子切分 + 线索词匹配只看表面词形，否定线索词（"不"/"没"/"not"/"never" 等）不在线索表内，被否定的事实被当作肯定事实抽取，翻转命题真值。
- **speaker-misattribution（266）**：角色归因未建模。地板按句子归属命题，不追踪会话角色（owner/sharer/assistant）到具体句子的绑定，跨说话人转述句的命题被归到错误说话人名下。
- **retract-treated-current（49）**：撤销语义未建模。地板无状态记忆，已被后续事件撤销的命题仍按当前有效抽取。
- **suggestion-promoted（1）**：建议语气线索词偶合命中，量级上可忽略，但机制同上——无语气建模，命中是偶然的。
- **block 违规 80 / emit-with-flag 未打标 20（test）**：地板无不确定标记概念，对抗载荷按普通事实抽取，命中对抗设计。全语料 132 个对抗场景拦截率 **0%**、54 个无可记场景误报率 **100%**——这两项是「没有语义门」的直接证据，比 P/R 更能说明缺口性质。

全语料侧的 888 个 fp 与 345 个 fn 同源：线索词召回面窄（fn）且无语义过滤（fp），两者共同把 P/R 压在 1% 以下。这正是 P1b 证据约束 LLM 抽取（LLM 抽取 + 证据 span + 人工接纳）要解决的问题。

## 结论与下一步

- 本报告是 P1a 出口基线的**地板证据**：规则地板离门槛差 2~3 个数量级，证明该任务不可由线索词规则达到出口质量，P1b 的证据约束 LLM 抽取路线由此获得必要性论证。
- **本报告不构成放行**：verdict 恒为 null；且 gold 仍为单标注（pilot 语义），出口级宣称前须执行 annotation-pass.mjs 盲评工作流，annotationMode 升为 dual-independent。
- P1b 待办：LLM 抽取 + 证据 span 对齐 + 人工接纳流程；完成后以同一评分口径（manifest v3）重跑本基线以对照。

## 遗留缺口（如实记录）

1. ~~bootstrap 家族聚类 CI 未实现~~ → **已补齐（2026-11-18）**：`score.mjs` 导出 `bootstrapCI`（家族聚类/percentile/2000 次/95%/seed 可复现），`scoreRun` 输出 `scenarioStats` 与 `bootstrap` 字段；本报告三段（全语料/dev/test）的 CI 已按该口径重算。剩余口径缺口：家族内场景相关性未做块内加权（当前簇内按场景等权），P1b 若引入加权需在 manifest 版本化。
2. **gold 为单标注**：出口级 gold 需双人工独立标注（06 §2）；annotation-pass.mjs 已就绪，待第二标注人执行后 annotationMode 升为 dual-independent 再宣称出口级。
3. **三项保护测试随 B4 补齐**：双时间守卫 / tokenizer 计数快照 / 成本闸门见 `pilot/p1a/tests/contract-guards.test.mjs`。

## 复现与产物

- 产物目录：`pilot/p1a/out/exit/exit-20261118T12-21-40Z/`（gitignored，本机留存；重建见上方复现命令），含 `candidates.jsonl` / `meta.json`（含 `contentDigest`）/ `score-{all,dev,test}.json`（含 `bootstrap` 与 `scenarioStats`）
- 复现命令（仓库根）：

```
node pilot/p1a/tools/baseline-runner.mjs pilot/p1a/corpus <out>
node pilot/p1a/tools/score.mjs <cand> pilot/p1a/corpus
```
