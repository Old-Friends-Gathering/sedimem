# 开源记忆系统复核：证据约束的上下文抽取

日期：2026-11-18。目的：服务 Sedimem 的 AI-Native 开源作品与求职展示，重点验证 LLM 抽取、RAG、上下文预算、长期记忆与纠错。

## 方法与边界

- 本轮读取六个项目的官方 README、部分关键源码及官方文档，另读 LongMemEval 官方仓库；未安装运行竞品，未复现其性能。
- 下列 URL 为当日读取的可变 main / 官方站点，未锁 commit；不能作为永久版本保证。借鉴机制而非复制代码；实际实现前锁定参考 commit、许可和引用位置。
- 不采用 star、厂商自报准确率或不同模型下的榜单排名来决定设计。旧调研中的市场判断不自动沿用。
- 项目内依据：`versions/v1.4/src/index/{embedder,hybrid}.js`、`session/{checkpoint-llm,ledger-brief}.js`、最新任务 checkpoint 和 handoff。CLI 实测检索返回 `degradedReason=semantic-disabled`，不代表 embedding 实际启用。

## 官方证据与取舍

| 项目 | 本轮核验的机制 | Sedimem 采用 | 不直接采用 |
|---|---|---|---|
| Mem0 | 当前调用链使用 ADD-only 抽取 prompt，输入新消息及已有记忆；两类角色均可产生抽取内容；已有 ID 映射约束 | 原子候选、输入已有上下文、ID 必须来自提供的集合 | 把 assistant 建议当成用户事实；依赖模型自行保证不遗漏 |
| LangMem | 区分语义/经历/程序记忆；提供前台记忆工具和后台整理 | 按类型定义抽取目标；前台可显式记，后台异步抽候选 | 自动改系统指令、把后台归纳直接当已确认事实 |
| Graphiti | 抽取结构含有效/失效时间及 episode 索引 | 记录证据事件及业务时间，未知留空，变更追加失效 | 引图数据库、跨源实体消解，或用时间戳替代完成状态 |
| Letta Code | 当前 Letta README 已将活跃源码指向 letta-code；其支持记忆块、消息检索和上下文改写 | 热上下文与可检索历史分开；按需恢复消息证据 | 整套 harness、自修改 prompt/技能或覆盖原始事实 |
| claude-mem | observer 将工具活动转为观察与会话摘要；启动注入紧凑索引后按需展开 | 索引→证据片段→局部原文的渐进读取；稳定来源 ID | 多端 hook 矩阵、全量上下文默认注入 |
| Hindsight | retain/recall/reflect 分工；官方描述 observations 保留证据引文并随新证据调整 | 证据与归纳分层；反思结果带来源、可失效 | 推断自动升级为事实；直接移植重型运行栈 |

以上“采用/不采用”是本项目决策，不是上游项目优劣排名，也不意味着上游完全缺失相关防护。

### 直接来源

1. Mem0：[抽取 prompt](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py)（`ADDITIVE_EXTRACTION_PROMPT`）、[实际调用](https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py)（`generate_additive_extraction_prompt`）。同文件含历史 prompt，不能把其中任意字符串都当当前执行路径。
2. LangMem：[概念](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)、[README](https://github.com/langchain-ai/langmem)。
3. Graphiti：[extract_edges.py](https://github.com/getzep/graphiti/blob/main/graphiti_core/prompts/extract_edges.py)（`valid_at` / `invalid_at` / `episode_indices`）。
4. Letta：[迁移说明](https://github.com/letta-ai/letta)、[当前 Letta Code](https://github.com/letta-ai/letta-code)。
5. claude-mem：[实现地图](https://github.com/thedotmack/claude-mem#how-it-works)、[渐进披露](https://docs.claude-mem.ai/progressive-disclosure)。
6. Hindsight：[README](https://github.com/vectorize-io/hindsight)、[observations](https://hindsight.vectorize.io/developer/observations)。
7. 评测：[LongMemEval 官方仓库](https://github.com/xiaowu0162/LongMemEval)。含抽取、跨会话、知识更新、时间推理、拒答；注明 cleaned 数据版本，不混用不同数据集结果。

## 结论：抽取不是“把聊天缩短”

上下文抽取需要保存：谁说的、关于谁、是建议还是决定、何时适用、依据是什么、是否已被纠正。一个流畅摘要可能全部遗漏这些信息。最终采用“证据片段→原子候选→校验与人工接纳→长期记忆→任务装配”，摘要只作为可弃派生层。

原文存在仅能证明“出现过这句话”，不能证明命题真实。JSON schema、第二模型复核和高 confidence 都不能代替语义验证。未接纳候选默认不进入 facts 分区；跨库、否定反转、把建议当决定等错误必须独立拦截。

本机任务简报混合历史 nextSteps、最新 handoff 已到 P0b 的现象，应脱敏重建为回归夹具：P0b 已完成，P1 未开始，不能再次建议继续已完成的 v1.0 工作。不得公开真实对话、绝对路径或会话标识。

## 可行性与未决实验

- 可复用现有 JSONL、MCP、LLM port、session ledger、混合检索，不需要替换存储。证据定位、候选队列、评测和装配是新增主体。
- 主要难点是中文隐式纠正、跨段指代、时间范围和漏抽，而非接通模型。先支持一个已有 transcript 来源，避免把时间耗在适配上。
- reranker、query rewrite、反思、多跳图检索均由消融实验决定；不预先承诺收益。
- 不能证明开放环境“零错误”。交付承诺限定为确定性约束成立、冻结评测集达到门槛、无严重错误、线上有拒绝/纠错/回滚路径。
- 人工接纳导致覆盖率下降和额外操作，是本期有意接受的取舍；必须报告拒绝率、人工负担与漏抽，不能靠全拒绝刷高精度。

执行顺序与量化门槛见 [当前未来计划](../plans/future-architecture.md)。本报告不改变 v1.4 的运行契约。

2026-11-18 对抗复核补充：来源引用不能证明事实为真；原子抽取还需分开系统版本时间与业务时间、接纳与 trust 提升，并覆盖崩溃重放、来源撤销及评测泄漏。具体修订与反例见 [审核报告](../reviews/future-architecture-2026-11-18/REVIEW.md)。本轮为单 agent 复核，未启用独立 GLM 审核或真实模型实验。
