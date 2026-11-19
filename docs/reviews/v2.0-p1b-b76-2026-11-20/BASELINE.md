# P1b 参考集重跑基线（gate 口径，2026-11-20）

> doc-kind: history
> doc-version: 1.4

**结论先行**：参考集（goldset-v1，353 条 gold claim / 218 场景）经真管线闸门后 **accept 277（78.47%）/ hold 17（4.8%）/ reject 59（16.7%）**，七类严重错误实测 **0**（受口径限制，见 §5）。闸门的主要损失集中在**机判词表与标注口径不一致**（否定 43 例 + 完成式 11 例，占 gold 的 15.3%），而非抽取质量。**P1b 不放行**：09 §11 要求「参考集重跑 + 七类严重错误零容忍 + 时序指标冻结」同时满足，当前假阴性率过高，须先修两处口径缺口。

## 1. 口径（必须先读）

- **这是闸门测量，不是抽取评测。** 输入是 goldset-v1 的 gold claim（= 假设抽取器 100% 正确），因此本报告只回答「真陈述能否穿过 R3/R4/R6/R7 闸门并被接纳」，不回答抽取 P/R。抽取质量以 [B4 基线报告](./BASELINE.md) 为准（P 0.22% / R 0.58%，规则地板）。
- **参考集来源**：`pilot/p1a/granularity/…` 无关；goldset 为 `goldset-v1`，标注模式 `model-dual-blinded`（两遍模型盲评 + union-policy@v1 裁决），两遍交集 `confirmedByBoth` 仅 44/778（5.6%）——参考集**不是客观真值**，本报告的「假阴性」应读作「与机器口径冲突」。
- **工具**：`pilot/p1b/tools/reference-run.mjs`（`PIPELINE_VERSION=pipeline@b7.6-oracle-gate`），复用真管线 `pipeline.mjs`（含 R4 异议生成器、R7 CAS/收据/恢复），不传 `ctx.objection`、不走任何后门。
- **产物**：`pilot/p1b/out/ref-run/ref-<ts>/report.json`（gitignored；含每场景行级结果）。

## 2. 结果

| 分组 | gold | accept | hold | reject | accept 率 |
|---|---:|---:|---:|---:|---:|
| 全量 | 353 | 277 | 17 | 59 | **78.47%** |
| test（100 对抗场景） | 215 | 157 | 15 | 43 | 73.02% |
| dev（118 常规/无可记场景） | 138 | 120 | 2 | 16 | 86.96% |

行分布（`row:reason`）：

| 行 | reason | 计数 |
|---|---|---:|
| 9 | policy-accept | 277 |
| 6 | unresolved（objectionKind=temporal-drift） | 17 |
| 5 | assertion-mismatch | 53 |
| 2 | cross-scope-leak | 5 |
| 3 | injection-suspected | 1 |

## 3. 闸门假阴性归因（53 例 assertion-mismatch）

用管线真实 `violations` 归类（同一 gold 可命中多条，去重后 53 例）：

| 子类 | 计数 | 说明 |
|---|---:|---|
| `negated` | 43 | 34 例「引文含否定词但 gold 标 negated=false」——如 `validate scopes per-route, not a global admin check`（`not` 属并列否定，不否定本句断言）；9 例「引文无否定标记但 gold 标 negated=true」——如 `no longer gating v3.2`（多词否定未被词表识别） |
| `speechAct-complete` | 11 | gold 标 `complete` 且证据 role=user 陈述「已完成」，机判要求「工具输出或用户直接确认」→ 判定过严 |

另有 **5 例 `cross-scope-leak`（source-scope-unbound）**：参考集运行未绑定 `sourceScope`，管线按 m6 守卫 fail-closed。这不是缺陷而是设计行为——真实 adapter 必须绑定 scope；参考集测量下应记为「口径内拒收」。

**1 例 `injection-suspected`**：该 gold 引文所在事件文本命中注入模式词表，属对抗场景 S*（注入类）的正常拦截，但拦的是「参考集中的合法 claim」，说明注入词表对本类语料偏宽，需要按场景家族白名单复核。

## 4. 七类严重错误

按 09 §3 与 04 §4 的机判：**实测 0**（无 `unsupported-fact`、`negation-flip`、`speaker-misattribution`、`suggestion-promoted`、`retract-treated-current`、`not-done-became-done`、`cross-scope-leak` 被错误写入真相层）。

**这条 0 的口径限制必须同时声明**（否则是自欺）：

1. 输入是 gold claim，本身与证据一致，因此 0 是**构造性结果**——它证明的是「闸门未把不成立的 claim 放行」，不能证明「抽取+闸门整体不产生严重错误」。
2. 5 例 cross-scope 被 row 2 拒收、1 例注入被 row 3 拒收，均在真相层之外，符合零容忍。
3. 真正的严重错误零容忍验证必须在 B7.7（真抽取器接入：LLM 抽取 → 闸门）重跑，届时本题 0 需重测并版本化。

## 5. 时序指标（冻结候选值）

测量环境：本机 Node 24、单进程、内存快照（无 LLM 调用）。单位 ms，`n` 为样本数（ingest 按场景 164、decide/commit 按候选 353/277）：

| 阶段 | p50 | p90 | p99 | max |
|---|---:|---:|---:|---:|
| R2 ingest（解析证据+造候选） | 0.009 | 0.018 | 0.145 | 1.218 |
| R6 decide（矩阵+异议） | 0.011 | 0.017 | 0.222 | 0.885 |
| R7 commit（CAS+收据+落库） | 0.001 | 0.002 | 0.086 | 0.544 |

全量 218 场景墙钟 ≈ 13 ms（含 setup），不构成瓶颈。冻结口径：这三行即「纯闸门开销」，**不含 LLM 抽取**；抽取延迟须在 B7.7 单独测量并与本表分栏，禁止混算。

## 6. 复现

```bash
node pilot/p1b/tools/reference-run.mjs --corpus pilot/p1a/corpus --out pilot/p1b/out/ref-run
node --test pilot/p1b/tests/reference-run.test.mjs
```

## 7. 遗留缺口与下一步

1. **否定词机判与标注口径对齐**（43 例）：① 支持多词否定（`no longer`、`not any more`、`never again`）；② 并列否定（`, not X`）不应否定主断言；③ 与 06 §1.1 的 negated 定义同步措辞。
2. **complete 判据放宽**（11 例）：允许 role=user 的完成式陈述（`we completed/we shipped`）以 `complete` 通过，同时把「助手自称完成」仍判 `assertion-mismatch`（这是原设计要防的）。
3. **注入词表按家族复核**（1 例）：注入类对抗场景的词表需区分「场景诱导语」与「正常业务文本」。
4. **B7.7 真抽取器接入**是七类严重错误零容忍的正式验证点；在此之前本报告的 0 不得对外当作质量结论。
