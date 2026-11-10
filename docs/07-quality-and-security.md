# 质量与安全指标（门禁规范）

本文件是**门禁的权威说明**：每一项指标怎么算、阈值多少、失败时怎么处理、谁能改阈值。
脚本是实现，本文件是契约——两者不一致时以本文件为准，并提 issue 修脚本。

四个门禁全部**零依赖**、本地与 CI 跑同一份代码，避免"本地绿、CI 红"。

```bash
node tools/quality-check.mjs      # 质量（8 项）
node tools/security-check.mjs     # 安全（8 项）
node tools/coverage-gate.mjs      # 覆盖率（3 项）
cd versions/v0.3 && node eval/run.js   # 行为（I1–I12）
```

---

## 一、行为门禁（ci.yml + eval）

| 项 | 指标 | 阈值 | 失败含义 |
|---|---|---|---|
| `test (22)` / `test (24)` | `node --test 'tests/**/*.test.js'` | **0 失败**（2026-11-10 实测 370 用例） | 行为回归，或测试自身有竞态（历史上 I8 就因此偶发红，已修根因） |
| `eval (I1–I12)` | `eval/run.js` 退出码 | **全 PASS** | 注入式行为契约破了：重复/冲突/过时/删除/投毒/配额/改写/并发/时区/遮蔽/裁决回路/中文改写 |
| `windows-smoke` | `node tools/windows-smoke.mjs`（`windows-latest`） | **全部 PASS** | Windows 真相层文件名 / 分库枚举 / `compact` / `nightly` 之一回归（见 §一.1） |
| 关键指标 | `dupRatio` / `conflictRate` | `dupRatio = 0`；`conflictRate` 只允许由**真冲突用例**产生 | 冗余或冲突治理失效 |
| 性能 | `bench n5000` search p95 | **< 50ms**（实测 1.9–2.4ms） | 索引退化（例如误改成 O(n) 扫描） |

**反作弊**：注入式用例的断言是行为契约，禁止为变绿而放宽。发现放宽按 bug 处理（CONTRIBUTING §四）。

### 一.1 第四道防线：windows-smoke（issue #62 第 1 步）

`ci.yml` 里与 `test` / `eval` / `ci-gate` 并列的**第四道防线**，专治 2026-11 的 Windows 回归：
`scope` 恒含 `:`，在 NTFS 上被当成备用数据流（ADS）分隔符，`items/repo:x.jsonl` 实际写成文件
`repo` 的数据流——`readdir` 看不见（分库列表 0 条）、`compact` 的 `copyFile` 报 `EINVAL`、
备份不保留数据流导致真相层静默丢失（裁决 58）。

`tools/windows-smoke.mjs` 在临时 `MEMO_HOME` 里只钉四件事：

1. **真相层文件名**：`items/<itemsFileName(scope)>` 是普通文件且非空（Windows 上是 `repo+smoke.jsonl`，POSIX 上是 `repo:smoke.jsonl`）；
2. **分库枚举**：`listScopes()` 能从文件名反解出 `repo:smoke`，且 `records === 2`；
3. **compact**：`memo compact --dry-run` 与 `memo compact`（真压，走 `copyFile` 备份 + `rename`）退出码均为 0（曾因备份目标落 ADS 直接崩）；
4. **nightly**：退出码 0，且写出 `brief/<briefFileName>` 与 `metrics/<date>.<scopeKey>.json`。

**它只钉冒烟，不替代全量测试**：全量套件里还有 13 条「POSIX 假设」用例在 Windows 上红
（清单与修复进度见登记该批用例的独立 issue）。在那批用例修完、并接入 Windows 之前，
`windows-latest` 只跑本脚本——全量红等于没人看。

## 二、覆盖率门禁（coverage-gate.mjs）

| 指标 | 当前基线 | 阈值 | 备注 |
|---|---|---|---|
| lines | 93.4% | **≥ 85%** | 未覆盖的主要是 MCP 协议边界与交互式分支 |
| branches | 81.1% | **≥ 70%** | |
| functions | 92.6% | **≥ 90%** | |

统计方式：`npm run test:coverage`（排除 `src/cli/memo.js` 进程外壳，理由见 §七）。

阈值贴着基线设置，意味着**新增未覆盖代码会直接卡住**——这是故意的：先写测试再实现（TDD）。

## 三、质量门禁（quality-check.mjs，9 项）

| ID | 检查 | 判定 | 为什么这条值得占一个门禁 |
|---|---|---|---|
| Q1 | 零运行时依赖 | `dependencies/devDependencies/peerDependencies/optionalDependencies` 全空；`type=module`；有 `engines.node`；`src/` 里无外部 `import` | 便携性是本项目的前提（三端装得上、无需联网装包）。想引库必须先改架构文档 |
| Q2 | 源码规模 | 单文件 **≤ 900 行**；`src` 总量 **≤ 8000 行**（当前 4660） | 防上帝模块。`api/service.js` 868 行已登记 v0.2 拆分 |
| Q3 | 测试清单 | 测试文件 ≥ 8；`tests/unit` 与 `tests/injection` 都非空 | 防"只有单元测试没有行为测试"或反之 |
| Q4 | 评测对齐 | `eval/run.js` 里声明的每个 I 用例都要有注入测试文件；被引用的 `eval/cases/*.json` 必须存在 | 防"删了用例只留 runner 还显示全绿" |
| Q5 | 契约覆盖 | `src/` 每个 `export` 必须出现在 `docs/`（不含 research）中；**≥ 90%** | 防"导出即隐形契约"。内部工具写进 docs/02 §3.8，对外 API 写正文 |
| Q6 | 文档链接 | 站内相对链接目标必须存在（不含 `docs/research/readmes/` 快照） | 文档先行项目最怕文档腐烂成死链 |
| Q7 | 版本自包含 | `versions/<v>/` 必须有 `src/tests/eval/config/docs/DELTA.md/CHANGELOG.md/package.json`；`package.json.version` 必须等于 `CHANGELOG` 最新段 | 版本隔离是本项目的迭代纪律，靠人工守不住 |
| Q8 | 编码卫生 | 无 CRLF；文件末尾有换行 | 纯机械项，零争议，成本近乎为零 |
| Q9 | Web UI 层边界 | `ui/**` 与 `src/web/**` 不得 import `../hygiene/`、`../storage/`、`../index/`；`ui/**` 无 `http(s)://` 外链、无 `innerHTML/outerHTML/insertAdjacentHTML` 拼数据、无 `eval(`/`new Function(`（行级白名单 `// q9-allow: <理由>`，无理由即失败）；**零构建**（`ui/` 内无 `package.json`/锁文件/`node_modules`/`dist`/`build`）；**单文件 ≤600 行、`ui/` 总量 ≤2500 行**；HTML 的 `<script src>`/`<link href>` 只允许相对路径；`src/web/static.js` 存在且只服务 ui 目录 | Web 层是只读投影（docs/08 契约），越界 import 或 HTML 拼接会破坏"读不到、改不了、注入不进"三条安全底线 |

## 四、安全门禁（security-check.mjs，9 项）

| ID | 检查 | 判定 | 说明 |
|---|---|---|---|
| S1 | 个人绝对路径 | 全仓无 `/Users/<name>`、`/home/<name>`、`C:\Users\<name>`（`docs/research/readmes/` 快照豁免） | 公开仓库不泄露本机用户名/目录结构 |
| S2 | 凭据/私钥 | 无 `ghp_`/`github_pat_`/`gho_`/`sk-`/`AKIA`/`xox?-`/`BEGIN PRIVATE KEY` | |
| S3 | 内部资产 | 无公司内部域名后缀、无内网 IP 段（RFC1918 三段） | 公开仓库不泄露组织内部主机名与网段；规则模式见 `tools/security-check.mjs` S3 |
| S4 | 配置模板可移植 | `versions/**` 内不得残留真实 home 路径 | 三端配置必须换机可用 |
| S5 | `.gitignore` | 必须覆盖 `.memo/`、`node_modules/`、`.DS_Store`、`*.log`、`.env` | 记忆正文永不入库 |
| S6 | 许可证与元数据 | `LICENSE` 为 MIT 且版权行正确；`package.json` 有 `license` 与 `repository.url` | 可追溯性 |
| S7 | 大文件/二进制 | 单文件 ≤ 1MB；非图片白名单内不得有 NUL 字节 | 防误提交数据库/日志/产物 |
| S8 | 历史面轻扫 | git 历史当前可达提交中无凭据形态 | 完整历史扫描交给 GitHub 原生 secret scanning + CodeQL |
| S9 | 部署面安全 | `src/web/server.js` 默认 `host = '127.0.0.1'`（出现 `0.0.0.0`/`::` 即 fail；另有**运行时**回环断言，传非回环地址直接 `E_INVALID_ARG`）；`src/web/**` 无写调用（`service.write/forget/supersede/curateApply`、`appendEvent`）；`ui/**` 只 fetch `/api` 相对路径；`.gitignore` 含 `.memo/` 与 `node_modules/` | Web 服务默认只绑定回环、只读不写，误改一行就可能把记忆库暴露到局域网或引入写端点 |

**另外两层**（CI 里跑，不在本地脚本）：
- **CodeQL**（`security-and-quality`）：静态分析，发现注入/原型污染/不安全正则等。
- **GitHub 原生 secret scanning**（公开仓库免费）：push 时与历史全量扫描，比自研正则更全。


### 4.1 允许清单（security-allowlist.json）

有些文件里**必须**出现看起来像凭据/内网地址的字面量：脱敏测试的夹具、投毒用例、审核探针、
以及审核报告里引用的本机路径。硬删会让测试失去意义，放宽规则又会让门禁形同虚设。

折中：`tools/security-allowlist.json` 显式登记，**每条必须写 `reason`**（缺 reason 不生效）：

| 字段 | 作用 |
|---|---|
| `entries[]` | `{rules, glob, reason}`：按规则 + 路径 glob 豁免；`**` 跨目录、`*` 不跨目录 |
| `syntheticSecrets[]` | `{value, reason}`：登记「已知构造样例」的值前缀，S8（git 历史面）按前缀过滤 |

约束：

- 只允许登记测试与留证目录（`versions/*/tests/**`、`versions/*/reviews/**`），生产代码不得豁免。
- S8 只过滤**登记过的值**：新提交里出现的凭据仍然失败——豁免的是历史遗留样例，不是未来。
- 改动本文件属于「改契约」，需在 PR 里说明原因（与阈值变更同流程，见 §六）。

## 五、流程门禁（issue-link.yml）

| 规则 | 判定 |
|---|---|
| MR 必须关联 issue | 正文含 `Closes|Fixes|Resolves #N`，或 `Refs|Part of #N` |
| 被引用的 issue 必须存在且 open | 调 GitHub API 校验；挂到已关闭 issue 上直接失败 |
| 豁免 | 仅 `no-issue` 标签，且正文必须写豁免理由（便于事后审计） |
| 分支保护 | `main` 禁止直推/force push；必须过全部 required checks（含 `issue-link`）；**管理员也受约束**（`enforce_admins=true`） |

## 六、指标复盘与阈值变更

- **谁改阈值**：维护者（CODEOWNERS），且必须走 issue + MR，在 issue 里回答三个问题：
  1. 当前阈值为什么不再合理（贴实测数据，不写"太严了"）；
  2. 放宽后谁可能受影响（哪类回归会漏过）；
  3. 补偿措施是什么（新增哪条注入式用例 / 哪个脚本检查）。
- **每季度复盘一次**：把 `quality-report.json` / `security-report.json` / 覆盖率三个数与本文件表格对比，
  指标发生漂移就更新本文件（指标漂移本身就是信号，不要静默改阈值让数字好看）。
- **禁止**：删除检查项、加 `// q-check-ignore` 式逃逸、把失败改成 warning 了事。

## 七、当前基线（2026-11-10 实测，v0.4.0）

| 门禁 | 结果 |
|---|---|
| 单元 + 注入式 | **391 tests / 370 pass**（`node --test 'tests/**/*.test.js'`） |
| 评测 | **eval I1–I36 全 PASS**（`node eval/run.js`） |
| 质量 | 9/9；Q5 契约覆盖 **97.6%**（165/169 导出，下限 90%，其余为 UI/内部工具） |
| 安全 | 9/9（含 S9：src/web 无写接口、只绑回环） |
| 覆盖率 | lines 93.37% / branches 81.14% / functions 92.57%（阈值 lines ≥ 85% / branches ≥ 70% / functions ≥ 90%） |
| Windows | `tools/windows-smoke.mjs` 6 项全 PASS（`windows-latest` job 见 §一.1） |
| 平台侧 | secret scanning ✅ / push protection ✅ / dependabot security updates ✅（见 §八） |

> Q2 单文件上限仍是 900 行；源码总量上限在 v0.4 从 9000 调到 **12000**（新增语义道 / 捕获 / 分歧 /
> 注入 / 脱敏 / 搜索页共 8 个模块约 1450 行）。放宽的是总量，不是单文件——理由是「宁要多个职责单一的小文件，
> 不要一个变大的文件」。

### 覆盖率为何 exclude `src/cli/memo.js`

`node --test --experimental-test-coverage --test-coverage-exclude='**/src/cli/memo.js'`：
它是**进程入口外壳**（顶层 `await main()`、`process.exit`、直接写 stdout），无法 import 测试；
它的行为由 `tests/unit/cli-entry-smoke.test.js`（真 spawn：`--help` 退出 0 / 未知命令退出 2 /
write→search→stats 走通）+ `tests/unit/run-script.test.js` + eval 的 CLI 子进程用例覆盖。
**只有这一个文件被排除**，其余 `src/` 全在统计内——这是「排除不可 import 的入口」而不是「排除难测的逻辑」。

## 八、线上状态与验收证据（2026-11-02 实测）

仓库设置（`gh api .../branches/main/protection`）：

```json
{
  "required_status_checks": {"strict": true,
    "contexts": ["test (22)", "test (24)", "eval (I1–I23)", "quality", "security", "codeql", "issue-link", "windows-smoke"]},
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
```

平台侧：secret scanning ✅ / push protection ✅ / dependabot security updates ✅；
CodeQL 走 workflow 的 `security-and-quality` 查询集（另有 GitHub 默认 CodeQL 状态检查）。

**三条实测证据**：

1. **不关联 issue 会被拦**：PR #7 首次提交正文无 issue 引用 →
   `issue-link` 失败并打印「本 MR 没有关联 issue」；补 `Refs #1` 后转绿（run 41406160471）。
2. **全量 checks 通过后合并**：PR #7 九项检查全绿后 squash 合并（`2b4dc16`）。
3. **直推 main 被拒**（保护对管理员同样生效）：

```
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote: - 7 of 7 required status checks are expected.
! [remote rejected] main -> main (protected branch hook declined)
```

> 为什么把 review 要求设为 0：本仓当前只有一位维护者，自己给自己 review 是假动作。
> 强约束放在**可机械检验**的部分（checks + issue 关联 + 线性历史 + 禁直推），
> 人工评审通过 CODEOWNERS 指派与 PR 模板的「决策与取舍」段落留痕，等有第二位维护者时再开 review 要求。
