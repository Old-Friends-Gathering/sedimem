# v0.5.0 验收清单（Lead 判定）

判定时间：2026-11-13。施工图 `docs/plans/v0.5-pages-verify.md`；
契约不变（本版无数据面/API 变更，`docs/02` 未改动）。

## 一、功能门禁（每条都能机械复验）

| 门禁 | 内容 | 状态 | 证据 |
|---|---|---|---|
| G1 | 全部单测全绿 | ✅ | `node --test 'tests/**/*.test.js'` → **399/399 pass**（v0.4 为 391，本版 +8） |
| G2 | 评测 I1–I36 全 PASS | ✅ | `node eval/run.js` → I1–I36 全 PASS；快照 `eval/results/v0.5.0-*.json` + `LATEST.json` |
| G3 | 质量门禁 10/10 | ✅ | `node tools/quality-check.mjs` → 10/10（含 Q10 发布面同步，当前 v0.5.0） |
| G4 | 安全门禁 9/9 | ✅ | `node tools/security-check.mjs` → 9/9（新脚本无外链、无个人路径） |
| G5 | 覆盖率门禁 | ✅ | functions 92.31%（下限 90%），`node tools/coverage-gate.mjs` 通过 |
| G6 | 线上一致时退出 0 | ✅ | `node tools/pages-verify.mjs --expect v0.4.4` → PASS（28423 字节） |
| G7 | 线上落后时退出 1 | ✅ | `--expect v0.5.0` → exit 1，reason=`version-mismatch` |
| G8 | 用法错误退出 2 | ✅ | `--expect nonsense` → exit 2 |
| G9 | 四条失败原因与重试语义 | ✅ | `versions/v0.5/tests/unit/pages-verify.test.js` 8 例 |
| G10 | CI 失败会开 issue（不刷屏） | ✅ | `.github/workflows/pages-verify.yml`：同标题已 open 只评论 |
| G11 | 每日巡检兜底 | ✅ | `schedule: '17 3 * * *'` |

## 二、发布面（本版的核心）

| 项 | 状态 | 证据 |
|---|---|---|
| P1 | 版本目录按规则新建 | ✅ | `versions/v0.5`；`versions/v0.4` 冻结在 0.4.4 并含 `FROZEN.md` |
| P2 | `versions/CURRENT` = v0.5 | ✅ | 门禁 Q2/Q3/Q5/Q9 与 CI 都读它 |
| P3 | 三处发布面同步（Q10） | ✅ | README 版本表含 `v0.5.0`、`docs/index.html` 含 `0.5.0`、`ci.yml` 的 `eval (I1–I36)` 与用例数一致 |
| P4 | CHANGELOG / DELTA / 施工图齐备 | ✅ | `versions/v0.5/{CHANGELOG.md,docs/DELTA.md}`、`docs/plans/v0.5-pages-verify.md` |

## 三、判定

**通过验收（0.5.0）**。

已知限制（与 v0.4 相同，外加本版新引入的一条）：

1. 语义道默认关闭，需要自备 OpenAI 兼容的 embedding 端点；
2. 每步注入默认关闭，且必须显式给 scope（fail closed）；
3. **新增**：pages-verify 只验「首页版本号 + 三张截图 200」，不验内容正确性，也不做视觉回归。
