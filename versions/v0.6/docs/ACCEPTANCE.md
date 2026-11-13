# v0.6.0 验收清单（Lead 判定）

判定时间：2026-11-13。施工图 `docs/plans/v0.6-memory-quality-and-session.md`；
契约裁决 71–76 见 `docs/02` §3.17（本版有数据面变更：`policy.write` / `policy.session` 两个新段）。

## 一、功能门禁（每条都能机械复验）

| 门禁 | 内容 | 状态 | 证据 |
|---|---|---|---|
| G1 | 全部单测全绿 | ✅ | `cd versions/v0.6 && node --test 'tests/**/*.test.js'` → **447 pass / 0 fail**（v0.5 为 399，本版 +48） |
| G2 | 评测 I1–I40 全 PASS | ✅ | `node eval/run.js` → I1–I40 全 PASS；快照 `eval/results/v0.6.0-*.json` + `LATEST.json` |
| G3 | 质量门禁 11/11 | ✅ | `node tools/quality-check.mjs` → 11/11（含 **Q11** 写侧粒度与会话库契约，I37–I39 在册） |
| G4 | 安全门禁 9/9 | ✅ | `node tools/security-check.mjs` → 9/9 |
| G5 | 覆盖率门禁 | ✅ | functions **92.31%**（下限 90%），`node tools/coverage-gate.mjs` 通过 |
| G6 | 写侧硬线报错 | ✅ | I37 PASS：超 4000 字 → `E_INVALID_RECORD`（附 `truncateTo`），无静默截断 |
| G7 | 软线警告 + 拆分建议 | ✅ | I37 PASS：301 字 value → 写入成功 + `E_RECORD_LONG` + `splitSuggestion` + `long-form` 标签 |
| G8 | title 警告/强制双档 | ✅ | I37 PASS：缺 title 默认 `E_TITLE_MISSING` 警告；`write.titleEnforce=true` 硬拒 |
| G9 | 会话生命周期 | ✅ | I38 PASS：start → 写 → checkpoint → close → 主库多条晋升（`from-session:<id>`）+ handoff state，交接文档六节齐全 |
| G10 | close 幂等 | ✅ | 重复 close 返回 `already-closed`，不再晋升、不再落盘（`session-close-promote.test.js`） |
| G11 | 会话库隔离与禁令 | ✅ | I39 PASS：session 记录不进主库 brief/search（反之亦然）；写 `fact` → `E_SCRATCH_KIND_FORBIDDEN` |
| G12 | UI 分库粘性 | ✅ | I40 PASS：切 tab / 刷新均保持 `?scope=`；`resolveScope` 四级回落单测 6 组合 |

## 二、发布面

| 项 | 状态 | 证据 |
|---|---|---|
| P1 | 版本目录按规则新建 | ✅ | `versions/v0.6`；`versions/v0.5` 冻结在 0.5.0 并含 `FROZEN.md` |
| P2 | `versions/CURRENT` = v0.6 | ✅ | 门禁 Q2/Q3/Q5/Q9/Q11 与 CI 都读它 |
| P3 | 三处发布面同步（Q10） | ✅ | README 版本表含 `v0.6.0`、`docs/index.html` 含 `0.6.0`、`ci.yml` 的 `eval (I1–I40)` 与用例数一致（分支保护 required checks 已同步） |
| P4 | CHANGELOG / DELTA / 施工图齐备 | ✅ | `versions/v0.6/{CHANGELOG.md,docs/DELTA.md}`、`docs/plans/v0.6-memory-quality-and-session.md` |

## 三、判定

**通过验收（0.6.0）**。

Known limits：

1. `titleEnforce` 默认 false（避免破坏现有三端写入），要硬约束需显式开启——何时默认开启等
   `E_TITLE_MISSING` 警告发生率的实测数据；
2. checkpoint 由 agent 或人写，**不做自动总结**（`--from-summary` 只抽草稿、缺字段留空）；
3. 语义检索仍需自备 embedding 端点（v0.4 起可选、默认关闭），本版未动。
