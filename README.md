# memo —— 本地跨会话「自我迭代」记忆系统

DSH / Codex CLI / Claude Code 三端共用一份本地记忆，重点不是检索，而是**治理**：去重、冲突失效、自治整合。

- 调研与方案依据：**[`docs/research/`](docs/research/README.md)**（报告 + 落地计划 + 3 份原始调研 + 8 份项目 README 快照）
- **文档先行**：本目录 `docs/` 是跨版本文档（原则/需求/架构/契约/评测/流程）。实现必须服从文档，文档变更走 ADR。
- **版本隔离**：每个可运行版本是 `versions/vX.Y/` 下自包含的目录（代码 + 测试 + 评测 + 该版本的差异说明）。**不同版本不混写代码**；旧版本保留用于对比与回滚。

## 目录

```
memory-system/
├── docs/                    # 跨版本文档（冻结 → 变更需 ADR）
│   ├── 00-principles-and-requirements.md
│   ├── 01-architecture.md
│   ├── 02-data-model-and-contract.md   ← 实现契约（唯一权威）
│   ├── 03-iterability-and-versioning.md
│   ├── 04-eval-plan.md
│   ├── 05-process.md        # 文档先行 → TDD → 多 agent 审核 → 门禁
│   ├── 06-usage.md          # 三端落位 / 日常工具 / 维护 / 排障
│   └── research/            # 调研资料（证据基础，非设计文档）
│       ├── memory-system-report-and-plan.md      ← 先看这份：结论 + 计划
│       ├── agent-memory-projects-survey-2026-11.md
│       ├── memory-ecosystem-2026.md
│       ├── ai-memory-hygiene-survey.md
│       └── readmes/         # 8 个项目 README 快照
├── versions/
│   └── v0.1/                # 自包含：src/ tests/ eval/ configs/ docs/DELTA.md CHANGELOG.md reviews/
└── README.md
```

## 版本索引

| 版本 | 主题 | 状态 | 验收 |
|---|---|---|---|
| v0.1 | P0 可用闭环 + 确定性卫生（hash/近重复去重、supersede、tombstone、brief、curate 队列、`dedupeScan`+Agent 裁决、投毒读取隔离、中文改写双路召回）<br>最新 0.1.1：`pairs` 逐对依据 + `strength` + 汉字二元组 Dice | ✅ 通过验收（0.1.0 2026-11-02 / 0.1.1 同日补强） | [`versions/v0.1/docs/ACCEPTANCE.md`](versions/v0.1/docs/ACCEPTANCE.md) |
| v0.2（规划） | JudgePort 注入点、kind 注册表数据化、compact/物理清理、EmbeddingIndex | 未开始 | — |

## 快速开始（v0.1）

```bash
# 全部零依赖：只用 Node 内置模块（node:test / node:crypto / node:fs）
NODE=${MEMO_NODE:-node}          # 任意 Node ≥ 22
cd memory-system/versions/v0.1
$NODE --test 'tests/**/*.test.js'   # 单元 + 注入式回归（注意必须用 glob，`--test tests/` 会 MODULE_NOT_FOUND）
$NODE eval/run.js              # 评测套件，输出 eval/results/*.json
$NODE src/cli/memo.js --help   # CLI
$NODE src/mcp/server.js        # MCP server（stdio）
```

## 迭代纪律（四条，违反即回退）

1. **文档先行**：接口/数据模型变更先改 `docs/02-data-model-and-contract.md` 并写 ADR，再改代码。
2. **TDD**：新行为先加失败测试（`tests/`），再实现；注入式回归是发布门禁，不允许改断言来变绿。
3. **可替换**：所有能力在 `Ports` 后面（Storage / Index / Judge / Renderer / Clock）。新增实现 = 新增适配器，不改 core。
4. **真相层不可变**：`items/*.jsonl` 只追加；任何"改过去"的操作都是追加一条新版本。索引随时可 `reindex`。
