# 11 · 文档治理契约

> doc-kind: contract
> doc-version: 0.6
> verified-at: 2026-11-14
> verified-against: versions/CURRENT（v0.6 / 0.6.2）

## 一、为什么有这篇：现状证据

文档与代码已经真实漂移过，以下是 2026-11-14 实测到的证据（修完后本文保留作为治理动机的存档）：

1. README.md 写「tests-288」徽章与「288 个测试」，实际全量是 **471 tests**。
2. README.md 写「I1–I24」，实际 `versions/v0.6/eval/run.js` 的 `CASE_FILES` 已扩到 **I1–I40**。
3. docs/06-usage.md 同时引用 `versions/v0.1`、`versions/v0.3`、`versions/v0.5` 的路径，而当前版本是 v0.6——读者按文档操作会落到错误目录。
4. docs/07-quality-and-security.md 头部命令注释写「质量（8 项）/ 安全（8 项）」，正文写「质量 11 项 / 安全 9 项 / 覆盖率 3 项」，头部与正文自相矛盾。

漂移的共同根因：**没有任何机制把文档绑定到代码事实**。代码改了，文档不会自己跟上；等读者发现时，文档已经说了谎。本契约 + `tools/docs-drift-check.mjs` 就是这个机制。

## 二、文档三分类

| doc-kind | 含义 | 变更规则 |
|---|---|---|
| **contract**（契约） | 描述"系统必须是什么样"的文档：架构、数据模型、门禁规范。**改它 = 改行为**，与代码同级对待。 | 跟随 `versions/CURRENT`，头部 `doc-version` 必须等于当前小版本 |
| **manual**（手册） | 描述"怎么用"的文档：usage、web-ui、curate 流程。跟版本走，命令、路径必须对得上当前版本目录。 | 发版时必须核对受影响的命令与路径 |
| **history**（历史） | 冻结的快照：docs/research/**、docs/plans/**、docs/adr-*、versions/vX.Y 里的旧文档。 | **冻结不追**：不因版本演进回改，即使内容已"过时"也保持原样，它是当时的记录 |

`docs/00–11` 中每个文件在头部元信息里声明自己的 kind；未声明按 manual 对待（会被 R1 拦下）。

## 三、头部元信息四行

紧跟一级标题之后、正文之前，格式：

```markdown
> doc-kind: contract | manual | history
> doc-version: 0.6
> verified-at: 2026-11-14
> verified-against: versions/CURRENT（v0.6 / 0.6.2）
```

逐行解释：

| 行 | 谁维护 | 什么时候改 | 不写会怎样 |
|---|---|---|---|
| `doc-kind` | 文档作者 | 创建时定，分类变更时改 | R1 报错；读者不知道这份文档是契约还是过期快照 |
| `doc-version` | 改契约的人 | 每次行为级修改后 +1 小版本，且必须等于 CURRENT 的小版本 | R1/R2 报错；契约与代码版本脱钩，出问题时无法定位是哪版契约 |
| `verified-at` | 最近核对者 | 每次人工核对（发版核对、SOP 第 3 步）后改 | 读者无法判断"这话多久没验证过了"，漂移窗口不可见 |
| `verified-against` | 最近核对者 | 与 verified-at 同时改，指明核对基准 | R2 无法判定；不知道这份契约对的是哪个版本目录 |

history 类文档四行可选——冻结文档不做现状核对，写上也只代表写它时的状态。

## 四、发版四件套

发一个新小版本（如 v0.7）时，除代码外**必须**同步更新四处：

1. **README 版本表 / 徽章**：tests 徽章数字、eval 徽章的 I 区间、测试数注释。
2. **docs/index.html**：时间线新增版本条目，页面内的版本号全部更新。
3. **docs/06-usage.md**：受影响的命令与路径（`versions/vX.Y` 引用、cron/launchd 示例、安装命令）切到新版本目录。
4. **docs/07-quality-and-security.md 基线数字**：测试数、I 用例区间、覆盖率、门禁项数（Q/S/C 三组）。

漏任何一处，R2–R5 至少命中一条，发版不算完成。

## 五、漂移门禁 Q14 六条检查

工具：`node tools/docs-drift-check.mjs`（CI 与本地同一份）。规则编号 R1–R6：

### R1 头部元信息缺失
- **拦什么**：contract、manual 文档缺 `doc-kind` 或 `doc-version` 行；history 豁免。
- **判定规则**：**递归**遍历 `docs/` 下所有 `*.md`（含子目录），正文存在 `> doc-kind:` 且 `> doc-version:` 才放行。豁免目录只有三个：`docs/research/`、`docs/plans/`、`docs/marketing/`（整体不扫）；`adr-*.md` 只豁免 R2–R5，R1 仍查。其他任何子目录一律扫描——放进子目录不能绕过门禁。
- **失败示例**：docs/05-process.md 头部只有标题直接开正文 → `R1 缺头部元信息（doc-kind/doc-version）`；docs/diagrams/rogue.md 无头部 → 同样报 R1。

### R2 contract 的 doc-version 必须等于 CURRENT 小版本
- **拦什么**：契约文档声明的行为版本与代码版本不一致。
- **判定规则**：取 `versions/CURRENT`（如 `v0.6`），contract 文档的 `doc-version:` 必须等于 `0.6`。
- **失败示例**：doc-version 写 `0.5` 而 CURRENT 是 v0.6 → `R2 doc-version 0.5 ≠ CURRENT 0.6`。

### R3 正文不得出现与 CURRENT 不同的 versions/vX.Y 路径
- **拦什么**：手册/契约正文引用旧版本目录，读者照做落错目录。
- **判定规则**：正则匹配 `versions/v\d+\.\d+`，凡不等于 CURRENT 路径即报；`docs/research/**`、`docs/plans/**`、`docs/adr-*` 与 history 类文档豁免。
- **失败示例**：docs/06 写 `cd sedimem/versions/v0.3`（CURRENT 是 v0.6）→ `R3 引用非当前版本路径 versions/v0.3`。

### R4 测试数与 I 用例数一致
- **拦什么**：README / docs/07 里的规模数字落后于代码，或同文件内数字自相矛盾。
- **判定规则**：抓出文件里**所有**测试数声明（认「N tests」「tests-N badge」「N 个测试」「N 用例」四种写法）与**所有** `I1–IN` 区间声明（分隔符认 `–`、`-`、`～`、`~`、`至`）；文件内任何两个测试数不相等、或任何一条 I 区间的 N ≠ `versions/<CURRENT>/eval/run.js` 的 `CASE_FILES` 条数（用正则从文本解析条数，不 import），都报 R4。
- **失败示例**：README 同页出现 `I1–I40` 与 `I1–I36` → 一条 R4（I1–I36 ≠ CASE_FILES 40 条）；徽章写 tests-288 而正文写 471 tests → 一条 R4。

### R5 门禁项数与脚本一致
- **拦什么**：docs/07 声明的质量门禁项数落后于 quality-check.mjs 实际项数。
- **判定规则**：统计 `tools/quality-check.mjs` 中**不同 Q 编号的个数**（当前 12：Q1–Q11 + Q14；Q12/Q13 为预留跳号，跳号不代表少一项）；docs/07 中"质量门禁…N 项"声明的 N 必须等于它。
- **失败示例**：docs/07 写「质量 11 项」而实际不同 Q 编号 12 个 → `R5 门禁项数 11 ≠ 12`。

### R6 代码注释不得引用已删除的文档
- **拦什么**：`versions/<CURRENT>/src/**/*.js` 与 `ui/**/*.js` 的注释里出现 `docs/09-sqlite-index` 或 `docs/10-curate-auto`（这两篇文档已删除，内容并入 docs/02 附录 A / 附录 B）。
- **判定规则**：逐行扫注释（`//` 与 `/* */` 行），出现上述任一引用即报 R6，message 提示改指 `docs/02 附录 A`（SQLite 索引）或 `docs/02 附录 B`（curate 自动裁决）。
- **失败示例**：`src/index/sqlite-index.js:1` 写「契约：docs/09-sqlite-index.md」→ `R6 代码注释引用已删除文档 docs/09-sqlite-index，请改指 docs/02 附录 A`。

## 六、豁免机制

确需暂时容忍某条 finding 时，写入 `tools/docs-drift-allowlist.json`：

```json
{
  "entries": [
    { "rule": "R3", "file": "docs/06-usage.md",
      "pattern": "versions/v0.3",
      "reason": "历史 cron 示例保留至迁移完成",
      "until": "2026-12-01" }
  ]
}
```

形状与纪律：

- `entries`: `[{ rule, file, pattern, reason, until }]`；`reason` 与 `until` **都必填**——没有理由的豁免就是永久债。工具会校验：`reason` 非空、`until` 可解析为日期，否则报一条 `ALLOWLIST` finding 且**该条豁免不生效**（不允许静默豁免）。
- `until` 过期后该条目**即失效**，对应 finding 恢复报出，并额外报一条 `ALLOWLIST_EXPIRED` 提醒清理。
- `file`/`pattern` 用相对仓库根的路径与字符串匹配；`pattern` 为空匹配该文件该规则全部 finding（慎用）。

## 七、修漂移 SOP

发现漂移后按此顺序改，一次 commit 内完成：

1. **先改 history 记事实**：在 docs/plans/ 或对应 history 文档追加一条"何时发现什么漂移、实际值是多少"，让漂移本身成为记录。
2. **再改 contract**：docs/02、docs/07 等契约文档同步新事实，`doc-version` 与 `verified-at` 一起更新。
3. **最后改 manual**：README、docs/06 等手册按新契约修正命令、路径、数字。

顺序的含义：先固定事实（可追溯），再改规则（源头唯一），最后才是表述（用户看到）。反过来做，等于在没定论时先改用户手册。
