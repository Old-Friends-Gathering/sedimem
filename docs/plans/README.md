# 计划文档（plans）

> 这里放**实施计划**：把一个已在 `docs/` 冻结的设计拆成可执行任务（谁改哪些文件、什么顺序、怎么验收、怎么回滚）。
> 设计规格不放这里 —— 规格在 `docs/` 根下，计划只是它的施工图。

| 计划 | 对应需求 | 状态 | 覆盖版本 |
|---|---|---|---|
| [`v1.4.1-auto-capture-watch.md`](v1.4.1-auto-capture-watch.md) | issue #223 后续：周期扫描触发自动捕获 | 执行中 | v1.4.1 |
| [`v1.4-p0b.md`](v1.4-p0b.md) | m02899：P0b 安全与信任最小集 + 英文视觉资产 / README 站点链接 | 已完成（PR #215） | v1.4.0 |
| [`v1.3-p0a.md`](v1.3-p0a.md) | P0a 地基：CI/文档/版本真值化（v1.3） | 已完成（PR #208） | v1.3.0 |
| [`v1.3.1-task-library-naming.md`](v1.3.1-task-library-naming.md) | [#210](https://github.com/Old-Friends-Gathering/sedimem/issues/210)：任务库术语与 MCP 入口修复（session-99680927 复盘） | 已完成（PR [#211](https://github.com/Old-Friends-Gathering/sedimem/pull/211) 已合并） | v1.3.1 |
| [`future-architecture.md`](future-architecture.md) | 2026-11-18 用户：AI-Native 求职作品，重点规划上下文抽取准确性；开源复核后更新路线 | 单 agent 对抗检查修订完成（[报告](../reviews/future-architecture-2026-11-18/REVIEW.md)）；P1a 待执行 | P0a/P0b 完成；P1 v2.0 起 |
| [`v2.0-p1.md`](v2.0-p1.md) | issue [#218](https://github.com/Old-Friends-Gathering/sedimem/issues/218)：P1a v2.0 第一波（标注规范/冻结测试集/基线/证据 schema 规格/九项冻结），规格包见 [`design/v2.0/`](../design/v2.0/README.md) | 执行中：B0 计划+三审（PR #219，[报告](../reviews/v2.0-p1a-2026-11-18/REVIEW.md)）；规格包三审（PR #220，[报告](../reviews/v2.0-design-spec-2026-11-18/REVIEW.md)）；B1 语料+工具（PR #221）；B2 基线+评分+复核（PR #222，[报告](../reviews/v2.0-p1a-b2-2026-11-18/REVIEW.md)）；B3 exit 语料 218 场景（PR #240，[R2 报告](../reviews/v2.0-p1a-b3-2026-11-18/REVIEW.md)）；B4 九项冻结+含盲评工作流+exit 基线（[基线报告](../reviews/v2.0-p1a-exit-2026-11-18/BASELINE.md)，[R2 报告](../reviews/v2.0-p1a-exit-2026-11-18/REVIEW.md)） | v2.0（规划中，未切 CURRENT） |
| [`future-architecture-final-state.html`](future-architecture-final-state.html) | 终态架构可视化（图 1 分层总览 / 图 2 候选生命周期交互图），随上表计划更新 | 可视化随计划更新 | 推演至 P2/P3/P5 终态 |
| [`v0.2-web-ui-plan.md`](v0.2-web-ui-plan.md) | issue [#10](https://github.com/Old-Friends-Gathering/sedimem/issues/10) 只读 Web UI（设计见 [`08-web-ui.md`](../08-web-ui.md)） | 待执行 | v0.1.3 + v0.2.0 |

## 约定

1. **一份计划对应一个 issue**：计划顶部写关联 issue 链接，PR 用 `Refs #N`。
2. **计划不改设计**：发现设计有洞 → 回到 `docs/` 改规格并提 issue，不在计划里私自扩大范围。
3. **写盘范围写进计划**：并行执行时按文件划分，冲突在计划阶段解决，不在实施阶段抢文件。
4. **计划完成后不删**：补一节「执行结果」（实际耗时、偏离项、遗留项），作为下一次排期的依据。
