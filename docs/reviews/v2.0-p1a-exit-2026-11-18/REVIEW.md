# B4 出口冻结批次 · 对抗审核报告（2026-11-18）

> doc-kind: history
> doc-version: 1.4

审核对象：分支 `p1a/exit-freeze` 的 B4 批次（九项冻结确认 / 双标注工作流工具 `annotation-pass.mjs` / exit 基线正式报告 / 文档同步）。上位权威：[docs/plans/future-architecture.md](../../plans/future-architecture.md) §0.4、§7.1；施工计划：[docs/plans/v2.0-p1.md](../../plans/v2.0-p1.md) §2、§7（B4 行）。审核者：GLM-5.3 独立子代理实例（`r2-b4-audit`，只读审核，2026-11-18）。

## 审核结论

**通过**——无 blocker；2 项 major（F1 冻结证据口径、F2 重复 claim 丢失）+ 7 项 minor，**全部在合并前修订**。审核者实测确认：盲评包零 gold 泄漏、工具全程 fail-closed、基线数字逐项吻合产物 JSON、README CLI 与实现一致、13 个证据链接可解析、无越权「通过/验收/达标」措辞。

## R2 发现与修订对照

| # | 严重度 | 位置 | 发现 | 修订 |
|---|---|---|---|---|
| F1 | major | `docs/design/v2.0/README.md` 冻结核验表第 3/6/7 行 | 证据仅文档/ADR 文本；计划 §2:42/45/46 要求可执行保护测试（双时间断言、tokenizer 计数快照、成本闸门拦截），全仓无对应测试 | 新增 `pilot/p1a/tools/contract-guards.mjs` + `pilot/p1a/tests/contract-guards.test.mjs`（15 用例，TDD）：`checkDoubleTime`（asserted* 不得作系统区间、asOf 穿越反例）、`estimateTokens`+`TOKENIZER_DECLARATION`（计数快照：同输入同计数）、`checkCostGate`（无配置 `E_COST_CONFIG_MISSING` / 超上限 `E_COST_LIMIT_EXCEEDED` 停机）；冻结表 3/6/7 行证据改挂该测试 |
| F2 | major | `pilot/p1a/tools/annotation-pass.mjs` `indexByClaim` | 同遍标注两条归一化同键 claim，后者覆盖前者 → 分歧被静默掩盖（实测 both=1, aOnly=0） | 改 `Map<key, gold[]>` 按序配对，多出进 aOnly/bOnly 并产出裁决行；复验 before `{both:1,aOnly:0}` → after `{both:1,aOnly:1}` + `claim-only-in-A` 行 |
| F3 | minor | `docs/reviews/v2.0-p1a-exit-2026-11-18/BASELINE.md` 复现命令 | 照抄执行失败（根目录无 `corpus/`） | 改为 `node pilot/p1a/tools/baseline-runner.mjs pilot/p1a/corpus <out>` 与 `score.mjs <cand> pilot/p1a/corpus` |
| F4 | minor | BASELINE.md 方法论/结果表 | 宣称 bootstrap 家族聚类为主口径（04 §3）但只报 Wilson CI，未声明描述性 | 方法论改为如实声明：本版仅 Wilson（描述性）、bootstrap CI 未实现；结果表加表注；新增「遗留缺口」节列 3 项（bootstrap CI / 单标注 gold / 三项保护测试随 B4 补齐） |
| F5 | minor | `adr-101-tokenizer.md` / `adr-102-cost-quota.md` 头部 | 仍 `status: proposed`，与自身「随规格包冻结转 accepted」承诺不符 | 两份 ADR 改 `状态：accepted（2026-11-18，随九项冻结）`，头部去 `> status:` 行 |
| F6 | minor | `annotation-pass.mjs` 归一化碰撞 | `'v1.2 已发布'` 与 `'v1 2 已发布'` 归一后同键被判同一命题（与 score.mjs 同源，低频） | `agreementReport` 新增顶层 `normalizedKeyCollisions`（供裁决人复核），不擅改 normalizeClaim 口径 |
| F7 | minor | `collectPasses` / `fieldValue` | ① 同场景多行 shouldReject 冲突静默取首个非空；② 双方均 null 的字段计为一致，膨胀一致率 | ① 冲突记 `shouldRejectConflicts` + `fieldDisagreements{field:'shouldReject'}`；② 一致率只对「至少一方非 null」原子计数，双 null 计入 `totals.bothNullAtoms` |
| F8 | minor | `annotation-pass.test.mjs` | 用例标题误导（未测已裁决路径）；边界路径无用例 | 标题改「初始 resolution 均为 null 待人工填写」；新增 4 边界用例（fieldAgreement=null、多行合并、F2/F6 路径） |
| F9 | minor | `importBlindAnnotation` | `covered` 语义与枚举校验边界未声明；未校验 speechAct/status | 补 `assertion.speechAct` / `status` 闭集校验（报错含字段名与合法值） |

## 修订后验证

- `node --test pilot/p1a/tests/*.test.mjs` → **101 pass / 0 fail**（新增 contract-guards 15 + annotation-pass 7 用例）。
- `node pilot/p1a/tools/annotation-pass.mjs export --corpus pilot/p1a/corpus --out <tmp>` → 218 场景，`grep` gold 侧键 = 0。
- `node pilot/p1a/tools/baseline-runner.mjs pilot/p1a/corpus <tmp>` + `score.mjs` → 2/888/345（与 BASELINE.md 一致）；`score-test` 0/484/210、`score-dev` 2/404/135 逐项吻合。
- 门禁：docs-drift 无 finding（35 文档）、quality 15/15、security 9/9。

## 正面核查（审核者实测确认）

1. 盲评包零 gold 泄漏（递归 strip 覆盖嵌套/数组；family 命名无对抗暗示；manifest 亦无泄漏）。
2. fail-closed：annotation-pass 无任何 verdict/pass/fail 输出路径；`fieldAgreement` 无匹配对时为 null 不除零；score JSON `verdict: null`。
3. 基线数字与产物 JSON 全字段一致（totals/语言组/severe/对抗违规/零输出）。
4. 复现可执行：重跑得到同一 2/888/345。
5. README CLI 签名与实现一致；pilot 测试数属实。
6. 冻结表可执行证据为真（protocol-sim 非法迁移 `E_ILLEGAL_TRANSITION`、trust 恒 T2 断言、幂等五件套；corpus-validate 闭集枚举）。
7. 无越权措辞：BASELINE 明确「不构成放行」；单标注 + 用户自任第二标注人的显式偏离在三处如实记录；未宣称出口级 gold 已达成。
8. 13 个证据链接从 `docs/design/v2.0/` 出发全部可解析。

## 保留门禁（未在本轮解除）

- push/PR 前的独立双审核仍是流程门禁（本报告即其中一份）。
- 出口级 gold 需第二标注人执行 `annotation-pass.mjs` 盲评工作流后 `annotationMode` 升 `dual-independent`；本轮冻结不改变该条件。
