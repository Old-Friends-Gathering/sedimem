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

### 1.1 命题粒度（granularity@v1，可执行）

两遍盲评只对上 5.6% 的 claim、字段一致率 78.5%，主因不是判断力差异，而是**粒度没有定义**：同一段文本里"什么算一条、一句含两事实怎么切、同义改写算不算同一条"三件事此前无规可依。本节把它定死，并配套可执行校验（`pilot/p1a/tools/granularity-check.mjs`）与 12 场景校准集（`pilot/p1a/granularity/calibration.jsonl`）。

**规则集版本**：`granularity@v1`（manifest `thresholds.granularityRuleSet` 机读；改规则必须升版本 + 重跑全部参考集，原成绩保留不覆盖）。

#### 1.1.1 原子性判据（决定"是不是一条"）

一条 claim = **一个可独立判真假的最小陈述**。三个判据同时满足才算原子：

| 编号 | 判据 | 反例（判为不原子） |
|---|---|---|
| A1 | 能独立判真假：给定上下文，能回答"真/假/无法判定" | "端口和超时都要看" —— 无法判单个真假 |
| A2 | 不可再拆出两个各自可判真假的独立陈述 | "端口是 8080，超时是 30 秒" —— 是两个陈述 |
| A3 | 承载方可复用的稳定信息（实体/属性/取值/决定/偏好/状态），不是过程叙述 | "我先看一下日志" —— 过程叙述，无稳定信息 |

A3 的边界（最容易分歧的三处，按此执行）：

- **工具原始输出**（日志行、堆栈、SQL 结果集）**不逐行记**；只记由它得出的**结论性事实**（"端口是 8080"）。工具输出若本身就是结论（"health 返回 degraded"），可记为一条，role=tool。
- **助手的过程说明**（"我接下来会重跑"）不记；助手对已完成动作的**自称**要记，但 `status=not-done` 或 `assertion.speechAct=complete` 必须与证据一致（工具证据缺失即判严重错误 #5）。
- **会话性指令**（"先别动，我去确认"）不记；对事实的**纠正/撤回**要记（§1 的 status/speechAct 承载）。

#### 1.1.2 拆分规则（命中即必须拆成多条）

| 编号 | 形态 | 处理 |
|---|---|---|
| S1 | 并列连词连接两个独立主谓（"和/与/以及/also/and"） | 拆。例："端口是 8080，而且超时改成 30 秒" → 2 条 |
| S2 | 逗号/分号分出的多个主谓分句 | 拆。例："A 部署在 cn，B 部署在 us" → 2 条 |
| S3 | 同一主体的一组属性并列（顿号列举属性+值） | 按属性拆。例："端口 8080、超时 30s" → 2 条 |
| S4 | 主句 + 条件/因果从句 | **不拆**：条件进 `assertion.condition`，主句成一条。例："如果切换流量，QPS 会翻倍" → 1 条，condition="切换流量" |
| S5 | 引述他人（"他说…"/"文档写着…"） | 1 条，speaker=quoted，不与被引内容重复计 |
| S6 | 比较句（"A 比 B 快 3 倍"） | 1 条，禁止拆成"快"与"慢"两条 |

#### 1.1.3 不可拆（整体即一条）

| 编号 | 形态 | 例 |
|---|---|---|
| U1 | 复合专名/复合标识 | `db-primary-01`、`repo:demo` |
| U2 | 数值+单位/量纲 | `8080`、`30s`、`3 倍` |
| U3 | 否定修饰 | "不支持 8081" → 1 条（negated=true），**禁止**拆成"支持 8081"+"否定" |

#### 1.1.4 同一性判定（决定"两条算不算同一条"）

比较前先归一化：去首尾空白与句末标点、全半角统一、连续空白折叠、数字与单位标准化（`30 秒`/`30s`/`30 s` → `30s`）、同义动词表（改成/改为/变更/change → change）。

归一化后按**判定键**比较：`scope + subject + predicate + value` 四元组（缺字段时按可得字段），辅以 `speechAct + negated`。判定：

| 编号 | 情形 | 结论 |
|---|---|---|
| I1 | 判定键全等 且 speechAct/negated 一致 | **同一条**（不重复计入 gold，不因措辞不同算两条） |
| I2 | 判定键全等 但 speechAct 或 negated 不同 | **不同条**（如"支持 8081"与"不支持 8081"是两条，后者 negated=true） |
| I3 | 一条的判定键是另一条的**真子集**（少字段） | **不同粒度**：子命题不构成 TP；复合未拆的一方判违规（§1.1.2），由校验器报错而非评分层消化 |

同义改写（"端口是 8080"vs"8080 是它的端口"）归一化后判定键一致 → 按 I1 同一条。

#### 1.1.5 与评分和抽取的关系

- 评分匹配（[04](04-scoring-and-splits.md) §2）以判定键 + speechAct/negated 为准；子命题计 FP+FN、超集计 FP 的口径不变，粒度违规**优先在校验层拦下**（复合命题 → `corpus-validate` 报"复合命题禁止"）。
- 抽取器（[09](09-extraction-pipeline.md) §2）输出必须逐条原子；一次抽取返回含 S1–S3 形态的单条命题，等同结构校验失败，落 `schema-invalid`。
- 校准不等于改数据：粒度规则变更产生新的参考集版本（`goldset-vN`），原版本与成绩只读保留。

#### 1.1.6 校准集（12 场景）

`pilot/p1a/granularity/calibration.jsonl` 每行给出：`calibrationId`、`language`、`text`（一段合成脱敏文本）、`expectedClaims`（期望拆出的条数）、`hits`（命中的拆分/不可拆规则编号，如 `["S1","U2"]`）、`verdict`（`valid-atomic` / `must-split` / `not-a-claim`）。

覆盖要求：S1–S6 各至少 1 例、U1–U3 各至少 1 例、A3 三类边界各至少 1 例。I1–I3 的同一条/不同条/子集判定由 `pilot/p1a/tests/granularity-check.test.mjs` 用构造样本断言（不塞进校准语料，避免与文本规则互相循环验证）。校验器 `granularity-check.mjs` 对每条校准样本断言：`expectedClaims` 与实际拆分提示一致、`verdict` 与 `isAclaim`/`isAtomic` 判定一致。

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
