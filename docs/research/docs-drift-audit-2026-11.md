# 文档漂移审计（2026-11-14）

基线：`versions/CURRENT` = v0.6，`versions/v0.6/CHANGELOG.md` 最新段 0.6.2（2026-11-13）。
核实命令均在本仓实际执行；标注「未验证」处为未能核实。

## 一、漂移总表

| 文档 | 事实依据版本 | 漂移点（行号 → 现状） | 严重度 |
|---|---|---|---|
| README.md | v0.5 前后混杂 | L107「288 个测试」→ 实测 471（`node --test 'tests/**/*.test.js'` 于 versions/v0.6）；L108「I1–I24」→ ci.yml:56 与 eval/cases 均为 I1–I40（34 个 case 文件）；L130–132/153 配置模板链接指向 `versions/v0.3/configs/`，而 CURRENT=v0.6 | 高 |
| docs/00-principles-and-requirements.md | v0.1（历史） | 六条硬需求 C1–C6 为 v0.1 验收口径，正文无版本标注；读者易当成现状 | 低 |
| docs/01-architecture.md | ≈v0.1–v0.2 | 分层图仍为「CLI/MCP → service → hygiene/storage/index-render」；未含 v0.3 `src/views/`、v0.4 `src/capture/`、v0.6 `src/session/`（目录实际存在，`ls versions/v0.6/src` 核实） | 中 |
| docs/02-data-model-and-contract.md | 持续维护（v0.6） | 自称「v0.1 的编码契约」（L3），但已累积 v0.2.1 裁决 45、v0.6 写侧契约等段落；头部定位语与内容规模不符 | 低 |
| docs/03-iterability-and-versioning.md | ≈v0.3 | §2 端口表「未来可能实现 hybrid-index.js」→ v0.4 已落地（`src/index/hybrid-index.js`、`vector-index.js`、`embedder.js` 存在）；§5「v0.1→v0.2 候选路线」仍在正文 | 中 |
| docs/04-eval-plan.md | v0.1 | §2「六项注入式回归（v0.1 必须全绿）」→ 现 40 项（tests/injection 40 个文件）；L35 阈值标注 v0.1；L45 产物名 `eval/results/v0.1-<ts>.json` | 低（历史型） |
| docs/05-process.md | v0.1 | §5 时间线为 v0.1；L78 main 分支保护上下文写 `eval (I1–I12)`、且无 `codeql`/`windows-smoke`，与 docs/07 §八 2026-11-02 快照及 ci.yml 现状（I1–I40）不一致 | 中 |
| docs/06-usage.md | v0.3 为主，尾部补丁到 v0.6 | L59/66/139/166/175/200 操作路径全部 `versions/v0.3`（cron、nightly、policy.json）；L268/277 launchd 模板指 v0.3；仅 L407（v0.5 policy）、L487/517（v0.6）是新的——同一篇文档三种版本路径并存 | 高 |
| docs/07-quality-and-security.md | 正文 v0.6，头部 v0.3 时代 | L9–11「质量 8 项 / 安全 8 项 / 覆盖率 3 项」→ 实跑 `tools/quality-check.mjs` 11/11、`security-check.mjs` 9/9（正文 L59/L75 自己也写 11/9，自相矛盾）；L12「cd versions/v0.3 … 行为（I1–I12）」→ 应为 v0.6 / I1–I40；L152 基线「447 tests」→ 现实测 471（基线标注 2026-11-13/v0.6.0，过期 3 天）；L179 分支保护快照 `eval (I1–I23)`（有日期标注，属考古） | 高（头部命令行会直接误导） |
| docs/08-web-ui.md | v0.2 契约 + §14–15 v0.4 增补 | 头部自称「v0.2 设计契约」；L216 实现位置写 `versions/v0.3/src/web + versions/v0.3/ui` → 现行实现在 versions/v0.6；§14 搜索页、§15 浅色（v0.4.2）为后补，版本地层靠节标题辨认 | 中 |
| docs/09-sqlite-index.md | v0.2.1（历史） | 全文为 issue #20 交付记录，实现已稳定在 src/index/sqlite-index.js；无版本标注头部 | 低（历史型） |
| docs/10-curate-auto.md | v0.2.1（历史） | 同上，issue #21 交付记录 | 低（历史型） |
| docs/plans/ | v0.2–v0.7 | 计划文档含已完成的 v0.2–v0.6 与未做的 v0.7；v0.7-ui-and-ecosystem.md 是否仍有效未验证 | 低 |
| versions/CURRENT | — | 内容 `v0.6` 是目录指针，符合 03 §3 规则（X.Y 换目录）；非漂移，列此备查 | — |

## 二、归类：历史考古型 vs 现状说明书型

**历史考古型**（记录当时决策，只需头部标版本，不必追代码）：
docs/00（原则）、docs/04 §2（v0.1 六项回归）、docs/05 §5 时间线、docs/09、docs/10、docs/plans/ 全部、docs/07 §八 分支保护快照（已带日期）。

**现状说明书型**（必须与代码同步，当前普遍失守）：
README（对外第一入口：测试数、I 区间、配置模板链接三处漂）、docs/06（运维手册：路径指向 v0.3）、docs/07 头部命令块（门禁权威文件自相矛盾）、docs/01（架构图缺 3 个已落地模块）、docs/03 §2（端口表「未来」已成现实）、docs/08 头部（自称 v0.2 契约却含 v0.4 增补）。

结构性根因：① docs/ 唯一权威（02/07/08）靠正文追加「裁决 N」「vX.Y 增补」续命，头部定位语从不改；② 运维路径硬编码版本目录（`versions/v0.3`），CURRENT 指针变了没人扫；③ 数字（测试数、I 区间）散落多文件手工同步，Q10 只管「版本号三处一致」，不管其他数字。

## 三、1.0.0 文档治理方案

### 3.1 文档分类与 owner

| 类 | 文档 | owner | 纪律 |
|---|---|---|---|
| 契约（现状） | 01/02/07/08/README/docs/index.html | Lead（写权限唯一） | 改代码的 MR 必须同 PR 更新；不一致以文档为准并开门禁 issue |
| 手册（现状） | 06 | impl-edge | 路径一律写 `versions/$(cat versions/CURRENT)`，禁止硬编码 vX.Y |
| 原则/历史 | 00/03 §1–2/04/05/09/10/plans/ | Lead（冻结） | 只追加不改写；头部加版本标注后封存 |

### 3.2 统一头部元信息（现状型文档必带）

```markdown
<!-- doc-kind: contract|manual|history
     doc-version: 1.0.0
     verified-at: 2026-11-14
     verified-against: versions/CURRENT
-->
```

历史型文档用 `doc-kind: history` + `as-of: v0.2.1`，明确豁免同步义务。

### 3.3 发版四件套（每个 X.Y.Z 合并前，Lead 逐项打勾）

1. `versions/<v>/CHANGELOG.md` 最新段 = package.json version（现有 Q7 已管）。
2. README 版本表 + 快速开始的**测试数与 I 区间**刷新为本版实测值。
3. 06/07/08 中所有 `versions/vX.Y` 路径与门禁数字刷新到新目录。
4. docs/index.html 时间线加本版（现有流程 §05 已定义，Q10 校验）。

### 3.4 Q14 机械校验门禁（新增 `tools/docs-drift-check.mjs`，进 ci.yml）

检查项（全部可机械判定）：
1. **元信息存在性**：现状型文档（清单硬编码在脚本里）缺 `doc-version/verified-at` 头即 fail。
2. **doc-version == 当前版本**：从 `versions/CURRENT` + 最新 CHANGELOG 推导。
3. **硬编码版本路径**：现状型文档（06/07/08/README 正文）出现 `versions/v0\.\d` 且 ≠ CURRENT → fail（历史型与 plans/ 豁免）。
4. **数字同步**：README 的「N 个测试」与「I1–M」用正则抓取，M 与 `eval/cases` 文件数比对；N 与上一次 CI 的 `node --test` 计数比对（或降级为「N 必须等于 ci.yml 的 eval 区间」这类无运行依赖规则）。
5. **自引用一致**：docs/07 头部命令块的门禁项数（`\d+ 项`）与该节标题数量比对。

实现：零依赖 Node 脚本（同 Q1–Q11 风格），`record('Q14', ...)` 挂进 quality-check.mjs 或独立 job。
误报豁免：脚本头部维护 `ALLOWLIST`（如引用冻结版本的对照说明），格式 `{file, pattern, reason, until}`；豁免必须在 MR 里给出理由，Lead 审批；`until` 过期自动重新报红。

## 四、1.0.0 文档重写/合并/删除清单

| 动作 | 对象 | 理由 |
|---|---|---|
| 重写 | README 快速开始 + 三端接入链接 | 288→471、I24→I40、v0.3 链接→v0.6（§一表） |
| 重写 | docs/06 | 全篇路径改 `versions/$(cat versions/CURRENT)` 模式，按 3.2 加头部 |
| 修头部 | docs/07 L9–12 命令块 | 8/8/3→11/9/3、v0.3→CURRENT、I1–I12→I1–I40 |
| 修头部 | docs/02 L3 | 「v0.1 的编码契约」→「当前版本的编码契约（含历次裁决增补）」 |
| 更新 | docs/01 架构图 | 补 views/capture/session 三层与 web/api 现状 |
| 更新 | docs/03 §2 | hybrid/vector/embedder 从「未来」移到「已落地（v0.4）」 |
| 合并 | docs/09 → docs/02 附录；docs/10 → docs/02 附录 | 二者是 02 的已裁决增项（02 §517 已交叉引用），独立成篇只制造「两处事实」；02 收编后 09/10 转 history 存档 |
| 合并 | docs/08 的 v0.4 增补节（§14–15）并入正文 | 消除「v0.2 契约里夹 v0.4」地层混杂；头部改「Web UI 契约（v0.2 起，含 v0.4/0.4.2 增补）」 |
| 封存 | docs/00/04/05/09/10/plans(v0.2–v0.6) | 加 `doc-kind: history; as-of: vX.Y`，不再要求同步 |
| 保留 | docs/plans/v0.7-ui-and-ecosystem.md | 下版本计划（是否仍有效未验证，1.0.0 立项时确认） |

— 完。全部结论出处：本仓文件行号（见 §一）与本机实测命令输出（node --test 471 pass / quality 11/11 / security 9/9，2026-11-14 执行）。
