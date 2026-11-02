# v0.1 验收清单（Lead 判定）

判定时间：2026-11-02（第二轮审核 + 3 轮修复后）

| 门禁 | 内容 | 状态 | 证据 |
|---|---|---|---|
| G1 | `node --test 'tests/**/*.test.js'` 全绿 | ✅ | 95 tests / 95 pass / 0 fail，连跑 10 次 0 flake（修复了 lock 超时用例自身的竞态） |
| G2 | `node eval/run.js` I1–I11 全 PASS，`dupRatio<0.10`、`conflictRate<0.20`、search p95<50ms | ✅ | I1–I11 全 PASS；dupRatio=0、conflictRate=0；bench n5000 write p50=3.01ms/p95=5.89ms，search p95=2.24ms；快照 `eval/results/LATEST.json` |
| G3 | `memo doctor` 无 error | ✅ | 健康库 `{ok:true,issues:[]}` exit 0；坏库结构化报 `corrupt_jsonl` exit 1（不再裸崩）；重复 contentHash 报 warn |
| G4 | reviews/arch.md 与 reviews/adversarial.md 无阻断项 | ✅ | 3 个阻断项全部修复并有独立复现证据，见 `reviews/RESPONSE.md` |
| G5 | docs/02 契约逐条对齐实现 | ✅ | §3.1（裁决 1–12）+ §3.2（13–21）+ §3.3（22–24）+ §3.4（25）逐条落到代码；每个裁决都有对应测试 |
| G6 | CHANGELOG + README 版本索引 | ✅ | 本目录 CHANGELOG 0.1.0，`memory-system/README.md` 版本表 |
| G7 | 三端配置就绪：DSH cordis patch / Codex config.toml / Claude mcp add | ✅ | `configs/dsh-cordis.patch.yml`（已按真实 DSH 形状修正）、`configs/codex-config.toml`、`configs/claude-mcp.sh` |
| G8 | 三步召回验证脚本可跑（写→新会话召回→使用） | ✅ | `bash configs/verify-three-clients.sh` → PASS（新进程读到上一进程写入的盐值并回答） |

## 追加门禁（审核后新增，均已通过）

| 门禁 | 内容 | 状态 | 证据 |
|---|---|---|---|
| G9 | 10 进程并发写同一事实 → `active=1` | ✅ | I8 用例 + Lead 手工 probe：`created=1 / noop_duplicate=9 / dupRatio=0` |
| G10 | 20 条换措辞同义句 → `disputed=0` | ✅ | 词面近似：`created=1 / nearDupBlocked=19`；真人改写：在线不误杀、`dedupeScan` 聚成同一簇 |
| G11 | Agent 裁决闭环可跑通 | ✅ | I11：6 条改写 → dedupeScan → curateApply → `active=1`、败者 superseded、真相层 6 行全保留 |
| G12 | 10 个投毒变体全部拦截且不进 brief | ✅ | 10/10 suspicious，brief 原文泄露 0 条；10 条正常技术文本误报 0 |
| G13 | 中文改写（含内容词全换）能被召回并由 Agent 收敛 | ✅ | I12：4 条同义中文 → 双路召回（containment 0.556–0.667 / Dice 0.26）→ 裁决 → `active` 收敛、真相层 14 行全留、再扫清零；无关中文事实 0 虚报 |
| G14 | 三端能对齐到同一分库（不再因常驻进程 cwd 固定而静默分裂） | ✅ | `memory_scope({action:'use',path})` 实测把 DSH 侧从 `dir:desktop` 切到 `dir:my-project` 并持久化到 `.scope.<client>.json`；16 个单测覆盖优先级/隔离/降级；`memo scope` 可核对 |

## C1–C6 映射

- C1 本地离线 → G1+G2 在无网络、零依赖下跑通（`package.json` 无 dependencies）
- C2 三端共享 → G7 + G8（MCP 是唯一缝，AGENTS.md 是指令桥）
- C3 重复不增长 → I1 + I7a（词面）+ I11（语义，Agent 裁判）
- C4 冲突失效 → I2 + asOf 查询（时间戳比较）
- C5 自治 → curate export/apply + dedupeScan + nightly（brief/metrics 落盘）+ G11
- C6 轻 → 无依赖、JSONL 真相层、派生层可整目录删除重建

## 判定

**v0.1（含 0.1.1 中文去重补强）通过验收，可投入使用**。遗留（明确延期，见 RESPONSE.md §五）：JudgePort 注入点、kind 注册表数据化、错误码归一、compact/物理清理、向量检索。
