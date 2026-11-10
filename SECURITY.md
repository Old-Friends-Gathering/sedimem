# 安全策略

## 这个系统里"什么是敏感数据"

`sedimem`（仓库名 sedimem，技术标识仍是 `memo`）存的是**跨会话的个人/项目事实**，默认落在本机
`$MEMO_HOME`（缺省 `~/.memo`）。真正的敏感面不是"代码漏洞"，而是：

| 资产 | 风险 | 现有防线 |
|---|---|---|
| 记忆正文（`items/*.jsonl`） | 被投毒的文本进入 brief 进而进入模型上下文 | 写入即打标 + 读路径默认遮蔽 + brief 逐行复检（投毒 10 变体实测 0 泄露） |
| 真相层文件 | 被并发写坏 / 被原地篡改 | append-only + 跨进程锁 + 坏行 fail-loud（`E_CORRUPT_JSONL` 带 file:line） |
| 分库（scope） | 跨项目污染：A 项目的记忆出现在 B 项目 | 按客户端隔离的 `.scope.<client>.json`；`memory_scope` 连接级切换 |
| 三端配置（DSH/Codex/Claude） | 提交含个人绝对路径或 token | 配置模板全部用 `!!js process.execPath` / `$HOME` 推导；`security-check` S1/S4 拦 |
| `hits`/评测产物 | 间接暴露查询内容 | 只在本地 `$MEMO_HOME`，不入库（`.gitignore`） |

**边界说明**：本项目**不是**加密存储，也不做多用户隔离。分库（scope）是"分类"不是"权限"——
同一台机器上任何能读 `$MEMO_HOME` 的进程都能读全部分库。要真隔离请用文件系统权限或独立用户账户。

## 报告漏洞

- **不要开公开 issue**。用 GitHub 私密漏洞报告：
  <https://github.com/Old-Friends-Gathering/sedimem/security/advisories/new>
- 报告请包含：影响版本（`versions/*/CHANGELOG.md` 的最新段）、复现步骤、影响面（是否泄露记忆正文/能否跨分库读取/能否绕过 suspicious 遮蔽）。
- 我们会在 7 天内给出初步结论；确认后修复并在此文件记录（不含利用细节）。

## 支持范围

| 版本 | 状态 |
|---|---|
| v0.1.x | 维护中（接受的修复：数据损坏、越权读取、投毒绕过、跨分库污染） |
| < v0.1 | 不支持 |

## 已知且已接受的风险（不是漏洞）

1. **词法去重的残余空洞**：语义等价但用词全换的记录可能同时 active，靠 Agent 裁决收敛（docs/02 §3.6 裁决 29）。这是 v0.1 明确取舍，不是缺陷。
2. **分库是分类不是权限**：见上。
3. **DSH 常驻进程 cwd 固定**：默认 scope 可能是 `dir:desktop` 而非你的项目；需要会话内 `memory_scope({action:'use', path:'<项目根>'})` 对齐（docs/06）。
4. **nightly 需用户自己装 crontab**：没装就不会自动整合，不会静默失败（`memo doctor` 能看到未整合计数）。
