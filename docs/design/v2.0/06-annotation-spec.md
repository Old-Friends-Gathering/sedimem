# 06 · 标注规范（v2.0 规格草案）

> doc-kind: contract
> doc-version: 2.0
> status: planned

状态：**planned，r2（自动评测策略修订，待实现冻结）**。来源：[future-architecture.md](../../plans/future-architecture.md) §3.2/§7.1；施工映射 [v2.0-p1.md](../../plans/v2.0-p1.md) §3 D2。

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
| evidence | 期望证据 span（合成语料中精确已知；自动以eventId与原文精确span定位） |
| language | zh/en/mixed |
| shouldReject | 应拒绝理由枚举（无可记/证据不足/仅建议未接受/跨 scope）——用于无可记场景 |
| expectedOutcome | **对抗场景专用**：`block`（管线必须拒绝或标错，计拦截）或 `emit-with-flag`（允许输出但必须带显式标记，无标记 = 逃逸）+ `expectedErrorClass`（期望对应的严重错误类 ID，§4 七类之一）。正场景与无可记场景不携带此字段。对抗 10 类的「应拦住」期望全部由此承载，拦截率分子可机算（04 §4）。**取值判据（R2-F2，类级统一，manifest thresholds.adversarialOutcomeMap 机读）**：载荷会产生事实性错误命题 → `block`（later-correction/tool-failure/same-name/cross-paragraph/conditional/timezone/injection/truncation）；载荷本身可记录但必须带否定或不确定标记 → `emit-with-flag`（negation/suggestion-not-accepted）。同一类内 dev/test 取值必须一致 |
| family | 场景家族 ID |

**「无可记」场景**：标注 `shouldReject` 理由（为什么整段无可记：闲聊/纯操作回显/无命题）；无可记场景与正场景互斥（同一输入不得既在 gold 又标无可记）。

## 2. r2：自动参考评测，不设人工标注前置

2026-11-18用户取消人工评测；本节替代r1的双人工标注、人工裁决及无人工不得发布条款。[旧版快照](history/2026-11-18-manual-r1/06-annotation-spec.txt)保留；当前流程见 [08 §5](08-auto-memory-and-correction.md)。

- 复用盲评包export/import/compare/worksheet/goldset；两个模型执行体互不可见，不看被测系统输出/测试答案。版本化自动裁决策略记录每条理由和分歧，必要时保留未决，不能合并后声称双方均同意。
- `annotationMode: model-dual-blinded`是允许的自动参考集模式，不是需要人工消除的开发阻塞；原来dual-independent仍可作为历史来源标签，但不主动要求用户标注。
- 347条内嵌参考与778条模型并集版本独立；评价永远带goldset/annotation/manifest/匹配规约版本。同义/粒度问题由可执行拆分与匹配规范收敛，不要求用户手工校准。
- 模型参考和judge不是客观真相；语义P/R应称“相对自动参考集得分”，已知错误用确定性证据和时序纠正fixture交叉验证，不掩盖同模型偏差。
- gold工具已有枚举/证据校验继续复用，不变更既有参考数据。出口检查中的历史键annotation-dual保留兼容，但含义改为“参考集来源与产物完整性”，不阻塞于缺人。

## 3. 自动裁决与防泄漏

无依据的参考命题自动标记/拒绝；分歧不能以盲目并集当正确答案。漏标/粒度变更产生新参考版本并重跑全部组，原成绩保留，不按某个候选临时加TP。来源只使用授权合成脱敏事件；真实私密聊天仅作本地授权验证，不能进入公共报告。

已暴露test转regression，泛化结论需新的同协议holdout。独立模型调用也可能同偏差；结果保留来源与局限，但不因此产生人工待办或人工放行条件。
