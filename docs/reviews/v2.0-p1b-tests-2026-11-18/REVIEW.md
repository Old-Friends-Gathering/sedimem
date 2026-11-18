# B6 保护测试批次 对抗审核报告（2026-11-19）

> doc-kind: history
> doc-version: 1.4

审核对象：`pilot/p1b/tools/r2-sim.mjs` 与 `pilot/p1b/tests/r2-*.test.mjs`（PR #272，HEAD=ffb372c7）。
审核者：独立 GLM-5.3 实例（`r2-b6-audit`），只读 + 自建 /tmp 副本做变异，仓库文件零修改。
依据：[09-extraction-pipeline](../../design/v2.0/09-extraction-pipeline.md) §6/§8/§9/§10。

## 1. 结论

**通过（作为 TDD 中间态，无 blocker）**：无偷看评测资产、矩阵顺序与规格一致、hold 语义未被降级成 reject、幂等与撤销链路扎实；变异自检三条可复现。

同时给出 5 major + 4 minor，其中「测试弱化规格」类问题已在**同一轮**关闭；其余属真实现阶段关闭项，已在 README 与本报告登记，禁止当作已验证机制。

## 2. 发现与处置

| 编号 | 严重度 | 问题（文件:行） | 处置 |
|---|---|---|---|
| R1 | major | T-A18 走样：并发第二条被 `state==='accepted'` 短路成幂等收据，`candidateVersion` 恒 1，CAS 冲突路径不可达（`r2-sim.mjs` commit） | **已关闭**：引入 `candidateVersions`，提交成功 +1；并发第二条必撞 CAS 并走「刷新→记录已存在→冲突消解」。测试断言 `refreshed===true`、`refreshCount()===1`、`casRefreshes()[0].resolved==='record-exists'` |
| R2 | major | 注入闸门只扫 `assertion.quote`，脏事件 + 干净 quote 可绕过（`r2-sim.mjs:148`） | **已关闭**：注入面改为「claim 正文 + quote + 所引事件全文」；新增 T-A5b（脏上下文 + 干净 quote → `injection-suspected`），变异 4 可打红 |
| R3 | major | CAS「刷新重评」是纯计数 busy-loop，无刷新消解成功路径用例 | **已关闭**：刷新会读回最新版本并记录消解结果（`casRefreshes()`），T-A18 覆盖成功路径；T-A12 仍覆盖「刷新耗尽→hold」 |
| R4 | major | `trustWrites()`/`queueAssets()`/`recapture` 恒为常量，落在其上的断言验证的是常量 | **延期（真实现必须关闭）**：真实现这些接口由真实调用记录支撑，并在 §11 放行清单点名；T-A1 另一半 `truthRecords().every(trust==='T2')` 走协议层真实机制，可证伪 |
| R5 | major | HEAD 提交版 `runStatus` 只校验 usage/decision，缺 extraction 仍判 success（违 §9「三事件缺一」） | **已关闭**：`runStatus` 校验 extraction/usage/decision 三类，输出 `missing` 与 `observabilityStatus`（`incomplete → missing`） |
| R6 | minor | §3 五条机判只落地两条：hash 无快照可比、`quote ≤200` 前缀规则未强制、半 surrogate 未防；§4 stale 分支零覆盖 | **延期**：真实现补快照比对与 stale 用例 |
| R7 | minor | `identityUnknown`/`resolveObjection`/`redactionOk` 由调用方传布尔，属声明式占位 | **已登记**：README「已知的声明式占位」明列三项，禁止当作已验证机制 |
| R8 | minor | ① T-A15 reason 断言接受两种结局，近乎空断言 ② T-A10 reason 二选一 ③ `complete` 只认工具证据（规格允许用户直接确认）④ 配额用 `>`，边界与来源级停机未建模 ⑤ §6 未命中 fail-closed 无测试 | **部分关闭**：T-A10 收窄为 `source-revoked` 单值（撤销分支独立可达）；其余四项（③④⑤）列入真实现关闭清单 |
| R9 | minor | T-A13 未断言「recovery-required 后禁止自动重试」 | **已关闭**：`commit` 优先检查未解决 recovery → 抛 `E_RECOVERY_BLOCKED`；测试断言 throws |

## 3. 变异复现（本报告复核后版本）

| 变异 | 期望打红 | 实测 |
|---|---|---|
| 删除证据可定位检查 | T-A3 | ✅ 仅 T-A3 红 |
| 冲突分支直接放行 | T-A6 | ✅ 仅 T-A6 红 |
| hold 写成 reject | T-A6 | ✅ 仅 T-A6 红 |
| 注入回退成只查 quote | T-A5b | ✅ 仅 T-A5b 红 |

## 4. 真实现阶段关闭清单（P1b 放行前必须逐条关闭）

1. R4：`trustWrites`/`queueAssets`/`recaptureCalls` 由真实调用记录支撑；
2. R6：§3 五条机判全量落地（快照 hash 比对、`quote` 前缀 ≤200 规则、半 surrogate 防护）+ §4 stale 用例；
3. R7：`identityUnknown`/`resolveObjection`/`redactionOk` 换成机判；补 09 §5 异议生成器；
4. R8③：`complete` 接受「工具输出或用户直接确认」两路且各有用例；
5. R8④：配额边界（`spent == limit`）与来源级停机建模；
6. R8⑤：§6 矩阵未命中必须 fail-closed 抛错并有用例。

## 5. 保留门禁

- 模拟器绿灯仍不等于质量通过（09 §10.1）；P1b 放行仍需真实现全绿 + 参考集钉死 + 七类严重错误零容忍。
- 参考集 `goldset-v1` 为 `model-dual-blinded`（`confirmedByBoth` 仅 5.6%），不得称客观真值。
