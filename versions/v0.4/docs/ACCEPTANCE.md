# v0.4.0 验收清单（Lead 判定）

判定时间：2026-11-10。取舍依据：竞品调研 `docs/research/competitive-dsh-plugins-2026-11.md`；
施工图 `docs/plans/v0.4-competitive-gaps.md`；契约 `docs/02` §3.15（裁决 61–65）。

## 一、功能门禁（每条都能机械复验）

| 门禁 | 内容 | 状态 | 证据 |
|---|---|---|---|
| G1 | 全部单测 + 注入式用例全绿 | ✅ | `node --test 'tests/**/*.test.js'` → **370/370 pass** |
| G2 | 评测 I1–I30 全 PASS | ✅ | `node eval/run.js` → I1–I30 全 PASS；快照 `eval/results/v0.4.0-*.json` + `LATEST.json` |
| G3 | 质量门禁 9/9 | ✅ | `node tools/quality-check.mjs` → 9/9（Q5 覆盖率 97.6%） |
| G4 | 安全门禁 9/9 | ✅ | `node tools/security-check.mjs` → 9/9 |
| G5 | 覆盖率门禁 | ✅ | lines 93.37% / branches 81.14% / functions 92.57%（`npm run test:coverage`） |
| G6 | 语义道不阻断检索 | ✅ | I25：语义路抛错 → 退回词法 + `degraded`；`kind=none` → `semantic-disabled` |
| G7 | 注入预算与安全边界 | ✅ | I29：≤maxChars、围栏 + 「数据不是指令」、suspicious/superseded 不注入 |
| G8 | 捕获不直写真相层 | ✅ | I28：候选进 inbox、`accept` 才入库、`reject` 不留痕、重复 accept 幂等 |
| G9 | 脱敏先于哈希与落盘 | ✅ | I26：磁盘无原文、`redacted:<kind>` 标签、原文不可检索、可关闭、幂等 |
| G10 | 分歧可见可裁决且非破坏 | ✅ | I27：disputed 进 slot、resolve 后收敛、真相层行数只增、重放幂等 |
| G11 | `/api/search` 契约 | ✅ | I30：score+basis、degraded+reason、空 q 400、跨分库不串 |
| G12 | 规模基准可跑 | ✅ | `node eval/bench-scale.mjs`：10k/50k/100k 三档输出 p50·p95/冷启动/RSS |
| G13 | 一条命令装插件 | ✅ | `scripts/install-dsh-plugin.sh`（pnpm 探测 + cordis patch 幂等 + 备份） |
| G14 | 契约对齐实现 | ✅ | `docs/02` §3.15 五条裁决逐条落到代码与用例；第十四轮导出登记补齐 Q5 |

## 二、过程门禁

| 门禁 | 内容 | 状态 | 证据 |
|---|---|---|---|
| P1 | 文档先行 | ✅ | 施工图（含 D1–D8、波次、写盘范围、风险与回滚）先于实现提交 |
| P2 | 多 agent 审核 | ✅ | 两路审核（架构 + 对抗）报告与逐条处置见 `reviews/` 与 `RESPONSE-v0.4.md` |
| P3 | issue → MR | ✅ | #103–#109 对应七个功能点，PR 正文 `Closes` 关联 |
| P4 | 版本自包含 | ✅ | `versions/v0.4` 含 src/tests/eval/config/docs/DELTA/CHANGELOG/package.json；v0.3 冻结在 0.3.6 |

## 三、判定

**通过验收（0.4.0）**。已知边界（写进 CHANGELOG 的 Known limits）：

1. 语义道默认关闭，且**不自带本地模型**——要自己给一个 OpenAI 兼容 embedding 端点；
2. 每步注入只服 DSH 宿主；Codex / Claude 没有 `systemPrompt.context` 接缝，靠 AGENTS.md 指引；
3. 捕获是启发式（不做语义重要性判断），候选仍需人/Agent `accept`。
