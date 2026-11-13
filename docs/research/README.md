# 调研资料（本记忆系统的证据基础）

这里放的是 **v0.1 设计与裁决所依据的原始调研**，不是设计文档本身。设计结论在上级目录
[`00`](../00-principles-and-requirements.md)–[`06`](../06-usage.md)，实现契约在 [`02`](../02-data-model-and-contract.md)。
**读的顺序**：想先看结论 → `memory-system-report-and-plan.md`；想验收「这个结论有没有证据」→ 下面的原始调研；1.0.0 立项依据见文末「v1.0.0 调研批次」。

## 文件

| 文件 | 回答什么问题 | 体量 | 产出方式 |
|---|---|---|---|
| [`memory-system-report-and-plan.md`](memory-system-report-and-plan.md) | **报告 + 落地计划**：8 个开源系统 + 3 端原生记忆机制的横向打分、C1–C6 硬需求、为什么最后是"自建薄治理层"、P0–P4 计划 | 353 行 | 我（Lead）依据下面三份原始调研合成 |
| [`agent-memory-projects-survey-2026-11.md`](agent-memory-projects-survey-2026-11.md) | **开源项目实测**：mem0/OpenMemory、Letta、Zep+Graphiti、cognee、MemOS、memU、Supermemory、Memobase 的 star/license/存储/检索/MCP 暴露/自我维护能力/成本 | 402 行 | 子代理 A，GitHub REST API + 源码核验，2026-11-02 |
| [`memory-ecosystem-2026.md`](memory-ecosystem-2026.md) | **编码 Agent 侧生态**：claude-mem、basic-memory、mcp-memory-service、Cline Memory Bank，以及 Claude Code / Codex CLI / DSH 各自的原生记忆机制与可插拔接缝 | 345 行 | 子代理 B，官方文档当天抓取 + 仓库 Issue 证据 |
| [`ai-memory-hygiene-survey.md`](ai-memory-hygiene-survey.md) | **治理机制综述**：冗余/重复/冲突/过时四类熵增的治理路径、阈值纪律、bi-temporal 失效语义、成本模型、评测方法、真实反模式 | 519 行 | 子代理 C，论文（arXiv 全部核验）+ 公开实现 |
| [`layered-memory-2026.md`](layered-memory-2026.md) | **分层蒸馏（L0–L3）在 GitHub 上更好的做法**：确定性聚合 vs LLM 生成、捕获/注入的成本与噪声治理、检索与评测（先校准裁判）；附对 sedimem 的三条建议与最小 A/B 实验设计 | 119 行 | 三名调研代理并行（glm-5.3），2026-11-07，只记打开过的页面/源码 |
| [`competitive-dsh-plugins-2026-11.md`](competitive-dsh-plugins-2026-11.md) | **DSH 记忆插件竞品对比**：生态四层分层、与 dsh-engram/memsearch/prime-memory/MemOS plugin 的逐维度对比表、我们的优势排序与诚实短板清单、对 v0.4 的候选含义 | 108 行 | Lead（Lead 实测 sedimem 侧 + 3 份竞品 README + awesome 快照通读），2026-11-10 |
| [`iclr-2027-memory-papers.md`](iclr-2027-memory-papers.md) | **记忆机制前沿**：ICLR 2027 未放榜（诚实说明），回退 ICLR 2026 Oral MemAgent（有损覆写，反面教材）、NeurIPS 2026 TriMem（三粒度并存，正面验证 append-only）、ICML 2026 MemoryArena（跨会话依赖 benchmark） | 100 行 | 调研代理（glm-5.3），2026-11-14，逐审分数被拦处标「未验证」 |
| [`graph-library-2026-11.md`](graph-library-2026-11.md) | **图谱库选型**：3d-force-graph / force-graph / vis-network / cytoscape / sigma / g6 / d3-force 的体积、license、单文件自托管难度与标签能力打分；结论 = force-graph 2D（gzip 56KB）+ 放弃自研 3D | 52 行 | 调研代理（glm-5.3），npm registry + jsdelivr 实测，2026-11-14 |
| [`docs-drift-audit-2026-11.md`](docs-drift-audit-2026-11.md) | **文档漂移审计**：14 篇文档逐条比对代码后的漂移表（README 288→471 测试、docs/06 全指 v0.3、docs/07 门禁数字自相矛盾…）+ 三分类治理方案 + Q14 机械门禁设计 | 91 行 | 调研代理（glm-5.3），本仓实测命令，2026-11-14 |
| [`code-refactor-baseline-2026-11.md`](code-refactor-baseline-2026-11.md) | **重构基线**：src 12598 行/60 文件、5 条循环依赖、2 条反向依赖、3 族重复实现、>400 行文件清单；目标 11 模块图与迁移顺序、行为不变保障 | 130 行 | 调研代理（glm-5.3），node 脚本实测，2026-11-14 |
| [`readmes/`](readmes/) | 上述 8 个项目 README 的**当日快照**（防止上游改动后结论无法复核） | 8 份 | 子代理 A 抓取 |

## 这些调研直接决定了哪些设计

不带证据的设计容易被"看起来合理"骗过去，所以每条重要决定都能追回原始数据：

| 设计决定 | 依据（本目录） |
|---|---|
| **不选现成系统，自建薄治理层** | `memory-system-report-and-plan.md` 打分表：没有一个同时满足 C1–C6；mem0 v3 改 ADD-only 后**主动放弃**过期/覆盖语义（`agent-memory-projects-survey-2026-11.md`）；mcp-memory-service 治理最强但 Issue #530 显示 hooks 静默失败会 218+ session 零记忆 |
| **在线词法只做「零误杀」保守去重，语义交 Agent** | `ai-memory-hygiene-survey.md` 阈值纪律 + 我在真实库上的实测（5 句真人改写词法只到 0.43–0.5） |
| **过时 = 失效而非删除（bi-temporal + 墓碑）** | 同上：Graphiti 自报 knowledge-update −3.36%，读路径必须显式过滤失效 |
| **不引入 embedding（v0.1）** | `agent-memory-projects-survey-2026-11.md`：cognee 的 GLiNER 是 demo 级精度；Supermemory 内置 bge-base 可离线但引入 300MB+ 依赖，与 C6「轻」冲突 → 留成 v0.2 的 `EmbedderPort` |
| **MCP 作为三端唯一缝，AGENTS.md 作为指令桥** | `memory-ecosystem-2026.md`：三端都支持 MCP 且工具名规则一致；AGENTS.md 由 Linux Foundation 托管、只解决指令可移植 |
| **中文改写要单独开一路汉字二元组度量** | 我基于 `ai-memory-hygiene-survey.md` 的度量框架，在中文语料上重测（英文结论不可直接搬） |

## 口径与已知限制

- **star / license / 最后 push 均为 2026-11-02 当日 GitHub REST API 实测**，之后会上漂移；引用时请带日期。
- 调研中途触发过 GitHub API 60 次/小时限额，因此除 mem0 外，各项目「issue 主题级统计」不完整（文中已逐处标注「未查到」）。
- 论文编号均核验过 arXiv abs 页；少数数字来自二手分析，文中用 ⚠️ 标注，**引用前请先核原文**。
- `memory-ecosystem-2026.md` 与 `agent-memory-projects-survey-2026-11.md` 覆盖范围不同：前者是**编码 Agent 侧**（Claude/Codex/DSH 生态），后者是**通用开源记忆系统**，两份都要看才算覆盖完整。

## v1.0.0 调研批次（2026-11-14）

1.0.0 是「彻底重构」版本，四份调研分别回答：记忆机制还有没有更优做法（`iclr-2027-memory-papers.md`）、图谱要不要换成成熟库（`graph-library-2026-11.md`）、文档为什么漂移以及怎么机械拦住（`docs-drift-audit-2026-11.md`）、代码基线离文档声明的架构有多远（`code-refactor-baseline-2026-11.md`）。结论汇总与波次见 [`docs/plans/v1.0.0-refactor.md`](../plans/v1.0.0-refactor.md)。
