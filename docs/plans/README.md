# 计划文档（plans）

> 这里放**实施计划**：把一个已在 `docs/` 冻结的设计拆成可执行任务（谁改哪些文件、什么顺序、怎么验收、怎么回滚）。
> 设计规格不放这里 —— 规格在 `docs/` 根下，计划只是它的施工图。

| 计划 | 对应需求 | 状态 | 覆盖版本 |
|---|---|---|---|
| [`v1.3-p0a.md`](v1.3-p0a.md) | P0a 地基：CI/文档/版本真值化（v1.3） | 已完成（PR #208） | v1.3.0 |
| [`v1.3.1-task-library-naming.md`](v1.3.1-task-library-naming.md) | [#210](https://github.com/Old-Friends-Gathering/sedimem/issues/210)：任务库术语与 MCP 入口修复（session-99680927 复盘） | 已完成（PR [#211](https://github.com/Old-Friends-Gathering/sedimem/pull/211) 已合并） | v1.3.1 |
| [`future-architecture.md`](future-architecture.md) | m00378：基于 v1.2 重新调研后的未来架构（个人观测台 + 治理路线） | 已批准（A） | 自 v1.3 起（P0a 已完成） |
| [`v0.2-web-ui-plan.md`](v0.2-web-ui-plan.md) | issue [#10](https://github.com/Old-Friends-Gathering/sedimem/issues/10) 只读 Web UI（设计见 [`08-web-ui.md`](../08-web-ui.md)） | 待执行 | v0.1.3 + v0.2.0 |

## 约定

1. **一份计划对应一个 issue**：计划顶部写关联 issue 链接，PR 用 `Refs #N`。
2. **计划不改设计**：发现设计有洞 → 回到 `docs/` 改规格并提 issue，不在计划里私自扩大范围。
3. **写盘范围写进计划**：并行执行时按文件划分，冲突在计划阶段解决，不在实施阶段抢文件。
4. **计划完成后不删**：补一节「执行结果」（实际耗时、偏离项、遗留项），作为下一次排期的依据。
