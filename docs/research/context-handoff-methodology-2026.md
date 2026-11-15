# 跨会话上下文交接：方法论与评测调研（2026）

> 研究方向：**方法论与评测**。回答两个问题——(1) 业界对「长会话压缩存放、跨会话接力」有哪些经过实证的方法论；(2) 「上下文没丢」这件事怎么**度量**，包括现成基准的哪些子任务可借用、以及我们能自建什么。
> 写作纪律：只写实际打开并读过的来源；每条结论标注出处；区分「官方说的」与「源码/issue 实证的」。

## 0. 我们的现状（锚点）

以下背景均实证自仓库源码（本调研中用 grep 定位并读过）：

- 任务库 = scope `session:<id>`；`close` 只把 `decision`/`gotcha` 晋升主库（tags 加 `from-session:<id>`），其余 tombstone，并写交接文档 `docs/handoffs/<id>.md`。见 `sedimem/versions/v1.2/src/session/lifecycle.js:2-3`、`src/mcp/session-tools.js:370`、`src/cli/session.js:258`。
- **完全手动**：不自动建库、不自动压缩、不自动 close；`session.hintTokens`（默认 30000）**只用于提示**，无动作消费者——见 `sedimem/docs/02-data-model-and-contract.md:875`、`versions/v0.6/docs/DELTA.md:27`。
- 已知数据丢失路径（自家 review 实证）：漏 checkpoint（宿主 compaction 已压掉中间态）、忘 close（晋升不发生、handoff 不生成，decision/gotcha 随 TTL 湮灭）——见 `sedimem/docs/research/v06-vs-alternatives-2026.md:55`。

用户的原始诉求（ paraphrase）：跨会话任务开发，各会话上下文不丢；30k 上下文时压缩落盘存放；避免关会话丢上下文、也避免宿主一次性压缩过多消耗 token。

---

## 1. Anthropic：Effective Context Engineering for AI Agents（官方文档）

来源：https://www.anthropic.com/research/effective-context-engineering-for-ai-agents （2025 年发布，本次实际全文打开阅读；同文有 `/engineering/` 别名路径）。

文章把上下文工程定义为「在推理过程中策划与维护最优 token 集合的策略集」，并给出长程任务（token 数超过上下文窗口）的三种直接针对 context pollution 的技术。**原文措辞与适用条件**如下。

### 1.1 Compaction（压缩）

原文（段落大意与关键句，亲读）：

> "Compaction is the practice of taking a conversation nearing the context window limit, summarizing its contents, and reinitiating a new context window with the summary."

- Claude Code 的实现：把消息历史交给模型总结，**保留架构决策、未解决的 bug、实现细节**，丢弃冗余的工具输出/消息；压缩后带着「最近访问的 5 个文件」继续。
- **核心警告**："the art of compaction lies in the selection of what to keep versus what to discard, as overly aggressive compaction can result in the loss of subtle but critical context whose importance only becomes apparent later"（过度压缩会丢掉那些重要性只在之后才显现的上下文）。
- 调参方法论（官方给的顺序）：**先最大化 recall（压缩 prompt 抓全每条相关信息），再迭代提 precision（去掉冗余）**。最容易去掉的低垂果实是工具结果——"once a tool has been called deep in the message history, why would the agent need to see the raw result again?"。tool result clearing 已作为 Claude Developer Platform 的官方特性上线。
- **适用条件**：需要大量来回对话的任务（"maintains conversational flow for tasks requiring extensive back-and-forth"）。

### 1.2 Structured note-taking / agentic memory（结构化笔记）

原文关键句：

> "a technique where the agent regularly writes notes persisted to memory outside of the context window. These notes get pulled back into the context window at later times."

- 载体是文件：Claude Code 的 to-do list、自定义 agent 的 NOTES.md。官方给的最生动例证是 Claude playing Pokémon：agent 在数千步里维护精确计数（"for the last 1,234 steps I've been training…"），**context reset 后读自己的笔记继续多小时训练**——跨压缩保持连贯。
- 与 Sonnet 4.5 同期发布了 file-based 的 memory tool（公开 beta），官方定位："build up knowledge bases over time, maintain project state across sessions, and reference previous work without keeping everything in context"。
- **适用条件**："iterative development with clear milestones"（有清晰里程碑的迭代开发）。

### 1.3 Sub-agent architectures（子代理）

原文关键句：

> "specialized sub-agents can handle focused tasks with clean context windows… Each subagent might explore extensively, using tens of thousands of tokens or more, but returns only a condensed, distilled summary of its work (often 1,000-2,000 tokens)."

- 机制：清晰的关注点分离——探索细节隔离在子代理窗口里，主代理只做综合。官方在 multi-agent research system 文章（https://www.anthropic.com/engineering/multi-agent-research-system ）中报告该模式在复杂研究任务上显著优于单代理（官方说法，未附数字于本文）。
- **适用条件**："complex research and analysis where parallel exploration pays dividends"。

### 1.4 支撑前提：为什么必须压缩/外存

- 文中引用 Chroma 的 context rot 研究：token 越多，模型从上下文准确回忆的能力越降；"this characteristic emerges across all models"，且是渐变而非悬崖。
- 机制解释：attention budget——n² pairwise 关系被摊薄 + 训练分布里短序列占主导（官方解释）。
- 底层原则（多次强调）："find the smallest set of high-signal tokens that maximize the likelihood of your desired outcome"；"context must be treated as a finite resource with diminishing marginal returns"。
- 三者选择是按任务特征匹配的（官方原话概括见上），不是三选一的架构决定，可以组合。

---

## 2. Manus：Context Engineering for AI Agents（官方博客，一手）

来源：https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus （英文）及简中版 `manus.im/zh-cn/...`（2025-07-18，作者 Yichao 'Peak' Ji；本次两版均实际打开）。注：网页抓取工具截断，**第 1 节（KV-cache）原文读到全节；第 2-6 节要点经同文多份公开镜像对照整理，标注为「部分一手」**。

背景（原文亲读）：Manus 押注上下文工程而非自训模型，理由是迭代速度（小时级 vs 周级）和与底层模型正交；框架重建过 4 次，自称过程为"Stochastic Graduate Descent"。

### 2.1 KV-cache 命中率 = 生产期 agent 最重要的单一指标（原文亲读）

原文关键句：

> "the KV-cache hit rate is the single most important metric for a production-stage AI agent. It directly affects both latency and cost."

- 论据（原文）：agent 循环里上下文每步增长、输出（结构化函数调用）很短，Manus 实测**平均输入:输出 token 比约 100:1**；缓存与否差 **10 倍成本**（Claude Sonnet：cached $0.30/MTok vs uncached $3/MTok）。
- 具体实践（原文第 1 节亲读）：
  1. **保持提示前缀稳定**——"即使是单个标记的差异也会使该标记之后的缓存失效"；典型错误是**在系统提示开头放精确到秒的时间戳**（自回归特性）。
  2. 上下文应**只追加（append-only）+ 确定性序列化**（要点经镜像对照，部分一手）。
- **对我们直接相关**：本机这套 harness（billion-context）的 acp_cache 工具正是按此口径统计——把 miss 拆成 new content / compression re-pay / upstream-ttl-or-client-rewrite，per-fold 算 breakeven turns。**每次压缩重写都会制造一次缓存全量 re-pay**——这正是用户担心的「宿主突然压缩过多上下文导致消耗更多 token」的量化形式。

### 2.2 其余原则（要点，部分一手，经镜像对照）

1. **Mask, don't remove**：动态删工具会破坏 KV-cache，应保留工具定义、用 logit masking 约束行为空间。
2. **文件系统当外部记忆**："Context window = RAM（易失），file system = 磁盘（持久）"；markdown 即磁盘上的工作记忆。
3. **todo.md 复述（recitation）**：把目标反复「念」到上下文尾部——不是为了告诉模型新信息，而是**把目标顶到 attention 的近端**，对抗 lost-in-the-middle（Manus 原文明确引 lost-in-the-middle 现象作为动机；此句为镜像对照，该论文本身本次已亲读，见 §3.1）。
4. **保留错误（keep the wrong turns）**：把失败尝试留在上下文里，模型能从「试错痕迹」学到环境语义并避开同路——与「清掉一切冗余」直觉相反。
5. **Few-shot 但避免模式坍塌**：少样本要多样、canonical，避免模型把「示例的模式」当成「任务的规律」。

---

## 3. 长上下文退化的证据（论文亲读）

### 3.1 Lost in the Middle（TACL 2023，arXiv:2307.03172）

来源：https://arxiv.org/abs/2307.03172 （摘要页本次亲读）。

- 结论（摘要原文）："performance is often highest when relevant information occurs at the beginning or end of the input context, and significantly degrades when models must access relevant information in the middle of long contexts, even for explicitly long-context models."
- 任务：multi-document QA 与 key-value retrieval；性能随**相关信息的位置**显著变化——即模型不能稳健利用长输入中的信息。
- **对我们意味着**：压缩产出的摘要若塞满关键决策，新会话里它几乎必然「在中间」；这就是为什么 Manus 的 todo.md 要**复述到尾部**、Claude Code 压缩后要**重挂最近 5 个文件**——都是把关键信息移到上下文头尾的机制。我们的 brief/checkpoint 注入也应遵循「头尾放关键决策与 next steps，中间放背景」。

### 3.2 Context Rot（Chroma research，2025）

来源：https://research.trychroma.com/context-rot ——**本次尝试打开被重定向到登录页，未读到正文，标注「未验证」**。二手引用来自 Anthropic 文章（§1.4）：token 数增加时准确回忆能力下降、跨模型普遍存在、渐变而非悬崖。引用前需自行读原文（其 FAQ 常被引的数字如"20 个 Haystack 项目"未核实）。

---

## 4. 怎么度量「跨会话接力后上下文没丢」

### 4.1 LongMemEval（ICLR 2025，arXiv:2410.10813）— 最贴近我们场景

来源：论文 PDF/幻灯（https://iclr.cc/media/iclr-2025/Slides/28290_OvN8vCf.pdf ）与代码库 https://github.com/xiaowu0162/LongMemEval （本节要点经论文笔记与幻灯交叉核对；核心结构为多个独立读过的来源一致，标注为「官方定义，经二手整理」）。

- 构成：**500 个人工标注的 QA**，注入可自由伸缩的多 session 用户–助手历史；官方定义 **5 类核心能力**，与我们诉求的映射：
  | 能力 | 全称 | 对应我们的场景 |
  |---|---|---|
  | IE | information extraction | 新会话从简报/主库里答出上一会话记的决策细节 |
  | MR | multi-session reasoning | 跨多次会话聚合（「这几次会话里一共卡在哪几件事」） |
  | **KU** | **knowledge updates** | 第二个会话推翻第一个会话的决定后，新会话必须答「最新」版本（对应我们 supersede 语义） |
  | **TR** | **temporal reasoning** | 对时间戳元数据推理（「上一会话是什么时候 close 的」） |
  | ABS | abstention | 别编：记忆里没有就说没有（对应我们不幻觉、检索不到要明说） |
- 官方结论（幻灯亲读）：现有 chat assistant 在这 5 类上「远未达生产标准」；并给出两种可伸缩变体 ICL-M / ICAL-M（历史注入 vs 检索+时间感知重排+答案整合，要点经笔记整理）。
- **最值得借的子任务：KU + TR + MR**——「跨会话接力没丢」的语义就是「新会话答得出旧会话的最新决定，且答得出旧决定被推翻过」。

### 4.2 LoCoMo（Maharana et al., 2024，arXiv:2402.17753）

来源：本节经二手来源核对（Zenodo 2026 论文 Memory That Doesn't Expire 对其的描述：https://zenodo.org/records/21964738 ，该文亲读其 §2.2；LoCoMo 原论文未直接打开，**标注「未验证原文」**）。

- 长多会话对话（数百轮、跨多 session），QA 分 **single-hop / multi-hop / temporal / open-domain / adversarial** 五类；原工作显示**长上下文模型与 RAG 都落后人类，尤其 temporal reasoning**。
- 对我们的意义：**adversarial 类**（问一个记忆里不存在的问题，考不幻觉）与 **temporal 类**可直接借用；其「对话」形态与我们的「开发任务」形态有差异，当作格式参考而非照搬。

### 4.3 MemBench（ACL 2025，arXiv:2506.21605）

来源：arXiv id 与结论经论文笔记整理（笔记亲读：xht254 笔记引用 + lhl/agentic-memory 分析文件），原论文未直接打开，**标注「未验证原文」**。

- 卖点是评估维度正交：**参与/观察**两种场景 × **事实/反思**两种记忆层 × **准确性/召回/容量/效率**四种指标。
- 有趣的实证结果（二手）：**简单 RetrievalMemory 在 100K token 大记忆下最佳（0.833），MemGPT/GenerativeAgent 等复杂机制未显优势**——提醒我们别为「好看」上复杂机制，评测必须带这个对照。
- 对我们的意义：其「容量/效率」维度正是我们「30k 就压缩以省 token」主张需要的度量轴。

### 4.4 自建：注入式断言（injectable assertions）— 最可机械检验

以上基准都测「聊天助手记忆」；我们的主张更窄也更硬：**close 之后，新会话只看晋升产物（主库记录 + 交接文档），能否答出上一会话的关键决策/卡点/文件**。可完全自建，无需外部基准：

1. **构造受控会话**：脚本化生成一个「已知答案」的会话（在 session 库里写 N 条 decision/gotcha/checkpoint，含 1 个已知文件路径、1 个已知卡点、1 个后续被 supersede 的旧决定）。
2. **只喂晋升产物**给一个干净的新 agent（不给原会话历史），提问：方案选了什么？卡在哪？改哪个文件？旧决定后来被改成什么？
3. **判定**：答案与预埋 ground truth 的字符串/路径完全匹配（决策、文件路径可精确比对）或 LLM-judge（答案语义、abstention 正确性参照 LongMemEval ABS）。
4. **对照组**：a) 只给 brief 不给 handoff；b) 给全量原始 transcript（上限参照）；c)什么都不给。四个组的分数差就是我们价值的量化：**handoff 组必须显著高于 brief-only 组，且接近 full-transcript 组**。
5. **知识更新用例**：两个会话先后写入冲突决定，close 两次后问「当前决定是什么」——验证 supersede + close 晋升后主库只暴露最新真相（这条可直接写成单测，现有 `i38-session-lifecycle.test.js`、`i50-session-handoff.test.js` 已测晋升与交接结构，**尚未测答案质量**）。

### 4.5 token 经济侧的度量（用户诉求的另一半）

「避免宿主突然压缩过多消耗更多 token」= KV-cache 命中率问题（Manus §2.1）。我们可机械度量：
- 每个会话 fold 的 miss 拆解（新增内容 / 压缩重付 / 上游 TTL 或客户端改写）；
- 压缩的 breakeven turns：一次压缩花费的 re-pay token ÷ 每轮节省的注入 token = 需要多少轮才回本；若会话实际只跑了 1-2 轮就 close，压缩是净亏的。

---

## 5. 值得抄 / 不值得抄 / 对我们意味着什么

### 值得抄

1. **「先最大化 recall 再提 precision」的压缩调参顺序**（Anthropic §1.1）：我们的 close 晋升白名单应按这个顺序迭代——先用评测证明「该晋升的都晋升了」（recall），再砍（precision）。现有白名单只有 decision/gotcha，正是 recall 优先阶段的产物；自家研究（`sedimem/docs/research/host-compaction-2026.md:159`）已指出 `pendingJobs/nextSteps` 才是跨会话开发最关键却没晋升的——与本结论一致。
2. **「保留未解决的 bug / 架构决策」作为压缩必留清单**（Anthropic §1.1 Claude Code 实例）：落到我们就是 close 时把 checkpoint 的 `errorsAndFixes / pendingJobs / nextSteps` 三段**必进**交接文档头部（部分已做，见 §4.4 第 5 条的缺口）。
3. **KV-cache 口径的成本核算**（Manus §2.1）：把「压缩省了上下文」和「压缩重付了多少缓存 miss」分开记账，用 breakeven turns 判断该不该在 30k 就压。这给 `hintTokens=30000` 一个真实语义的机会：不是「到了就压」，而是「预算触发 checkpoint 落盘」，让 close 时有完整底稿可晋升。
4. **外部化到文件 + 轻量标识符**（Anthropic "just in time" 一节）：我们的 handoff 文档已是对的方向；可再加「指针字段」（git SHA、分支、恢复命令），让新会话能按指针精确定位而不是纯语义搜索——自家 `session-llm-checkpoint-2026.md:63` 已提出此设计。
5. **复述（recitation）到上下文尾部**（Manus）：brief/交接文档在新会话注入时，把「当前决定 + next steps」放最前/最后，背景放中间——直接对冲 lost-in-the-middle（§3.1）。
6. **abstention 纳入评测**（LongMemEval ABS）：检索不到就明说，答错比不答更糟。

### 不值得抄

1. **复杂记忆机制先别上**：MemBench 实证简单检索在容量维度不输 MemGPT 类（§4.3）；sedimem 的 BM25 + append-only 本来就是简单侧，别为宣传点堆机制。
2. **sub-agent 架构与我们的场景关系弱**：Anthropic 自己的适用条件是「并行探索的研究/分析」；我们的痛点是**单线开发任务的接力**，compaction + note-taking 两个就够，别为三件套凑数。
3. **照搬聊天记忆基准跑分**：LongMemEval/LoCoMo 的对话形态（跨月闲聊、用户偏好）与我们的「开发任务接力」不同源；跑它们可用于宣传对齐，但**不能作为我们「上下文不丢」的证据**（见 §6）。
4. **「保留一切错误」无差别照抄有风险**：Manus 保留错误是在其 agent 循环内；我们的 session 库 close 时 tombstone 非 decision/gotcha 是刻意的（防止临时垃圾污染主库）。折中：错误与坑以 gotcha 形态晋升，原始错误 trace 留交接文档即可，不进主库。

### 对我们意味着什么（一句话版）

我们的「任务库 = 压缩存放 + 白名单晋升」方向与 Anthropic/Manus 的收敛结论一致（压缩 + 结构化笔记是长程任务正解）；缺的不是机制而是**证据**——没有任何机械检验能证明「接力后上下文没丢」，且 hintTokens 死配置说明「何时压缩落盘」这一环还没有消费者。

---

## 6. 如果我们宣称「上下文不丢」，应该怎么证明（可机械检验的 5 条）

1. **断言注入回归**：受控会话（预埋 ground truth：决策、卡点、文件路径、被 supersede 的旧决定）→ close → 新会话只注入晋升产物 → 固定问题集回答 → 决策/文件路径精确匹配、其余 LLM-judge；**通过线：关键决策与文件路径 100% 匹配，KU 用例（答最新版）通过，abstention 用例不编造**。接入现有 eval 体系（`versions/v1.2/eval/cases/` 已有 i50 用例先例，扩展其断言到答案质量层）。
2. **对照组差值报告**：同一问题集跑四组（无注入 / 仅 brief / 仅 handoff+主库 / 全量 transcript），CI 里固化「handoff 组 ≥ full-transcript 组 − ε 且 > brief-only 组 + δ」两个阈值；δ/ε 由首轮基线定，之后只允许收紧。
3. **晋升召回审计**：对每个 close 产物机械检查六段交接文档非空且含 git 锚点 + `from-session:<id>` 标签存在 + 主库可搜到（现有 `i50-session-handoff.test.js` 已测结构与指针，补「checkpoint 三段 errorsAndFixes/pendingJobs/nextSteps 必现于文档」的断言）——这是「没丢」的结构性下界。
4. **压缩经济记账**：每会话记录注入 token 与 KV-cache miss 拆解，输出 breakeven turns 与实际轮数对比；宣称口径改为可验证的「在 N 轮以上的任务里，压缩 + 晋升使每会话注入 ≤ X token 且接力质量不劣于全量（见第 2 条）」，**不宣称绝对「不丢」**。
5. **知识更新不变式**：同任务两次 close 写入冲突决定后，机械断言主库检索只返回 supersede 后的最新版（旧版仍可显式查但默认隐藏）——一条单测即可钉死，对应 LongMemEval KU 能力。

> 未验证清单（诚实声明）：Chroma context rot 原文（登录墙）、LoCoMo 原论文、MemBench 原论文均未直接打开，相关结论标注了二手来源；Manus 博客第 2-6 节因抓取截断经多份镜像对照，未逐字核对原文。

## 来源汇总

| 来源 | 类型 | URL / 路径 | 验证方式 |
|---|---|---|---|
| Anthropic: Effective context engineering for AI agents | 官方文档 | https://www.anthropic.com/research/effective-context-engineering-for-ai-agents | 全文亲读 |
| Manus: Context Engineering for AI Agents（2025-07-18） | 官方博客 | https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus （及 zh-cn 版） | 亲读（第 2-6 节经镜像对照） |
| Lost in the Middle（TACL 2023） | 论文 | https://arxiv.org/abs/2307.03172 | 摘要页亲读 |
| Context Rot（Chroma） | 厂商实测 | https://research.trychroma.com/context-rot | **未验证**（登录墙），仅 Anthropic 二手引用 |
| LongMemEval（ICLR 2025） | 论文+代码 | https://arxiv.org/abs/2410.10813 、https://github.com/xiaowu0162/LongMemEval 、https://iclr.cc/media/iclr-2025/Slides/28290_OvN8vCf.pdf | 幻灯亲读 + 笔记交叉核对 |
| LoCoMo | 论文 | arXiv:2402.17753 | **未验证原文**，经 Zenodo 2026 论文 §2.2 二手 |
| MemBench（ACL 2025） | 论文 | arXiv:2506.21605 | **未验证原文**，经论文笔记二手 |
| sedimem 现状 | 源码 | `sedimem/versions/v1.2/src/session/lifecycle.js` 、`src/mcp/session-tools.js` 、`docs/02-data-model-and-contract.md:874-875` 、`docs/research/v06-vs-alternatives-2026.md:55` 等 | grep + 读文件 |
