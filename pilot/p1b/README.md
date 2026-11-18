# pilot/p1b —— P1b 保护测试与内存模拟器

规格：[09-extraction-pipeline](../../docs/design/v2.0/09-extraction-pipeline.md)（§10 保护测试清单 §10.0 桩接口契约）。
本目录只放**可执行保护测试**与它们的内存模拟器，不含生产管线。

## 边界（红线）

1. 不写真相层文件、不联网、不读 `pilot/p1a/corpus` 或 `docs/reviews`（测试只构造自己的事件与候选）。
2. 模拟器里的 `accept` **不提升 trust**：真相层记录恒 `T2`，`trustWrites()` 恒 `[]`。
3. 候选状态迁移只走 `protocol-sim` 的闭集；`hold` 不是状态，是 `pending` + `workflow.hold` 注解。
4. 模拟器绿灯**不等于**质量通过（09 §10.1）：P1b 放行仍需真实现全绿 + 参考集钉死 + 七类严重错误零容忍。

## 工具

| 文件 | 作用 |
|---|---|
| `tools/r2-sim.mjs` | r2 自动决策模拟器（`createR2Sim`）：R0/R1 摄取与证据解析、R3 五条机判、自动决策矩阵 9 行、聊天纠正 7 类、R7 提交/CAS/恢复、R8 事件与配额闸门 |
| `pilot/p1a/tools/protocol-sim.mjs` | 复用的候选状态机与幂等协议模拟器（`createSim`），r2-sim 在其上实现决策与提交 |

常用命令：

```bash
# 全部保护测试（20 条）
node --test pilot/p1b/tests/*.test.mjs

# 只跑决策与断言机判
node --test pilot/p1b/tests/r2-decisions.test.mjs
```

## 测试清单（T-A1..T-A19）

| 文件 | 覆盖 |
|---|---|
| `tests/r2-decisions.test.mjs` | T-A1 恒 T2 无隐式提权 / T-A2 T2 可进 pack 但权限面拒绝 / T-A3 证据不可定位→failed / T-A4 跨 scope 泄漏 / T-A5 注入 / **T-A5b 脏上下文+干净 quote 仍判注入** / T-A6 未决冲突 hold / T-A19 断言机判四类反例 |
| `tests/r2-corrections.test.mjs` | T-A7 直接更正与 asOf 回溯 / T-A8 「先别改」→ retraction / T-A9 引用与助手自称不覆盖 / T-A10 撤销 epoch 不重新采集 / T-A17 决策后追加前撤销→cancelled |
| `tests/r2-recovery.test.mjs` | T-A11 同 runKey 重放 noop / T-A12 CAS 有限刷新后 hold / T-A13 追加失败重试 → recovery-required **且禁止自动重试** / T-A14 成本配额与目的地白名单 / T-A15 结构化字符串注入不改变行为 / T-A16 三事件缺一不出结论 / T-A18 并发 accept 走 CAS 冲突→刷新消解 |

## 变异自检（09 §10.2）

测试必须可被破损实现打红。已验证四条（均在 /tmp 副本上跑，仓库文件零修改）：

- 删掉证据可定位检查 → 只有 T-A3 变红；
- 冲突分支改为直接放行 → 只有 T-A6 变红；
- hold 写成 reject → 只有 T-A6 变红；
- 注入检测回退成只查 quote → 只有 T-A5b 变红。

改动模拟器后请重跑这四条，确认对应测试仍然失败，再还原。

## 已知的声明式占位（真实现阶段必须换成机判）

以下三项在桩里由调用方传布尔，模拟器自己不判定，属**声明式占位**，不得当作已验证机制：

1. `decide(id, { identityUnknown })` —— 说话人身份未定应由抽取/核对阶段解析，不能靠调用方声明；
2. `decide(id, { resolveObjection })` —— 异议能否被正文消解（09 §5 R4 异议生成器）尚无实现；
3. `decide(id, { redactionOk })` —— 脱敏结果应由脱敏器回报，不是外部开关。

对应审核编号见 [B6 审核报告](../../docs/reviews/v2.0-p1b-tests-2026-11-18/REVIEW.md)（R4/R6/R7/R8 属真实现阶段关闭项）。
