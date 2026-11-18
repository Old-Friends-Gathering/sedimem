# v2.0-p1 B3 批次审核报告（R2 语料对抗审核）

> doc-kind: history
> doc-version: 1.4

审核对象：B3 批次 exit 语料（分支 `p1a/corpus-exit`）——[pilot/p1a/corpus/](../../../pilot/p1a/corpus/)（218 场景 / 347 gold / 15 家族）、[corpus-validate.mjs](../../../pilot/p1a/tools/corpus-validate.mjs)、[split-corpus.mjs](../../../pilot/p1a/tools/split-corpus.mjs)、[eval-manifest.json](../../../pilot/p1a/config/eval-manifest.json) v3、规格包修订（[06-annotation-spec.md](../../design/v2.0/06-annotation-spec.md) / [04-scoring-and-splits.md](../../design/v2.0/04-scoring-and-splits.md)）。
上位权威：[docs/design/v2.0/](../../design/v2.0/README.md) 规格包 + [docs/plans/v2.0-p1.md](../../plans/v2.0-p1.md)。
审核方式：GLM-5.3 子代理（zai-coding-cn）独立实例，对抗视角=标注质量/对抗有效性/切分与配额/泄漏面/校验面。声明：子代理审核是当前可执行的最强独立审核，最终裁决权在维护者。

## R2 结论：不通过（1 blocker + 3 major + 3 minor）→ 全部修订

| 编号 | 严重度 | 发现 | 修订 |
|---|---|---|---|
| F1 | blocker | 89/106 个 block 对抗场景 `target.eventId ∈ gold evidence`（normalize-adversarial 回退总落在良性 gold 内容；score.mjs touched 按整事件匹配 → 完美抽取被判逃逸，拦截率永远 0%） | 双轨修订：① 84 个场景按类线索重选 bait（fix-r2-f1f2.mjs BAIT_PATTERNS zh/en 正则；回退=最后一个非证据事件）② 5 个双事件极简场景（S010/S025/S031/S034/S043——每事件都是 gold 证据）无法重指 → **score.mjs touched 判定改「非 TP 候选触碰 target」**（TP 豁免：完美抽取只产出 gold 不受罚；产出 gold 之外命题即违规），emit 侧改「未打标候选触碰即违规」（打标候选不遮蔽）。04 §4 拦截口径与实现同步 |
| F2 | major | 类内 dev/test expectedOutcome 不一致（negation dev block/test emit；timezone/conditional 相反） | 全量按判据统一：载荷产生事实性错误命题→block（8 类）；载荷可记录但须带否定/不确定标记→emit-with-flag（negation/suggestion-not-accepted）。relabel 13 条；判据写入 06 §gold 字段表 expectedOutcome 行 + manifest `thresholds.adversarialOutcomeMap`（机读）+ corpus-validate 硬校验 |
| F3 | major | 264 条 gold `scope=repo:demo-a` 不在事件文本——scope 成默认垃圾桶，与「quote 派生」口径矛盾 | 语义澄清（非数据错误）：scope=标注者外部知识（会话绑定先验），不从事件文本派生。写入 06 §scope 行：禁止统一占位 scope 当垃圾桶；same-name 场景 scope 区分依赖绑定先验+文本线索 |
| F4 | major | 24 场景 61 处逐字 assistant 填充句模板（「Noted for the log—…」×61） | fix-r2-f4f5f6.mjs：ZH_POOL/EN_POOL 各 7 条自然回应池，scenarioId+index hash 确定性替换（53 处实际替换，只动非 gold 证据事件） |
| F5 | minor | truncation-gap 场景无具名 bait（只有元描述，缺失计划内容不出现在事件里） | 13 个 TRU 场景追加具名拒绝事件（TRU_BAIT 按 15 家族两步骤名 + TRU_TEMPLATES×3 zh/en；eventId 顺延）——缺失计划的实体名现在出现在后续事件中，抽取器不得外推 |
| F6 | minor | timezone 相对日期在对话内被消解（助手补出绝对日期=拆弹，13 个 TIM 场景全部失效） | 7 个安全场景（gold 不引用消解事件：S126/S131/S178/S192/S196/S051/S052）删除对话内消解句；6 个 target 悬空场景指回 gold 证据事件（相对日期句本身）。绝对日期只能经 queryTime 推出 |
| F7 | minor | 校验面缺口：claim 长度无上限、status×speechAct 组合非法（suggest+active、complete+fact）、block target∈gold evidence 无提示 | manifest v3 新增 `claimMaxChars=100`（实测 p50=36/p90=57/p99=70/max=78）、`candidateComboRules`（suggest⇒status∈[suggestion-only,conditional]；retract⇒retracted；complete⇒type=[task-state]）+ corpus-validate 三条硬校验 + `collectWarnings`（block target∈gold evidence → warning 非阻断）。数据侧修正 4 条 complete⇒fact gold 为 task-state |

抽查通过项（审核者确认）：347 gold quote 全部唯一子串、eventId 前缀合规、observedAt 区间合理、家族分布健康（15 家族 9–21/家族）、test 每类恰 10、同家族跨集 dice 最高 0.721（< 0.85 阈值）。

## 修订后验证

- corpus-validate exit：0 errors / 0 quotaFails（218 场景/347 gold/对抗 test 每类 10）；split --check 通过（家族两端覆盖 + 跨集近重复 0）。
- 测试：pilot 全量 73/73（score 19+4 新、corpus-validate 22+5 新、split 4、protocol-sim 15、baseline-runner 9、review 3）。
- 门禁：quality 15/15、security 9/9、docs-drift 无 finding（33 文档）。
- 诚实声明：本轮 gold 为**单标注人（维护者）机助草稿**；出口级双人工独立标注是 P1a 出口硬前置（v2.0-p1 §5/D2），本批次只满足 pilot 级标注与结构校验。

## 审核者无发现项证据（摘要）

- 场景与 gold 结构：quote 唯一子串（含中英混排与标点）、eventId `SNNN-mNNN` 前缀=场景 ID、双时间字段齐全、expectedErrorClass 全部在七类闭集。
- 切分：作者指定 split（对抗→test、正常/无可记→dev）经 `--check` 复核；家族 15 个两端都有场景；跨集 Dice 最高 0.721。
- 语料总量：218 场景（zh 108 / en 102 / mixed 8）、gold 347、无可记 54（≥50 exit 配额）、对抗 106（test 100 + dev 6）。
