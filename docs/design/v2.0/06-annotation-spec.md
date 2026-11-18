# 06 · 标注规范（v2.0 规格草案）

> doc-kind: contract
> doc-version: 2.0
> status: planned

状态：**planned**——冻结前允许修订。来源：[future-architecture.md](../../plans/future-architecture.md) §3.2/§7.1；施工映射 [v2.0-p1.md](../../plans/v2.0-p1.md) §3 D2。

## 1. gold claim 字段

每条 gold 是一个结构化记录（与候选 schema 字段对齐，见 [01-candidate-schema.md](01-candidate-schema.md) §1）：

| 字段 | 内容 |
|---|---|
| claim | 标准命题句（一句一条，禁止复合） |
| role | 该命题的正确 speaker 归属（user/assistant/tool/unknown） |
| assertion | **断言框架（机判字段，与候选 01 §1 一一对应）**：`speechAct`（state/suggest/agree/decide/complete/retract 闭集）+ `negated`（布尔）+ `about`（主体）+ `condition`（条件从句或 null）。七类严重错误的 #3 否定反转（negated）、#4 建议变批准（speechAct）、#5 未做变已做（status=not-done）从本字段机判（[04-scoring-and-splits.md](04-scoring-and-splits.md) §4） |
| type | 闭集 6 类之一（01 §4） |
| scope | 适用分库 scope。**语义：标注者外部知识**（会话绑定先验）——scope 不从事件文本派生（quote 派生口径只约束 evidence），抽取器的 scope 归属来自宿主绑定上下文，不是文本内容；对抗 same-name-cross-project 的 scope 区分同样依赖绑定先验 + 文本线索。禁止用统一占位 scope 当垃圾桶（R2-F3） |
| status | 命题状态：active/retracted/conditional/suggestion-only/**not-done**（未完成的期望：工具失败、计划中的动作——支撑严重错误 #5 机判） |
| time | 双时间：observedAt + assertedValidFrom/To（原文可解析时） |
| evidence | 期望证据 span（合成语料中精确已知；真实来源标注时人工圈定） |
| language | zh/en/mixed |
| shouldReject | 应拒绝理由枚举（无可记/证据不足/仅建议未接受/跨 scope）——用于无可记场景 |
| expectedOutcome | **对抗场景专用**：`block`（管线必须拒绝或标错，计拦截）或 `emit-with-flag`（允许输出但必须带显式标记，无标记 = 逃逸）+ `expectedErrorClass`（期望对应的严重错误类 ID，§4 七类之一）。正场景与无可记场景不携带此字段。对抗 10 类的「应拦住」期望全部由此承载，拦截率分子可机算（04 §4）。**取值判据（R2-F2，类级统一，manifest thresholds.adversarialOutcomeMap 机读）**：载荷会产生事实性错误命题 → `block`（later-correction/tool-failure/same-name/cross-paragraph/conditional/timezone/injection/truncation）；载荷本身可记录但必须带否定或不确定标记 → `emit-with-flag`（negation/suggestion-not-accepted）。同一类内 dev/test 取值必须一致 |
| family | 场景家族 ID |

**「无可记」场景**：标注 `shouldReject` 理由（为什么整段无可记：闲聊/纯操作回显/无命题）；无可记场景与正场景互斥（同一输入不得既在 gold 又标无可记）。

## 2. 双独立标注流程（出口级 gold 的定义）

1. 两份**互不可见**的人工独立标注（标注人 A 不看 B 的产物，反之亦然）。
2. 维护者**裁决**分歧：逐条比对，产出裁决记录（谁对/为什么/最终版本）。
3. **版本化**：裁决后的 gold 集 = 一个版本号（goldset-v1、goldset-v2……）；任何后续修订出新版本并保留旧版。

**独立标注人的定义**（R1 修订锚定）：
- 必须是**人工**且**独立**——模型辅助标注可以声明，但**永不构成**独立标注人；
- 同一人重复标注两遍**不称**独立；
- 独立性包含信息隔离：第二标注人不得接触第一标注人的输出与裁决记录；
- **裁决人回避**：裁决人不得是两份标注的任一标注人——维护者若参与标注，则另指派裁决人（裁决偏向自身标注无法排除）。

## 3. 单人现实（pilot 诚实标注）

- pilot v0 用**单标注 + 显式 pilot 标记**；一切 pilot 结果不得表述为「gold 验收通过」。
- **第二标注人到位是 P1a 出口的硬前置**：它阻塞出口级 gold 冻结，**不阻塞**规格/工具链交付（P1a 可以先行交付工具与 pilot 语料）。这是用户决策项，届时由维护者指派。
- 所有评测输出必须带 `annotationMode: pilot | dual-independent` 字段。

## 4. 漏标裁决与防泄漏

- **漏标流程**：评测发现「候选语义正确但 gold 漏标」→ 走裁决（§2.2 同机制）→ 版本化新 gold → **重跑全部组**（[04-scoring-and-splits.md](04-scoring-and-splits.md) §3 硬规则 2）。
- **标注者防泄漏**：标注者不得在标注前阅读打分器实现、基线输出或任何候选产物（评分器隔离的反向约束）；标注完成后标注记录声明「标注时未接触评测产物」。
- 语料与 gold 全部合成脱敏（[v2.0-p1.md](../../plans/v2.0-p1.md) §4 红线 1）；真实 transcript 只进本地验证轨。
