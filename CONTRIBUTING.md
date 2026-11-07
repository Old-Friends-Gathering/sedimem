# 贡献指南

本项目是**记忆系统**：它自己会长期存事实，所以"改错一行"的代价比普通项目高——写进真相层的东西不会消失。
因此流程刻意比一般仓库重：**先 issue，再 MR，三道门禁全绿才可合并**。

---

## 一、流程（强制）

```
Issue（feature/bug/chore 模板）
   ↓  必须：验收标准可机械检验
分支：<type>/<issue号>-<短描述>      例：feat/42-scope-isolation
   ↓  必须：先写失败测试（TDD），再实现
MR：正文写 `Closes #42`
   ↓  GitHub Actions 四道 workflow 全绿（管理员同样受限）
main（受保护分支，禁止直推 / 禁止 force push）
```

- **没有 issue 的 MR 会被 `issue-link` 门禁拦下**（docs/CI/依赖升级这类不改变行为的改动可加 `no-issue` 标签，但必须在正文写理由）。
- 一个 issue 拆多个 MR：正文用 `Refs #42`，最后一个 MR 用 `Closes #42` 收口。
- 分支保护：`main` 只接受 PR，且必须通过 `test (22)`、`test (24)`、`eval (I1–I12)`、`quality`、`security`、`codeql`、`issue-link` 七项检查；
  `enforce_admins=true`——**维护者自己也不能直推**（实测 `git push origin main` 返回 `GH006 ... 7 of 7 required status checks are expected`）。

## 二、提交前必跑（本地，与 CI 同源）

```bash
cd versions/v0.3
node --test 'tests/**/*.test.js'     # 单元 + 注入式回归
node eval/run.js                     # I1–I12 评测

cd ../..
node tools/quality-check.mjs         # 质量门禁 8 项
node tools/security-check.mjs        # 安全门禁 8 项
node tools/coverage-gate.mjs         # 覆盖率门禁
```

> 必须用 `'tests/**/*.test.js'`（glob）。`node --test tests/` 会 MODULE_NOT_FOUND——这是 Node 的 glob 语义差异，不是测试本身的问题。

## 三、写代码的硬约束

1. **零运行时依赖**：只能用 `node:` 内置模块。想引第三方库 = 先改 `docs/00` 与 `docs/03`（Ports 里加适配器）并写 ADR。
2. **文档先行**：接口/数据模型/工具语义变更，先在 `docs/02-data-model-and-contract.md` 写清（含新裁决编号），再动代码。
3. **TDD**：新行为先加会失败的测试；注入式回归（`tests/injection/i*.js`）**不允许为了让 CI 变绿而改断言**——那是行为契约。
4. **真相层不可变**：`items/*.jsonl` 只追加。任何"改过去"都是追加新版本（`supersede` / 墓碑），不得原地修改或删除行。
5. **不吞错**：`catch {}` 只允许出现在"尽力而为且已记录"的地方（如锁文件删除），并且要有注释说明为什么安全。
6. **不静默降级**：缺参数/缺身份/坏数据一律 fail-loud（`E_*` 错误码），不允许"猜一个默认值继续跑"。

## 四、门禁怎么调

- 阈值集中在 `tools/quality-check.mjs` 的 `THRESHOLDS`、`tools/coverage-gate.mjs` 的命令行默认值。
- **调阈值 = 改行为契约**：必须在 issue 里说明"为什么当前阈值已不合理/为什么这次可以放宽"，并同步 `docs/07-quality-and-security.md` 的阈值表。
- 禁止：为了过门禁而删测试、改断言、放宽阈值、加 `no-issue` 标签绕过流程。发现别人这么干，按 bug 处理。

## 五、提交信息

```
<type>(<scope>): <一句话>

Closes #42
```

`type` ∈ `feat|fix|refactor|test|docs|chore|perf`；`scope` 用模块名（`mcp`/`hygiene`/`storage`/`api`/`cli`/`eval`/`tools`）。

## 六、安全

- 泄露凭据/个人路径/真实记忆正文 → 按 `SECURITY.md` 走私密报告，**不要开公开 issue**。
- 提交前 `node tools/security-check.mjs` 会拦住常见形态（`/Users/<name>`、`ghp_`、内部域名、内网 IP）。
