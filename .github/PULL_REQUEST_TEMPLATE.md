<!--
合并前自检：README「门禁」一节 + CONTRIBUTING「提交前必跑」。
CI 会跑：ci / quality / security / issue-link 四个 workflow。
-->

## 关联 issue

Closes #

<!-- 同一 issue 拆多个 MR 用 `Refs #<号>`。docs/CI/依赖升级这类不改变行为的改动加 `no-issue` 标签并说明理由。 -->

## 改了什么

-

## 为什么这么做（决策与取舍）

<!-- 写"为什么不是另一种做法"。评审首先看这一段。 -->

## 契约与文档

- [ ] 未改对外契约（docs/02）
- [ ] 改了对外契约：已先在 `docs/02-data-model-and-contract.md` 写清并附 ADR 段
- [ ] 同步了 `CHANGELOG.md` 与本版本 `docs/DELTA.md`

## 验证证据

- [ ] `node --test 'tests/**/*.test.js'`（在 `versions/v0.1/` 下）全绿：__ 个用例
- [ ] `node eval/run.js` I1–I12 全 PASS，关键指标：dupRatio=__ conflictRate=__
- [ ] `node tools/quality-check.mjs` 8/8
- [ ] `node tools/security-check.mjs` 8/8
- [ ] `node tools/coverage-gate.mjs` 通过（lines __% / branches __% / functions __%）

## 风险与回滚

<!-- 真相层/索引/分库/三端配置哪一块可能受影响？回滚是 revert 还是需要数据修补？ -->

- 影响面：
- 回滚方式：

## 安全自查

- [ ] 没有提交凭据、个人绝对路径、真实记忆正文
- [ ] 新增的读写路径不会绕过 suspicious 遮蔽、不破坏 append-only
- [ ] 没有引入运行时依赖（本项目零依赖）
