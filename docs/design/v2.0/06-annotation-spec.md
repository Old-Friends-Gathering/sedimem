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
4. **机具落地（`pilot/p1a/tools/annotation-pass.mjs`）**：`export` 出盲评包 → 两人各填 `import` 校验 → `compare` 一致性报告 → `worksheet` 裁决表（每行 `resolution` 初值 null）→ 人工裁决 → `goldset` 生成版本化 gold 集。
   - **fail-closed**：裁决表存在任一 `resolution: null`、非法 `resolution`（合法仅 `a|b|merge|both`）、或场景只在一侧标注时，`goldset` 拒绝产出并列出错误——不允许「边生成边补裁决」。
   - **裁决语义**：`a`/`b` = 采用该侧版本；`merge` = 文本取 A、字段级分歧取 B（逐字段可核对）；`both` = 两侧 claim 都保留（仅用于 claim-only 行）。
   - **无可记一致性**：最终 `shouldReject: true` 的场景 `gold` 恒为空——不因另一侧标了 claim 而带出 gold。
   - 产物 `goldset-vN.json` 含 `annotationMode: dual-independent`、`goldsetVersion`、`frozenAt`、逐场景 gold 与 `stats`；写入 `pilot/p1a/out/`（gitignored，登记于 [docs/12 §12.5](../../12-data-map.md)）。

**独立标注人的定义**（R1 修订锚定）：
- 必须是**人工**且**独立**——模型辅助标注可以声明，但**永不构成**独立标注人；
- 同一人重复标注两遍**不称**独立；
- 独立性包含信息隔离：第二标注人不得接触第一标注人的输出与裁决记录；
- **裁决人回避**：裁决人不得是两份标注的任一标注人——维护者若参与标注，则另指派裁决人（裁决偏向自身标注无法排除）。

## 3. 单人现实（pilot 诚实标注）

- pilot v0 用**单标注 + 显式 pilot 标记**；一切 pilot 结果不得表述为「gold 验收通过」。
- **第二标注人到位是 P1a 出口的硬前置**：它阻塞出口级 gold 冻结，**不阻塞**规格/工具链交付（P1a 可以先行交付工具与 pilot 语料）。这是用户决策项，届时由维护者指派。
- 所有评测输出必须带 `annotationMode: pilot | dual-independent | model-dual-blinded` 字段。

### 3.1 降级模式 `model-dual-blinded`（模型盲评双遍 + 维护者裁决）

当第二**人工**标注人暂时不可用、而出口又必须推进时，允许下列**降级**路径，并把降级写进产物，不得升格表述：

- **两遍相互不可见的盲评**：pass1 与 pass2 由**不同执行体**产出，双方都只能看盲评包（`gold`/`shouldReject`/`adversarial`/`split` 已剥离），互不可见对方标注；任一方向泄漏即该遍作废。
- **维护者裁决**：分歧逐条记录 `resolution ∈ a|b|merge|both`（§2 裁决表），未裁决行一律阻断 goldset 生成（fail-closed）。
- **必须声明的限制**（写进 goldset、评测输出与报告）：
  1. 两遍均为**模型**标注，不满足 §2「两份互不可见的人工独立标注」；
  2. 因此 `annotationMode` 只能是 `model-dual-blinded`，**不得**写成 `dual-independent`，也不得据此宣称「gold 验收通过」；
  3. 一致性数字（字段一致率）只作**标注稳定性证据**，不作人工标注一致率；
  4. 任何对外实验结论（§7.2 收益三项、P1b 抽取门槛）仍以人工双标注复核为硬前置。
- **退出条件**：一旦人工第二标注到位，用同一批场景重跑 pass2 → 重算一致率与裁决 → 生成 `goldset-v2` 并把 `annotationMode` 升为 `dual-independent`；`goldset-v1` 保留为历史版本。

## 4. 漏标裁决与防泄漏

- **漏标流程**：评测发现「候选语义正确但 gold 漏标」→ 走裁决（§2.2 同机制）→ 版本化新 gold → **重跑全部组**（[04-scoring-and-splits.md](04-scoring-and-splits.md) §3 硬规则 2）。
- **标注者防泄漏**：标注者不得在标注前阅读打分器实现、基线输出或任何候选产物（评分器隔离的反向约束）；标注完成后标注记录声明「标注时未接触评测产物」。
- 语料与 gold 全部合成脱敏（[v2.0-p1.md](../../plans/v2.0-p1.md) §4 红线 1）；真实 transcript 只进本地验证轨。
