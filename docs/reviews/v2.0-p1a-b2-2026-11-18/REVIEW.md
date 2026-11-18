# v2.0-p1 B2 批次审核报告（R2 对抗审核）

> doc-kind: history
> doc-version: 1.4

审核对象：B2 批次实现（分支 `p1a/baseline-runner`）——[baseline-runner.mjs](../../../pilot/p1a/tools/baseline-runner.mjs) / [score.mjs](../../../pilot/p1a/tools/score.mjs) / [review.mjs](../../../pilot/p1a/tools/review.mjs) + 三份测试 + [pilot/p1a/README.md](../../../pilot/p1a/README.md)。
上位权威：[docs/design/v2.0/](../../design/v2.0/README.md) 规格包（01/04/06）+ [docs/plans/v2.0-p1.md](../../plans/v2.0-p1.md)。
审核方式：GLM-5.3 子代理（zai-coding-cn）独立实例，对抗视角=泄漏面/一对一计分/fail-closed/分组聚合/复核只读/协议一致性/测试强度/CI 门禁面。声明：子代理审核是当前可执行的最强独立审核，最终裁决权在维护者。

## R2 结论：不通过（1 blocker + 2 major + 5 minor）→ 全部修订后通过

| 编号 | 严重度 | 发现（文件:行） | 修订 |
|---|---|---|---|
| 1 | blocker | 抽取器读 `scenario.shouldReject` 短路返回零候选（baseline-runner.mjs:55）——shouldReject 是 gold 侧标注，等于偷看标准答案；与 README 红线直接矛盾 | 移除短路；无可记内容必须靠 ACK/短句规则自然产出零候选；`zeroOutputScenarios` 只陈述抽取侧事实（全部零候选场景），是否正确由评分层对照 gold 判定；新增「不偷看 gold」专项测试（同内容加/不加 shouldReject 产出一致） |
| 2 | major | suggestion-promoted 检查 `['state','decide']`（score.mjs:74），04 §4 定义为「suggest 被记成 agree/decide」——漏检 agree、误检 state | 改 `['agree','decide']`；补测试：agree/decide 计、state 不计 |
| 3 | major | cross-scope-leak 判定 `c.scope !== g.scope`（score.mjs:77）未豁免 `scopeUnresolved` 占位——基线候选 scope 恒 `pilot:synthetic`，每个 TP 都误计泄漏 | 加 `!c.scopeUnresolved` 豁免；补测试：占位 scope 不计、已解析 scope 不一致照计 |
| 4 | minor | 七类 severe 只在 TP 匹配候选上执行，FP 候选的 severe 逃逸漏计 | FP 候选对「本场景未匹配 gold」做错类检查（每候选每类一次，保守口径）；补测试：未匹配候选把已撤回事实当当前事实 + 证据不可定位均计数 |
| 5 | minor | unsupported-fact 只查 evidence[0] | `evidenceSevere` 校验全部 evidence 条目，任一不可定位即计；补多证据测试 |
| 6 | minor | exit 阶段零输出不通过的执行未留接口 | 报告补 `zeroOutputPolicy` 字段声明（04 §2：precision 未定义即不通过，exit 门禁执行，pilot 只列清单） |
| 7 | minor | tie-break 未声明简化（按数组顺序取首个精确匹配） | 报告补 `pairing: 'first-exact-match; substring=FP+FN'` 声明（04 §2 最终裁决交人工/复核层） |
| 8 | minor | schemaVersion 用字符串 `'pilot-1'`；provenance.provider `baseline-rules` 不在 01 §1 闭集 | 改整数 `1`；provider 改闭集值 `rule`，抽取器版本移到 `provenance.tool: 'baseline-rules@pilot-1'`；测试锁字段 |

## 修订后验证

- pilot 测试 59/59（新增/改写 6 个用例锁住全部修复点）；`node --test` 显式列文件。
- 端到端重跑（修复后诚实数字）：tp=1 / fp=110 / fn=71（P≈0.9% / R≈1.4%，规则地板）；severe：negation-flip=29、speaker-misattribution=39、suggestion-promoted=1、cross-scope-leak=0（豁免生效）；adversarial block=26 / emit-with-flag=6；verdict=null（fail-closed）。
- 门禁：quality 15/15、security 9/9、docs-drift 无 finding。
- 无新发现的正面核查：deriveInputHash 只含事件文本（测试锁定）；一对一计分 used Set；mixed 双计 zh/en；family 全场景聚合；review.mjs 只读 + E_NOT_IMPLEMENTED_P1B；candidateId 与 protocol-sim 同源；Q2 只扫 versions/CURRENT 不触发。

## 审核者无发现项证据（摘要）

泄漏面（除 #1）、一对一计分、fail-closed verdict、Wilson 公式、分组聚合、复核只读、候选协议一致性、测试强度、CI 门禁面均逐项给出文件:行级证据；缺口用例（scopeUnresolved×cross-scope、suggest→agree）恰为 #2/#3，已随修复补齐。
