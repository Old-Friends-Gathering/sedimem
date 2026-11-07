# v0.2 —— 已冻结（0.2.1）

本目录是 `0.2.x` 线的**发布快照**，冻结在 **0.2.1**（最后一个补丁）。

- 新功能一律进 `versions/v0.3/`（当前开发线，见 `versions/CURRENT`）
- 这里只接受**安全/正确性**补丁，且只有在需要为 0.2.x 发补丁时才改（发完补丁版本号进 `0.2.2`，目录不变）
- 门禁与 CI **不审本目录**（`tools/*-check.mjs` 只读 `versions/CURRENT`）；CodeQL 也已 `paths-ignore`

包含内容：拆 service 后的四模块（`api/`）、kind 数据化、`JudgePort` + `curate auto`、`compact`、检索健康指标、只读 Web 观察台（三页）、多分库浏览。
不含：分层视图（L2/L3）——那是 `v0.3` 起才有的。
