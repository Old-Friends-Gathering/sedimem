# 命题粒度规范（granularity）对抗审核记录

> doc-kind: history
> doc-version: 1.4

- 审核对象：`docs/design/v2.0/06-annotation-spec.md` §1.1、`pilot/p1a/tools/granularity-check.mjs`、`pilot/p1a/granularity/calibration.jsonl`、`pilot/p1a/tests/granularity-check.test.mjs`、`corpus-validate.mjs` 接入点。
- 分支：`p1b/granularity`（PR #278）。
- 审核者：GLM-5.3 独立实例（r1-granularity-audit 首轮、r2-granularity-delta delta 复核），只读实测 + /tmp 探针，互不可见。

## 一、R1 首轮：不通过（1 blocker + 5 major + 5 minor）

| 编号 | 严重度 | 发现 | 修订 |
| --- | --- | --- | --- |
| F1 | major | 校准集由作者按自己实现的规则填写，判定与样本同源（自证循环） | 新增 6 条 `source: independent-audit` 样本（按规范文字推导）；全部样本带 `textHash` 指纹；`expectedClaims` 由 `countSplitParts` 实算；≥1 例三路拆分 |
| F2 | blocker | S4/S5/S6 形态标记短路判定，`"如果端口是 8080，那么超时是 30 秒"` 被判原子 | 形态标记只标注不豁免；`isAtomic` 仅按 S1/S1b/S2/S3/S6b 判拆。实测该句 hits `[S4,S2]`、非原子 |
| F3 | major | S1 漏判共享谓语并列（`"8080 和 8081 都已开放"`） | 新增 S1b（并列主语共享谓语）与 S6b（多比较结构）；同一性句（`"A 和 B 是同一个服务"`）经 IDENTITY_RE 豁免不拆 |
| F4 | minor | S3 只认数值，`"支持 http、https"` 漏判 | VALUE_TOKEN_LIST 扩到协议/状态词 |
| F5 | major | I3 把「显式空串」与「字段缺失」混同 | 缺失 = `null`、空值 = `''`；新增 I3′：`{value:''}` vs `{value:'30s'}` → different，缺字段 → subsumed |
| F6 | minor | 谓词白名单窄，`"数据库连接失败，重试 3 次"` 漏判 | PREDICATE_MARK_RE 补 `失败｜重试｜保留｜升级｜回滚｜停止｜恢复｜提升｜降低` |
| F7 | major | 双口径：`granularity-check` 未接入门禁，`corpus-validate` 仍是标点启发式先拦 | `corpus-validate.mjs` gold 校验增加 `isAtomic`/`splitHints` 第二判据（唯一实现，禁两套口径） |
| F8 | minor | manifest `frozenAt` 未随版本刷新 | 05 补 frozenAt 惯例；manifest 升 v5 并刷新（见 N1） |
| F9 | major | `expectedClaims` 与 `verdict` 互相派生、条数上限锁死 2、样本替换不可证伪 | `countSplitParts` 实算 + `sampleFingerprint` 指纹 + 三路样本；新增「替换 text 不更新指纹必须报错」「篡改期望值必须报错」两个可证伪用例 |
| F10 | minor | 助手自称完成时 `complete` 与 `not-done` 组合歧义 | 06 §1.1.1 给出三行标注矩阵（complete+active / complete+not-done / state+not-done） |
| F11 | minor | 工具输出「不逐行记、结论可记」缺判据 | 引入「可复用性」聚合判据，明令不得用白名单兜底丢弃非白名单结论 |

修订后实跑：`granularity-check.mjs calibration.jsonl` 通过；`node --test granularity-check.test.mjs` 19/19；`corpus-validate` 218 场景 / 353 gold / 0 错误；对抗 10 类 test 每类 13–14（≥10 成立）。

## 二、R2 delta 复核：通过（有保留）

R1 十一条中 10 条确认落地（F8 弱落地），无 blocker；新发现 4 条：

| 编号 | 严重度 | 发现 | 处置 |
| --- | --- | --- | --- |
| N1 | major | 规则行为已变（新增 S1b/S6b、S4/S5 语义变）但 `RULESET_VERSION` 仍 `granularity@v1`，manifest 仍 v4/旧 frozenAt，`revisionNote` 写「12 场景校准集」（实际 18） | 升 `granularity@v2`（全部引用点同步）；manifest 升 **v5**、`frozenAt=2026-11-19T12:30:00Z`、revisionNote 如实记录 v2 语义变化 + 校准集 18→20 + gold 347→353 |
| N2 | minor | `countSplitParts` 把「单属性多值枚举」误判需拆：`端口 8080、8081、8082` → 3、`维护窗口是 2026-11-18、2026-11-19` → 2 | 新增 **U4**（同一属性的取值列表整体一条）：S3 只在「≥2 个各自带属性名」或「无属性名的能力枚举」时命中；补 cal-19/cal-20 两条 U4 校准样本与三条 `countSplitParts` 断言 |
| N3 | minor | 06 §1.1.6 标题写「16 场景」、docs/12 写「12 条校准样本」，实际 18（现 20） | 全部改为 20 |
| N4 | minor | `docs/design/v2.0/README.md`、`07-benefits-observability.md` 仍以现在时写 347 gold | 改为 353 gold（G1 后），并保留 BASELINE 的历史口径说明 |

## 三、修订后验证（R2 之后）

- `node pilot/p1a/tools/granularity-check.mjs pilot/p1a/granularity/calibration.jsonl` → ✅ 20 条全部通过（规则集 `granularity@v2`）
- `node --test pilot/p1a/tests/granularity-check.test.mjs` → 19/19
- `node pilot/p1a/tools/corpus-validate.mjs pilot/p1a/corpus pilot/p1a/config/eval-manifest.json` → 218 场景 / 353 gold / errors [] / quotaFails []
- `node pilot/p1a/tools/exit-check.mjs .` → 出口条件齐备（pending []）
- U4 探针：`端口 8080、8081、8082` → 无命中、parts=1；`维护窗口是 2026-11-18、2026-11-19` → 无命中、parts=1；`端口 8080、超时 30s` → S3、parts=2；`支持 http、https` → S3、parts=2
- 门禁：quality 15/15、security 9/9、docs-drift 无 finding

## 四、保留门禁

- 粒度规则再变更必须升版本（`granularity@v3`）并重跑校准集 + 全部参考集；旧成绩只读保留。
- `granularity@v2` 的 U4 判据是启发式（属性名 vs 裸值），P1b 实实现若发现新的并列形态，须先补校准样本再改规则，不得就地放宽。
- 两遍盲评 claim 重合率 5.6% 的根因是粒度未定义；本规范升级后需重跑参考集对比，结论写入 B7 报告。
