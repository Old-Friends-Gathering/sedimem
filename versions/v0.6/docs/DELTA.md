# v0.5 · 版本说明（DELTA）

本版只做一件事：把「线上项目站有没有真的更新」变成**可自动发现**的问题。

## 本版做了什么

1. **`tools/pages-verify.mjs`**：抓 GitHub Pages 首页，断言出现 `v<当前版本>`，再抽查
   `assets/{today,graph,hygiene}.png` 三个 200；Pages 构建要几分钟，默认重试 20×15s。
   失败原因分四类（`version-mismatch` / `asset-missing` / `http-error` / `fetch-failed`），
   退出码 `0` 一致、`1` 不一致、`2` 用法错误。
2. **`.github/workflows/pages-verify.yml`**：`push: main` + 每天 03:17 UTC 巡检 + 手动；
   失败时开 issue（同标题已 open 只评论），并让 job 红。
3. **文档闭环**：`docs/07` 增「发布面监控」（Q10 合并前 / pages-verify 合并后），
   `docs/05` §6.2 写入合并后校验动作。

## 为什么不是「补丁版本」

按既定纪律 `X.Y` 换目录、`X.Y.Z` 同目录递增：这次改的是**发布流程**（新增一个 CI 工作流
+ 一个新的跨仓工具），不是修 bug，所以走 `v0.5.0` 新目录，`versions/v0.4` 冻结在 0.4.4。

## 刻意不做

- 不做截图视觉回归：UI 仍在动，diff 噪声大于信号；
- 不在 Pages 构建失败时自动重试：GitHub 没有可用 API，只能报告给人；
- 不把 pages-verify 加进分支保护：PR 阶段 Pages 尚未构建，卡 PR 只会逼人 `--admin`。

## 与最初认知的差异

1. 原以为 Q10 就够了，实际它只能看仓库——**「仓库正确」与「线上正确」之间隔着一次异步构建**，
   这次事故的形状（合并后全绿、线上旧版）正是被这个缝隙漏掉的。
2. 原以为巡检该「每天都跑一次就够」，实际首次失败基本都是构建没跑完：
   重试 5 分钟能把绝大多数误报消掉，这比降频率更有效。

## v0.5.1 / v0.6 入口

- 语义道回填进 nightly（有 embedder 时增量补）；`memo embedder check` 体检；
- 注入可解释性：把「注入了哪些记录」写进 `events.jsonl`；
- 捕获从 `codex`/`claude` 会话文件抽候选；
- 用 LongMemEval 的 turn 级 `has_answer` 做「分层 vs 扁平」A/B。
