# ICLR 2027 调研（回退：ICLR 2026 / NeurIPS 2026 / ICML 2026 记忆方向高分论文）

调研日期：2026-11-14。调研人：agent-24。

## 结论先行：ICLR 2027 截至 2026-11-14 未公开 oral / 高分 / award 名单

- ICLR 2027 会议时间为 2027-04-26~30（https://trustsafety.net/calendar/iclr-2027）。
- 截至 2026-11-14，OpenReview 上 ICLR 2027 处于评审进行中阶段，只有部分 submission 的初始评分放出，**官方 oral 列表、award 候选、最终接收名单均未公布**。
- ICLR 2027 改用 1–4 分制（1=clear reject，4=clear accept）。第三方快照（2026-11-06，40,458 篇有分、125,048 条评审）：均值 2.06、中位数 2.00、top 10% 线 2.67、仅 1.5% 评审给 4。来源：
  - https://shiqiangw.github.io/iclr-2027-scores/
  - https://buzzradr.com/ai/ai_topic_iiutj9
  - https://news.ycombinator.com/item/50397862（HN 讨论）
- 因无官方 oral/满分名单，本文不列举任何「ICLR 2027 满分论文」（不编造）。以下回退调研 ICLR 2026 + NeurIPS 2026 / ICML 2026 的记忆方向高分/口头报告论文。

---

## 论文 1：MemAgent: Reshaping Long-Context LLM with Multi-Conv RL-based Memory Agent

- **venue**：ICLR 2026 **Oral**（arXiv 页 Comments 原文："Accepted to ICLR 2026 as an Oral presentation"）
- **作者/机构**：Hongli Yu, Tinghong Chen, Jiangtao Feng, Jiangjie Chen 等；项目页 memagent-sialab.github.io（SIA Lab；含 Mingxuan Wang、Hao Zhou 等，未逐人核实机构，标注为「未验证：逐作者机构」）
- **链接**：arXiv https://arxiv.org/abs/2507.02259 ｜ OpenReview https://openreview.net/forum?id=k5nIOvYGCL ｜ 项目页 https://memagent-sialab.github.io/
- **分数证据**：ICLR 2026 Oral（arXiv:2507.02259 v2 页 Comments 字段，2026-07-29 更新）。具体逐审评分未验证（OpenReview 评分页本次抓取被浏览器校验拦截）。
- **解决什么**：无限长文本的线性复杂度处理，且外推时不掉点。现有长度外推 / 高效注意力 / 记忆模块都难以同时满足「线性复杂度 + 外推无损」。
- **方法机制**（可落地）：
  1. Agent 式分段读取：把长文切成固定长度 segment，逐段读入，而不是整篇塞 context。
  2. **覆写式记忆（overwrite strategy）**：每读一段，模型基于「当前记忆 + 新段」重写/覆写固定大小的 memory 区，memory 大小恒定 → 总复杂度线性且不随文本长度膨胀。
  3. 端到端 RL 直接优化长文任务目标：扩展 DAPO 算法，采用 **independent-context multi-conversation 生成**——同一条 rollout 内多个对话共享策略但各自独立 context，使梯度估计适合「分段 + 记忆覆写」的工作流。
  4. 结果：训练只看 32K 文本、模型 context 仅 8K，外推到 3.5M token QA 任务性能损失 <5%；512K RULER 达 95%+。
- **实验设置与数字**：32K 训练 → 3.5M QA（<5% loss）、RULER 512K 95%+（均出自摘要，见 arXiv 链接）。
- **对本架构（append-only 真相层 + 派生索引 + Agent 裁决）的可借鉴点**：
  - 「固定预算的记忆区 + 每段覆写」是 context compaction 的一种极端形式：可借鉴为派生索引之外的一条**恒定大小工作记忆**通道（rolling summary），保证单次推理 context 有上界。
  - independent-context multi-conversation 的 RL 训练法可用于训练「压缩/覆写记忆」的策略本身，而不是手写压缩 prompt。
  - 「训练在短、外推在长」的设置说明：记忆管理策略学到的能力可跨长度泛化，值得在裁决策略训练中复用。
- **不适用点**：MemAgent 的记忆是**有损覆写**（destructive overwrite），与 append-only 真相层哲学相反——它是「唯一记忆层 = 覆写区」，没有可回溯的原始记录；适合 QA 型长文，不适合需要事后审计/回滚/去重裁决的 agent 记忆系统。且需要 RL 训练，不是即插即用。

---

## 论文 2：TriMem — Rethinking How to Remember: Beyond Atomic Facts in Lifelong LLM Agent Memory

- **venue**：NeurIPS 2026（GitHub 仓库标题自标 "[NeurIPS 2026]"；官方接收名单未逐一核对，标注为「未验证：官方列表」）
- **作者/机构**：Jingwei Sun, Jianing Zhu, Jiangchao Yao, Tongliang Liu, Bo Han（仓库 citation；传统上该组合为香港城市大学/悉尼大学系，未验证逐人机构）
- **链接**：arXiv https://arxiv.org/abs/2605.19952 ｜ OpenReview https://openreview.net/forum?id=h9Je8c91Qi ｜ 代码 https://github.com/tmlr-group/TriMem
- **分数证据**：GitHub 仓库 bibtex `booktitle={NeurIPS 2026}`；OpenReview 页面本次被浏览器校验拦截，逐审分数未验证。
- **解决什么**：主流「原子事实抽取」范式的两大缺陷：① 压缩成 atomic facts 丢失原始对话细节、且孤立事实无法支撑深层推理；② 静态抽取 prompt 无法在不同对话风格下保持一致的抽取粒度。
- **方法机制**（可落地）：
  1. **三粒度并存记忆**：不止存抽取事实，还保留 ① 原始对话标识/原文指针（raw dialogue identifier，防细节丢失）② 实体档案（entity profile，把散落事实聚合到实体上，防浅层推理）③ 抽取事实层。
  2. **TextGrad 式系统 prompt 迭代优化**：用文本梯度反馈持续优化记忆系统的 extraction/system prompt，解决静态 prompt 粒度漂移。
  3. 检索阶段在多粒度上做相似度匹配后注入推理。
- **实验设置与数字**：论文报告在多 benchmark 上显著提升、兼容不同模型结构与规模（Section 4，详见 arXiv HTML https://arxiv.org/html/2605.19952v2 ；具体数字本次未摘录，未验证）。
- **可借鉴点**（与目标架构高度同构，借鉴价值最大）：
  - 「原始对话 + 实体档案 + 抽取事实」三粒度 ≈ 本架构「append-only 真相层（原文）+ 派生索引（实体档案/事实）」的分层记忆，**直接验证了 append-only 原文层不可省**：纯事实层会丢细节、伤推理。
  - entity profile 是一种很实用的派生索引形态：按实体聚合而非按时间/会话聚合，供裁决时做实体级对照。
  - prompt 迭代优化对应「Agent 裁决」层：抽取/裁决规则不应静态手写，应有反馈回路持续调优。
- **不适用点**：TriMem 面向对话记忆（dialogue history），非工具调用型 agent 状态；无去重/冲突裁决机制（不同轮次的矛盾事实如何 supersede 未处理）；TextGrad 优化需要额外 LLM 调用成本。

---

## 论文 3（补充，benchmark）：MemoryArena — Benchmarking Agent Memory in Interdependent Multi-Session Agentic Tasks

- **venue**：ICML 2026（mem0 博客列为 ICML 2026 论文；UCSD 评审存档 https://cseweb.ucsd.edu/~jmcauley/reviews/icml26b.pdf 可见 OpenReview 评审原文；官方接收列表未核对，未验证）
- **作者/机构**：Zexi He 等 14 人（arXiv:2602.16313）；含 UCSD Julian McAuley 组（评审存档域名佐证）
- **链接**：arXiv https://arxiv.org/abs/2602.16313
- **它解决什么**：现有记忆评测把「记住」与「用记忆行动」割裂——recall 类 benchmark 不测决策，单 session 任务又不需要长期记忆。MemoryArena 用**跨 session 因果依赖的顺序子任务**评测：后续任务依赖早前 session 的决策/信息，甚至存在「遗忘反而有利」的场景。
- **关键发现**：在 LoCoMo 等对话记忆 benchmark 上接近饱和的 agent（长上下文、RAG、外挂记忆），在 MemoryArena 上任务完成率显著下降——旧 benchmark 分数不能预测真实多 session agent 表现（arXiv 摘要 + mem0 博客 https://mem0.ai/blog/5-breakthrough-papers-shaping-ai-agent-memory-at-icml-2026）。
- **可借鉴点**：为「append-only 真相层 + Agent 裁决」提供了评测方法论——不能只测 recall，要测**跨 session 状态依赖下的端到端任务完成**与「何时该遗忘/降权」；适合作为本架构的验收 benchmark 候选。
- **不适用点**：它是 benchmark 不是方法；其「有益遗忘」场景与 append-only 哲学存在张力（本架构的答案是：真相层永不清除、遗忘只发生在派生索引/工作记忆层——这恰好是两篇方法论文支持的分界）。

---

## 来源清单（可核验）

| 用途 | URL |
| --- | --- |
| ICLR 2027 评分快照（未放榜佐证） | https://shiqiangw.github.io/iclr-2027-scores/ |
| ICLR 2027 1–4 分制分析 | https://buzzradr.com/ai/ai_topic_iiutj9 |
| ICLR 2027 会议时间 | https://trustsafety.net/calendar/iclr-2027 |
| MemAgent arXiv（Oral 证据） | https://arxiv.org/abs/2507.02259 |
| MemAgent OpenReview | https://openreview.net/forum?id=k5nIOvYGCL |
| TriMem arXiv | https://arxiv.org/abs/2605.19952 |
| TriMem 代码 | https://github.com/tmlr-group/TriMem |
| MemoryArena arXiv | https://arxiv.org/abs/2602.16313 |
| MemoryArena 评审存档 | https://cseweb.ucsd.edu/~jmcauley/reviews/icml26b.pdf |

未验证项已在各条目内标注（逐作者机构、OpenReview 逐审分数、ICML/NeurIPS 官方接收列表）。
