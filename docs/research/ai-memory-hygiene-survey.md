# AI 记忆系统的自我迭代与记忆卫生（Memory Hygiene）

> 调研范围：2023–2026 的论文与公开工程实现，聚焦「冗余 / 重复 / 冲突 / 过时」四类熵增的治理机制。
> 核验标记：✅ 论文编号/标题已通过 arXiv abs 页、官方仓库或论文正文核验；⚠️ 数字或细节来自二手分析，未逐字核对原文。
> 写作原则：**不臆造论文编号**；无法确认的写「未确认」。

---

## 0. 结论先行

1. **记忆卫生不是"定期清理"，而是四条路径的分工**：写入门控（在线、便宜规则）→ 冲突裁决（近线、只对候选跑 LLM）→ 离线整合（sleep-time / 夜间批处理）→ 检索期过滤（valid_at / TTL / recency 参与排序而非删除）。
2. **冗余用三段式**：稳定 ID + 内容哈希（零成本短路）→ 归一化实体键（同 slot 比较）→ 语义相似度候选 + LLM 判定。只靠向量阈值做去重，误合并率不可控。
3. **冲突必须先做实体对齐再判定**，否则复杂度是 O(n²)。Zep/Graphiti 把矛盾检测约束在同一个 `(subject, object)` 实体对上，是这条最值得抄的工程技巧（arXiv:2501.13956）。
4. **过时的正解是"失效"而不是"删除"**：bi-temporal 记录 `valid_at/invalid_at`（现实时间）与 `created_at/expired_at`（系统时间），旧事实仍可 as-of 查询；删除走墓碑 + 延迟物理删除，保留审计与回滚能力。
5. **成本可控的关键是"LLM 只做裁决，不做扫描"**：在线写路径 0–1 次 LLM 调用，全量整合放离线并摊销（sleep-time compute 可把单查询成本摊低约 2.5×，arXiv:2504.13171）。
6. **评测要成对**：公开 benchmark（LoCoMo / LongMemEval / MemBench）测能力，注入式回归（重复注入 / 冲突注入 / 过时注入）测卫生机制本身。只跑 benchmark 无法发现"记忆库在悄悄腐烂"。

---

## 1. 记忆生命周期理论：MemGPT / Letta

**代表实现**：MemGPT（arXiv:2310.08560）→ Letta（https://github.com/letta-ai/letta，文档 https://docs.letta.com）。
**配套论文**：Sleep-time Compute（arXiv:2504.13171，代码 https://github.com/letta-ai/sleep-time-compute）。

### 1.1 机制

**（a）分层与分页（paging / page fault）**
主上下文（main context）= 系统指令 + 可编辑的 working context（即 core memory blocks）+ FIFO 消息队列；外部上下文 = recall storage（全部历史消息，可检索）+ archival storage（向量库/图）。上下文用量逼近上限（论文中约 70% 触发 memory pressure 警告）时，把最旧消息驱逐到 recall storage，并用递归摘要保留要点；agent 通过函数调用把外部内容"换页"回主上下文——这就是 OS 分页隐喻的 page fault。

**（b）core memory block 编辑**
block 是带 `id / label / value / limit（字符上限，文档示例常见 2000–5000）/ description` 的可编辑记忆段，建议 5–15 个（MemGPT 原始只有 persona、human 两块）。工具集两代：`core_memory_append` / `core_memory_replace`（旧），`memory_insert`（追加，最安全）/ `memory_replace`（精确替换）/ `memory_rethink`（整体重写）。多个 agent 可用 `block_ids` 共享同一 block（supervisor 改，worker 立即看到）。

```python
# Letta 风格：块接近上限时先压缩再写
def write_block(agent, label, new_text):
    blk = agent.blocks[label]
    if len(blk.value) + len(new_text) > blk.limit * 0.9:
        blk.value = llm(f"把以下内容压缩到 {blk.limit//2} 字符内，保留数字/否定/截止时间/责任主体：\n{blk.value}")
    blk.value = blk.value + "\n" + new_text      # memory_insert 语义
    agent.persist(blk, expect_version=blk.version)  # 乐观锁，避免 last-writer-wins
```

**（c）sleep-time compute / 后台整理**
主 agent 之外再跑一个后台 agent，在空闲时读 transcript 与代码库上下文，把 `learned_context` 写回共享块、合并或失效 archival 记录。它不在关键路径上，因此可以用更贵更慢的模型。Sleep-time compute 论文的量化结论：在 Stateful GSM-Symbolic / Stateful AIME 上，达到同等准确率所需 test-time compute 降低约 **5×**；继续扩大 sleep-time compute 还能再涨 13% / 18%；Multi-Query 场景下按查询摊销，单查询平均成本降 **2.5×**。收益与"用户查询的可预测性"强相关——查询越可预测，离线预计算越划算。

**（d）MemFS / dreaming（Letta Code）**
记忆改为 Git-backed Markdown 文件树：小体积 `system/` 常驻注入，其余路径只作为"检索路标"；后台 "dreaming" 进程做整合（https://docs.letta.com/concepts/memfs、https://docs.letta.com/configuration/memory）。好处是记忆成为可 diff、可 code review、可回滚的仓库。

### 1.2 优点

- 分页让上下文成本与"当前任务"而非"历史总量"挂钩；一切历史仍可被 page fault 取回。
- block 是显式 schema（有上限、有语义描述），比"往 prompt 里塞文本"可控得多。
- 后台整合天然异步：延迟不涨、可用更强模型、可做多轮自我批判。

### 1.3 代价与失败模式

| 失败模式 | 成因 | 缓解 |
|---|---|---|
| block bloat | append 无节制，块被灌满 | 写前 summarizer + 硬上限 + 写入配额 |
| silent drift | 后台 agent 静默改写核心记忆，人/主 agent 无感知 | 块版本化 + diff 展示 + 变更需二次确认 |
| poisoned consolidation | 被投毒的对话内容被后台整合"洗白"成事实 | 把 sleep-time agent 视为不可信写入者；动 persona / safety 块需二次评审；保留 provenance |
| 并发覆盖 | `memory_rethink` 整体重写 = last-writer-wins | 用 `memory_insert` + 版本号 CAS |
| 分页丢关键槽位 | 递归摘要丢数字、否定、截止时间 | 摘要 prompt 固定"不可丢失槽位"清单 + 规则校验 |

---

## 2. Mem0：ADD / UPDATE / DELETE / NOOP 操作式记忆更新

**论文**：arXiv:2504.19413 — *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory*（Chhikara, Khant, Aryan, Singh, Yadav；2025-04-28）✅
**实现**：https://github.com/mem0ai/mem0

### 2.1 机制

写路径分两阶段（每阶段一次 LLM 调用）：

1. **抽取（extraction）**：输入最近消息对 `(m_{t-1}, m_t)`，上下文 = 异步刷新的会话摘要 `S` + 最近窗口（论文配置 m=10 条消息），LLM 抽出一组候选事实 `Ω = {f_1..f_k}`。
2. **更新（update）**：对每个 `f_i`，用 embedding 召回 top-s 相似既有记忆（s=10），把「候选事实 + 相似旧记忆」交给 LLM，由它以 **tool call** 选择一个操作：`ADD / UPDATE / DELETE / NOOP`（NOOP 表示已有等价记忆，无需动作）。

```python
def add(messages, user_id):
    S = summary_cache[user_id]           # 异步刷新，不阻塞写
    ctx = S + messages[-10:]
    facts = llm_extract(ctx)             # LLM call #1
    for f in facts:
        sims = vector.search(f.embedding, top_k=10, filter={"user_id": user_id})
        op = llm_decide(f, sims)         # LLM call #2，tool call 返回 {op, target_id?, new_text?}
        if   op == "ADD":    vector.insert(f, user_id=user_id)
        elif op == "UPDATE": vector.update(op.target_id, op.new_text)
        elif op == "DELETE": vector.delete(op.target_id)     # 硬删除：审计能力为 0
        else:                pass                            # NOOP
```

**Mem0g（图变体）**：实体为节点、事实为带时间戳与 embedding 的关系三元组 `(v_s, r, v_d)`；对过时关系执行 **invalidate** 而非硬删（这一点与第 3 节的 bi-temporal 思路收敛）。

### 2.2 数据（论文报告，⚠️ 摘自论文正文/图表）

- LoCoMo LLM-as-judge 分数：Mem0 **66.9%**、Mem0g **68.4%**；OpenAI 内置 memory 基线 52.9%，Zep 66.0%。
- 效率：p95 总延迟 **1.44s / 2.59s**（Mem0 / Mem0g）vs full-context **17.12s**，p95 延迟降约 **91%**，token 成本降 **>90%**。

### 2.3 优点

- 把"记忆卫生"内嵌进写路径：写入即消解，读路径零额外开销，token 与延迟收益极大。
- 操作语义显式（四个动作可观测、可统计），便于做"候选接受率/删除率"监控。
- `NOOP` 是关键的"负向操作"——大多数系统缺这个，导致重复写入无法被显式拒绝。

### 2.4 代价与失败模式

- **DELETE 是硬删除**：无版本、无墓碑、无审计，误删不可恢复，也无法回答"我为什么忘了"。
- **单次 LLM 判断决定生死**：相似度召回不到 ⇒ 模型看不到旧记忆 ⇒ 必然 ADD 重复；召回错了 ⇒ 误 UPDATE 覆盖。
- **无时间语义**：UPDATE 是"覆盖"，不是"旧值失效"，无法做 as-of 查询与冲突回放。
- **每写一次 2 次 LLM 调用**：高频写入场景成本线性上升，必须批处理或降级。
- **写时投毒无威胁模型**：恶意内容一旦被抽取为事实，会被后续所有 UPDATE 保留。
- 论文评测为单会话/单用户视角，多租户隔离、跨会话冲突未覆盖（⚠️ 评测范围限制）。

---

## 3. Zep / Graphiti：bi-temporal 时间知识图

**论文**：arXiv:2501.13956 — *Zep: A Temporal Knowledge Graph Architecture for Agent Memory*（Rasmussen, Paliychuk, Beauvais, Ryan, Chalef；2025-01-20）✅
**实现**：https://github.com/getzep/graphiti

### 3.1 机制

图 `G = (N, E, φ)` 分三个子图：

- `G_e` episode 子图：原始输入（消息、文档、JSON），**append-only 永不修改**，充当 ground-truth 磁带；
- `G_s` 语义子图：实体节点 + 事实边（含 embedding）；
- `G_t` 社区子图：用 label propagation（不是 Leiden）做增量社区发现，便于流式局部更新；社区成员变动 >20% 才重生成社区摘要。

**双时间轴（bi-temporal）**：每条事实边带四个时间戳——`t'_created / t'_expired`（系统时间：何时写入/失效）与 `t_valid / t_invalid`（现实时间：事实何时为真/何时不再为真）。检测到矛盾时，**把旧边的 `t_invalid` 设为新边的 `t_valid`**，旧边保留可查——失效 ≠ 删除。

**写入流水线**（每个 episode ≥3 次 LLM 调用，异步执行，检索侧保持 sub-200ms）：

```python
def add_episode(ep):
    G_e.append(ep)                                  # 原始输入不可变
    for chunk in ep.chunks:
        ents = llm_extract_entities(chunk, prev_n=4)          # LLM #1（Reflexion 式二次反思补漏）
        ents = [resolve(e) for e in ents]                     # 混合消解：cosine(1024d)+BM25 各 top-10 → LLM 判 MATCHES/NEW
        facts = llm_extract_facts(chunk, ents)                 # LLM #2 → 边
        for f in facts:
            cands = edges_between(f.subject, f.object)        # 只比同一实体对，O(|E_uv|) 而非 O(|E|²)
            verdict = llm_classify(f, cands)                  # LLM #3：same_fact | update | contradiction | unrelated
            if verdict == "contradiction" or verdict == "update":
                for old in overlapping(cands, f.valid_at):
                    old.t_invalid = f.valid_at                # 失效，不删除
            G_s.add_edge(f)
    maybe_rebuild_communities(delta_ratio_threshold=0.2)
```

**检索**：`φ_cos + φ_bm25 + φ_bfs(n-hop)` → RRF(k=60) → MMR → episode-mentions → node-distance → cross-encoder 重排（ms-marco-MiniLM-L-6-v2，20 候选约 30ms）。查询用**预定义 Cypher 模板**，不让 LLM 现场生成 Cypher（降幻觉）。

### 3.2 数据（论文报告，⚠️ 部分为二手摘录）

- DMR：94.8% vs MemGPT 93.4%；
- LongMemEval：71.2%（gpt-4o）vs full-context 60.2%；63.8%（4o-mini）vs 55.4%；
- 延迟 2.58s vs 28.9s；上下文 1.6K vs 115K tokens（约 72×）。

### 3.3 优点

- 时间语义完整：能回答"当时是什么"（as-of）与"现在是什么"，天然支持审计与回放。
- 矛盾检测被实体对约束，工程上可行；社区摘要提供多粒度检索入口。
- episode 层不可变 ⇒ 任何派生结论都能溯源到原始输入。

### 3.4 代价与失败模式

- 每个 episode ≥3 次 LLM 调用 + 矛盾判定，写放大明显；必须异步。
- 图会持续膨胀（失效边仍占存储与索引），需要归档/冷存策略；论文未提供 TTL/遗忘机制。
- **每个 LLM 阶段的幻觉都会永久污染图**（实体错、关系错 → 后续所有矛盾判定都建立在错边上）。
- 论文自报的短板很值得注意：knowledge-update 类 −3.36%、single-session-assistant 类 −9.06% ——**有失效机制 ≠ 检索会正确使用时间元数据**；失效边若仍被召回并注入上下文，反而制造混乱。检索端必须显式过滤 `t_invalid is null or t_invalid > query_time`。

---

## 4. 结构化记忆与遗忘：A-MEM / MemInsight / MemoryBank / Generative Agents

### 4.1 A-MEM（Zettelkasten 式动态链接与记忆演化）

**论文**：arXiv:2502.12110 — *A-MEM: Agentic Memory for LLM Agents*（Xu 等，NeurIPS 2025）✅
**实现**：https://github.com/WujiangXu/A-mem（复现）、https://github.com/WujiangXu/A-mem-sys（官方实现）

**机制**：每条新记忆生成一张结构化 note（上下文描述 + 关键词 + tags + 向量）；然后在历史 note 中找语义相关的建立链接（类似 Zettelkasten 的双向链接）；**memory evolution**：新记忆写入时会触发对既有相关 note 的"上下文表示/属性"更新——不是覆盖原文，而是让旧记忆在新语境下被重新解释。

```python
def add_note(content):
    note = llm_annotate(content)          # {desc, keywords, tags, embedding}
    links = find_related(note)            # LLM 判断哪些历史 note 相关（非固定 top-k）
    store.add(note, links)
    for l in links:                        # 记忆演化：改写旧 note 的语境，不动正文
        l.context = llm_recontextualize(l, note)
        l.tags = union(l.tags, note.tags)
```

**优点**：接近人类重构式记忆；链接使多跳检索可行；演化让旧记忆不僵化。
**代价**：链接是 O(n²) 候选，规模化需要 ANN + 剪枝；演化会让"原文"与"当前解释"漂移，必须保留原始 note 版本；**没有删除/失效语义**——A-MEM 解决"组织"，不解决"过时"。
**延伸**：FlexA-Mem（arXiv:2610.33274 ✅，2026-10-23，Wujiang Xu 等，A-Mem 同一作者线；代码 https://github.com/WujiangXu/Flex-Amem）换了个思路——**每段历史只写一次到不可变存储，每次调用现场"渲染"一份记忆**：渲染结果 = 记录的时间线 + 用固定规则（**不调用 LLM**）填满剩余预算的细节（相关单元的原文/摘录，或与查询逐字匹配的片段）。这样同一份存储可同时服务"精确事实查询"与"多步任务轨迹"，且预算按调用分配而不是预先切死。报告：AppWorld 4k 预算下比第二名高 11.5%；在 147 个未参与调参的任务上比"A-Mem + 摘要"高 12.2%；LongMemEval / LoCoMo 上与"不写记忆的关键词检索器"持平（说明在紧预算下，LLM 加工过的记忆反而不如原始文本）。这条路线是"检索即渲染"，对成本控制与"记忆不腐化"都很有参考价值。

### 4.2 MemInsight（自主属性增强）

**论文**：arXiv:2503.21760 — *MemInsight: Autonomous Memory Augmentation for LLM Agents*（Salama 等，AWS；2025-03-27）✅

**机制**：不改写记忆内容，而是给历史交互**附加结构化属性**，再用属性引导检索。三个模块：

1. **属性挖掘**：自主选择"视角"与"粒度"——视角分 entity-centric（标注被提及实体的属性，如导演/年份）与 conversation-centric（标注用户意图/偏好/情绪/话题）；粒度分 turn-level 与 session-level。
2. **标注 + 属性优先级**：把 attribute–value 对挂到记忆条目上，并学习/排序"哪些属性对检索最有用"。
3. **属性引导检索**：用增强后的表示做 embedding 检索，并可用属性做过滤/重排。

**数据**：LoCoMo 检索 Recall@5 从 26.5（DPR RAG 基线）提升到 **60.5**（+34.0 点，⚠️ 论文 Table 2 报告值）；LLM-REDIAL 上推荐说服力最高 +14%。

**优点**：schema 由 LLM 自主发现，不必人工设计；属性即"可过滤维度"，让"时间/实体/情绪"这类查询变得廉价。
**代价**：属性抽取错误会持久化（错误标签污染检索）；可能把敏感/指令性内容抽成属性（写时策略必须过滤）；属性本身也会过时，需要与主记忆一起失效。

### 4.3 MemoryBank（Ebbinghaus 遗忘曲线）——以及一个必须记住的反例

**论文**：arXiv:2305.10250 — *MemoryBank: Enhancing Large Language Models with Long-Term Memory*（Zhong, Guo, Gao, Ye, Wang；2023-05-17）✅
**实现**：https://github.com/zhongwanjun/MemoryBank-SiliconFriend

**机制**：记忆单元 = 一轮对话 `{query, response, memory_strength, last_recall_date, memory_id}`；每次被检索到就 `strength += 1` 并刷新 `last_recall_date`；保留概率按 Ebbinghaus 曲线随时间衰减、随强度上升（设计意图：`R = exp(-t / (5·S))`）。另有每日摘要、整体历史 digest、用户人格画像三层派生记忆。

**优点**：这是"不询问 LLM 也能让记忆自然褪色"的少数成熟原语；`last_recall_date` + 强度计数器结构简单、可解释；仓库自带 15 个模拟用户 × 10 天历史 + 约 100 条中英双语探针问题，是现成的检索回归夹具。

**代价与失败模式（重要）**：第三方源码审计（https://github.com/neoneye/agent-memory-atlas）指出，`memory_bank/memory_retrieval/forget_memory.py:36` 写作 `math.exp(-t / 5*S)`，Python 解析为 `((-t)/5)*S` —— **强度越大衰减越快**：强度 1 的记忆一天存活率 82%，强度 10 的只有 13.5%。而 `update_memory_when_searched` 每次召回都 `+1`，于是"越常被回忆的记忆越快被删除"。更糟的是三点叠加：遗忘是**破坏性 pop**（无墓碑、无归档、原地重写唯一副本）、**在 load 路径里执行**（`init_memory_vector_store` 建索引时顺手删数据）、**未按用户隔离**（逐用户过滤的 `continue` 被注释掉）。这构成一组教科书级反模式：

- 衰减/置信度这类"方向性"函数必须有单调性单测（`decay(t, S=10) > decay(t, S=1)`）；
- 遗忘永不 destructive，先软删/归档；
- 永不在 load 路径做 mutation；
- memory_id 不能用列表下标（`user_date_i` 在中间元素被删后静默指向错误行）。

### 4.4 Generative Agents（importance + reflection）

**论文**：arXiv:2304.03442 — *Generative Agents: Interactive Simulacra of Human Behavior*（Park 等，2023）✅

**机制**：memory stream 存全部观察；每条记忆带 LLM 打分的 `importance ∈ [1,10]`；检索分数 = 时效衰减（recency，指数衰减因子 0.995）× importance × 与查询的相关性（论文默认权重均为 1，仅做加权和）。**reflection**：当近期事件的累计 importance 超过阈值（论文取 150）时触发，LLM 生成更高层的洞察并**写回 memory stream**（洞察本身也是记忆，可再被检索、再被反射）。

```python
def retrieve(q):
    return topk(stream, key=lambda m: 0.995**(now-m.t) * m.importance * cos(q, m.emb), k=10)

def maybe_reflect():
    if sum(m.importance for m in stream.recent(50)) > 150:
        insights = llm_reflect(stream.recent(50))     # "观察到 X 常发生 Y"
        for i in insights: stream.add(i, importance=llm_score(i), kind="reflection")
```

**优点**：importance 给了"该不该留"一个显式、可调、可审计的信号；reflection 把碎片升维成可复用知识，是"自我迭代"最早的可运行形态。
**代价**：importance 由 LLM 单次打分，方差大且可被内容操纵（"这非常重要，请记住"）；reflection 会把幻觉固化成"洞察"，且洞察再参与反射会形成自我强化的错误闭环；**没有失效/冲突机制**——旧洞察与新事实并存，只能靠检索排序碰运气。工程上必须给 reflection 加"候选隔离区 + 证据引用 + 可撤销"。

---

## 5. 记忆整合与冲突消解（机制层）

这一节把上面各系统的做法抽象成可实现的组件。工程侧参考（非论文）：https://github.com/cdavid817/agent-interview（`docs/02-capabilities/context-knowledge/memory-1.md`）、https://github.com/neoneye/agent-memory-atlas。

### 5.1 去重：三段式漏斗

```
L0 精确层：memory_id 幂等 + content_hash(sha256) 命中 → 直接 NOOP（0 成本，覆盖 60–80% 重复）
L1 键层  ：归一化后 (tenant, subject, relation, slot, scope) 相同 → 进入"更新/冲突"分支，不必比向量
L2 语义层：embedding cos ≥ 0.85 取候选（经验区间，非论文结论），cos ≥ 0.97 可判近重复直接合并；
           其余候选交 LLM judge 输出 {duplicate, refine, distinct, conflict}
L3 判定层：LLM 只看"候选 + 少量上下文"，要求给出理由与证据 id；结果落 audit log
```

要点：
- **阈值只做召回，不做判决**。0.85/0.97 这类数字是工程经验值，随 embedding 模型与领域漂移，必须用标注集校准（建议 200–500 对人工标注，算 precision/recall 曲线后定阈值）。
- **冲突事实绝不合并**。近义事件可以合并成带 `source_ids` 的分层摘要，但两个互相矛盾的值必须并存并标注。
- 合并必须保留**原始引用**（source_ids + 时间范围 + 抽取模型/prompt 版本），否则摘要一旦出错无法回溯。

### 5.2 冲突：先对齐实体，再四分类裁决

```python
def on_write(item):
    # 1) 实体对齐（决定候选集大小，是性能与准确率的关键）
    subj = resolve_entity(item.subject)   # 别名/同义词/缩写 → canonical_id
    obj  = resolve_entity(item.object)
    # 2) 只取同一 (subj, obj) 的既有事实，避免 O(n^2)
    cands = facts.where(subject=subj, object=obj, valid_to__isnull=True)
    # 3) 四分类
    kind = llm_judge(item, cands)   # duplicate | attribute_change | coexistence | contradiction
    if kind == "duplicate":        merge(item, cands[0]); return
    if kind == "attribute_change": supersede(cands, item)      # 旧版 valid_to = item.valid_from
    if kind == "coexistence":      item.scope = infer_scope(item); insert(item)  # 不覆盖，加维度
    if kind == "contradiction":
        winner = arbitrate([item] + cands)                     # 见下表
        mark_disputed(losers, winner)
```

| 冲突类型 | 判据 | 处理 |
|---|---|---|
| 同义重复 | 同实体对、同值、时间重叠 | 合并 + 提升 confidence + 追加证据 |
| 属性变化 | 同实体对、值不同、时间不重叠（新的更晚） | supersede：旧 `valid_to = 新 valid_from`，保留旧值可 as-of 查 |
| 并存事实 | 值不同但 scope 不同（不同项目/设备/租户/前提） | **不覆盖**，补 scope 维度并存 |
| 真矛盾 | 同实体对、同 scope、时间重叠、值互斥 | 仲裁：来源权重 > 时间新旧 > 用户显式纠正；落 `disputed` 标记并保留双方 |

**来源权重（工程惯例，非论文）**：用户显式纠正 > 用户陈述 > 工具/系统观测 > 权威文档 > 多次成功经验 > 模型推断。规则是：高权重来源可以覆盖低权重；低权重来源**不能**静默覆盖高权重，只能标记"待确认"。组织级规则不被个体偏好覆盖。

### 5.3 置信度与时序衰减

```python
confidence = base_by_source(source) * recency_factor(age, half_life[type])
           + 0.05 * corroboration_count          # 多个独立来源印证则上升
           - 0.10 * contradiction_count          # 被反驳则下降
# half_life 按类型配置：身份/偏好 长（月级），临时状态/情绪/位置 短（小时~天级）
```

关键区分：**衰减只影响排序与展示，不触发删除**。删除只由 TTL、容量配额、用户指令、合规要求触发，且必须留墓碑。

### 5.4 TTL 与容量

- 按记忆类型设 TTL（临时状态 1 天 / 事件 90 天 / 偏好 永久但可衰减 / 画像长期）；
- 按 tenant/user/类型设条数与字节配额 + 水位告警；
- 超配额时按"价值分"（importance × 访问频次 × 唯一性）淘汰到冷存，而不是随机删。

### 5.5 Promotion（短期 → 长期）

```python
# 候选区 → 稳定区 的晋级条件（满足任一 + 无未决冲突）
if occurrences >= 3 and distinct_sessions >= 2: promote()
if user_explicitly_confirmed:                  promote(confidence=0.9)
if replay_eval_passed and no_counterexample:   promote()
```

晋级记录必须包含：`confidence / evidence_ids / scope / model+prompt 版本 / expires_at / success_count / fail_count`。反例出现时执行降权 → 缩小 scope → 撤销，而不是"再写一条新记忆"。

---

## 6. RAG 知识库的同类问题：版本化、TTL、canonical 化

记忆系统与 RAG 是同一类问题的两个投影：

| 记忆系统 | RAG 知识库 |
|---|---|
| 重复记忆 | 重复 chunk（同一文档多次入库、模板化段落） |
| 过时事实 | 过期文档（新版已发布，旧 chunk 仍在索引） |
| 矛盾记忆 | 冲突事实（多文档给出不同数值/结论） |
| 墓碑删除 | 软删除 + 延迟物理删除 + 三端一致 |
| supersedes 链 | `doc_id + version_id` + `active_version` 切换 |

**工程做法**（参考：https://github.com/snailclimb/javaguide/blob/main/docs/ai/rag/rag-knowledge-update.md）：

1. **元数据是前提**：每个 chunk 至少带 `doc_id / chunk_id / content_hash / version_id / chunk_strategy / chunk_size / embedding_model(+version) / source_type / acl / is_deleted / updated_at`。
2. **content_hash 短路**：入库前算正文/ chunk 哈希，与库中记录比对，未变则**跳过 embedding**（省最大的一笔钱）。哈希算法：MD5 快但有碰撞风险；SHA-256 生产推荐；SimHash 用于"大致相同"的网页去重（不能定位具体变化点）；大规模近似去重可用 MinHash/LSH（工程常用，非本调研核验的论文结论）。
3. **近重复检测**：SimHash/MinHash 找候选 → 人工/LLM 判定 canonical 版本；保留 `canonical_chunk_id` 指向权威副本，其余副本只做重定向，不参与召回。
4. **更新用"新版本不可见 → 原子切换"**：写入 `status='building'` 的新 chunk → 三端（向量/元数据/全文）校验 → 把 `active_version` 或索引别名原子切到新版 → 旧版标记删除并延迟清理。**只写新向量不删旧向量是本领域第一大坑**（文档改 10 次就有 10 个可召回版本）。
5. **幂等与乱序**：唯一约束 `(doc_id, content_hash)` 或 `(doc_id, version_id)`；消费端用 `claim_token` + 条件更新抢占任务；事件带单调 `version`，旧事件直接丢弃（防止 v2 覆盖 v3）。
6. **删除三端一致**：软删 `is_deleted=true` → 读路径过滤 → 异步物理删除向量/倒排/缓存 → 对账（孤儿检测）。合规删除要清 rerank 缓存与 LLM 上下文缓存。
7. **ACL 变更必须触发重索引**，否则出现"幽灵数据"：文档从"全员可见"改为"仅高管"，但向量里的旧 ACL 仍让普通员工召回。
8. **冲突事实的 canonical 化**：同一实体归一 `canonical_id`，事实存成 `(entity, relation, value, valid_from, valid_to, source, confidence)` 的**事实表**，检索默认只取 `valid_to is null`（当前）或按 `as_of` 取历史；冲突不合并，冲突双方都标注 `disputed` 与来源。
9. **可观测**：`index_lag_seconds`、`stale_docs_count`（源系统比索引新）、`acl_mismatch_count`、`partial_index_count`、`dup_ratio`、`retrieval_hit_rate`（环比降 >5% 告警）。

**知识冲突的分类学**可参考 arXiv:2403.08319 — *Knowledge Conflicts for LLMs: A Survey* ✅（context-memory 冲突：参数知识 vs 检索上下文；inter-context 冲突：检索文档之间；intra-memory 冲突：模型自身知识内部）。记忆系统里的"新旧事实冲突"对应 context-memory / inter-context 两类，处置手段（来源加权、时间优先、显式澄清）与该综述归纳的策略一致。

---

## 7. 成本控制：什么时候值得让 LLM 整理

### 7.1 三档预算模型

| 档位 | 时机 | LLM 调用 | 做什么 |
|---|---|---|---|
| 在线（写路径，<100ms 预算） | 每次写入 | **0–1 次** | hash 短路、实体键比较、embedding 近重复（cos>0.97 直接合并）、显式用户纠正直接执行 |
| 近线（候选裁决，秒级） | 相似度 > 阈值 或 实体键命中 | 1 次/候选 | LLM judge 判 duplicate/conflict，产出 supersedes 或 disputed |
| 离线（整合，分钟~小时级） | 空闲/夜间/每 N 轮 | 批量 | 摘要分层、画像、跨会话合并、冲突复核、遗忘与配额执行、候选区晋级评审 |

**判据**：一次 LLM 调用的价值 ≈ 它避免的"错误记忆"造成的损失。能用确定性规则（hash、同 slot + 时间更新、用户显式纠正）解决的，一律不调 LLM。

### 7.2 量化参照

- Mem0：每次写入 2 次 LLM 调用，换来 p95 延迟 1.44s vs full-context 17.12s、token 降 >90%（arXiv:2504.19413）。
- Graphiti：每 episode ≥3 次 LLM 调用 + 矛盾判定，换来 LongMemEval +11 点、上下文 72× 压缩（arXiv:2501.13956）。
- Sleep-time compute：把整理移到离线，单查询成本摊薄约 2.5×，test-time compute 需求降约 5×（arXiv:2504.13171）——**前提是查询可预测**；查询越随机，离线预计算越浪费。
- MemBench 把"每次操作读/写耗时"（RT/WT）作为一等指标：RetrievalMemory RT/WT ≈ 0.041/0.058s，MemGPT RT ≈ 4.5s（⚠️ 二手摘录，arXiv:2506.21605）。

### 7.3 具体省钱手段

1. **增量而非全量**：只对"自上次整合以来变更的条目"跑 LLM；全量重算按周/月做 reconciliation。
2. **批处理 + 分片**：按 `(tenant, user, entity)` 分区，一个 prompt 处理一批候选（如 20 条），显著降低 per-item 成本。
3. **embedding 缓存**：内容哈希 → 向量缓存，跨版本复用。
4. **降采样**：只对高频访问/高 importance 的记忆做深度整合，长尾只跑规则。
5. **预算硬约束**：每日整理预算 `B = 活跃记忆 token × α`（α 取 5%–10%）或固定 per-user 配额；超限则排入队列/降低整理深度，绝不无限追加。
6. **预算自适应渲染**：FlexA-Mem 的思路——历史只写一次且不可变；每次调用按剩余预算用固定规则（无 LLM）拼出「时间线 + 细节」，同一份存储既能答精确事实也能跑多步任务（arXiv:2610.33274）。紧预算下它甚至追平「完全不加工」的关键词检索，说明过度加工本身就是一种腐化。

---

## 8. 评估：怎么测冗余率 / 冲突率 / 召回精度

### 8.1 公开 benchmark（测能力上限）

| Benchmark | 编号 | 规模/设置 | 覆盖能力 | 注意 |
|---|---|---|---|---|
| LoCoMo | arXiv:2402.17753 ✅（ACL 2024） | 多 session 长对话，最多 35 sessions / ~300 turns / ~9K tokens；`locomo10` 子集约 10 段对话、~500 题 | single-hop / multi-hop / temporal / commonsense / adversarial | LLM-as-judge 二值判分，换 judge 模型可漂移数个百分点；长上下文模型已部分饱和（>85% 区分度下降） |
| LongMemEval | arXiv:2410.10813 ✅（ICLR 2025） | 500 道人工策展题；S≈115K tokens、M≈1.5M tokens | information extraction / multi-session reasoning / temporal reasoning / knowledge updates / **abstention** | knowledge-update 与 abstention 是记忆卫生的直接考题；纯向量检索在这两类上早饱和，需 hybrid（dense+BM25，RRF k=60，约 70/30） |
| MemBench | arXiv:2506.21605 ✅（ACL 2025 Findings，Tan 等） | 两轴：participation vs observation × factual vs reflective（⚠️ 规模约 5.3 万样本为二手） | 多选题 accuracy、Recall@10、capacity（token 增长下的 accuracy cliff）、temporal efficiency（RT/WT） | 唯一把"延迟/成本"与"容量悬崖"作为一等指标的常用基准 |

### 8.2 卫生指标（测"库本身有多脏"）

这些指标没有现成 benchmark，需要自建抽样标注：

- **冗余率** `dup_ratio = 1 - unique_facts / stored_items`（用 hash 聚类先粗估，再人工抽 200 条核对）；
- **冲突率** `conflict_rate = disputed_pairs / pairs_with_same_entity_relation`；
- **过期命中率** `stale_hit_rate = 命中已被 supersede 的旧事实次数 / 总命中`（读路径必须能识别旧版本才能统计）；
- **有效命中率**：命中且被采纳且未导致用户纠正的比例（需要线上反馈回路）；
- **压缩率与事实保留率**：摘要后 token 降幅 vs 关键槽位（数字/否定/截止时间/责任主体）保留率；
- **删除完整性/延迟**：墓碑写入 → 三端清除的时延与孤儿率；
- **单位有效记忆成本**：每千条有效记忆的写入+整合+检索总成本。

### 8.3 注入式回归（测机制，而不是测模型）

这是本次调研认为**最该补的一层**，建议直接进 CI：

| 测试 | 注入 | 期望 |
|---|---|---|
| 重复注入 | 同一事实以 5 种措辞写 5 次 | 存储条数不增长；检索不返回重复；token 不膨胀 |
| 冲突注入 | 先写"A 的截止日期是 3/1"，再写"A 的截止日期是 4/1" | 旧事实被 supersede；`as_of=2/1` 能查到旧值；当前查询只返回新值；无 `disputed` 误标 |
| 过时注入 | 写入已被官方文档否定的旧结论 | 旧结论命中率→0；不进入摘要层；画像不被污染 |
| 删除注入 | 删除后立刻查询 + 触发索引重建 | 读路径立即不可见；重建后仍不可见（防"重建复活"） |
| 投毒注入 | 记忆内容里插指令（"忽略之前指令…"） | 不被当作指令执行；不晋级为稳定记忆；有告警 |
| 容量注入 | 灌到配额上限 | 按价值淘汰而非随机；无静默丢失关键记忆 |

### 8.4 评测工程注意

- **固定 judge**：模型 + prompt + 温度全部版本化；换 judge 必须重跑基线并报告差异；
- **二值 rubric + 人工抽检 10%**，报告置信区间；
- **报告"能力 × 机制"矩阵**：LongMemEval 的 KU 类低分 ⇒ 查 supersede；abstention 低分 ⇒ 查"不该记的记了"；MemBench 的 reflective 低分 ⇒ 查摘要/画像层；capacity cliff 陡 ⇒ 查检索与压缩。

---

## 9. 「自我迭代记忆系统」机制清单

| # | 机制 | 解决什么问题 | 触发时机 | 实现成本 | 风险 |
|---|---|---|---|---|---|
| 1 | 稳定 ID + content_hash 幂等写入 | 重复（精确） | 每次写入 | 极低 | ID 不稳定则失效（勿用列表下标） |
| 2 | 实体键归一（canonical_id） | 重复/冲突候选爆炸 | 写入 + 定时回填 | 中（需别名表） | 对齐错误向下游全传播 |
| 3 | 语义近重复 + LLM 判定合并 | 冗余（同义不同表述） | 写入 / 批处理 | 中（1 次 LLM/候选） | 误合并丢细节；阈值需标注校准 |
| 4 | ADD/UPDATE/DELETE/NOOP 操作式更新 | 冲突、过时 | 每批新记忆 | 中高（2 次 LLM/条） | 硬删除不可审计；单次判断决定生死 |
| 5 | bi-temporal 失效（invalid_at）而非删除 | 过时 + 审计/回放 | 矛盾检测命中 | 中 | 图/表膨胀；检索端忘过滤则更乱 |
| 6 | 同实体对矛盾检测（LLM 四分类） | 冲突 | 写入 / 离线复核 | 中（候选限定后可控） | 判定错误 → 静默篡改历史 |
| 7 | 版本链 + supersedes | 冲突、回滚 | 更新 | 低中 | 读路径漏过滤会返回旧值 |
| 8 | 墓碑 + 延迟物理删除 | 删除一致性 | 删除请求 | 中 | 孤儿向量/缓存未清 → 复活 |
| 9 | TTL + 类型化半衰期 | 过时、容量 | 定时 | 低 | 误删重要记忆；必须软删 |
| 10 | 回忆强化（strength++） | 重要性排序 | 检索命中 | 低 | 富者愈富；公式方向必须有单测 |
| 11 | 分层摘要（事件→主题→画像） | 容量、检索效率 | 离线批处理 | 中高 | 摘要漂移；关键槽位丢失 |
| 12 | reflection / 洞察晋级（候选区→稳定区） | 抽象知识、去碎片 | 累计 importance 阈值 | 中高 | 幻觉固化；自我强化闭环 |
| 13 | sleep-time / 后台整合 | 延迟与质量 | 空闲/夜间 | 高（需第二 agent） | 静默漂移；整合期被投毒 |
| 14 | 属性增强（attribute mining） | 检索精度、可过滤 | 写入 | 中 | 属性抽取错误持久化；敏感属性泄露 |
| 15 | 分页/按需展开（budget-adaptive） | 上下文预算 | 每次推理 | 中 | 检索失败即"失忆" |
| 16 | 索引版本化 + 别名原子切换（RAG） | 过期文档 | 文档变更/模型升级 | 中 | 三端双写不一致 |
| 17 | ACL 同步重索引 | 越权、幽灵数据 | 权限变更 | 中 | 泄露（最高优先级） |
| 18 | 配额 + 水位告警 | 成本、容量 | 持续 | 低 | 提前截断丢信息 |
| 19 | 注入式回归 + benchmark 门禁 | 质量回归 | CI/发布 | 中 | 基准饱和、judge 漂移 |

---

## 10. 参考架构与反模式

```
写路径（同步，<100ms）
  ingest → hash/幂等短路 → 实体对齐 → 同键候选 → 规则判定（时间更新/显式纠正）
        → [仅当相似度>阈值] LLM 裁决 → 写版本化记录（valid_from/valid_to + provenance）
        → outbox 事件 → 异步索引更新（memory_id+version 幂等）

读路径（同步，<200ms）
  query → hybrid 召回（dense + BM25/实体 + 图 n-hop）→ 过滤（valid_to is null / 未过期 / ACL）
        → RRF+MMR+rerank → 分层展开（摘要优先，按需下钻原文）→ 注入（带时间与来源）

离线（异步，分钟~小时）
  transcript 归纳 → 候选事实 → 与既有库对账（dedup/conflict）→ 摘要分层/画像
  → 晋级评审（候选区→稳定区）→ TTL/配额执行 → 质量抽检 → 指标上报
```

**反模式清单**（都有真实案例）：

1. 破坏性随机遗忘（MemoryBank 的 `pop` + 公式方向错误）；
2. 在 load/build 路径里做 mutation（建索引顺手删数据）；
3. 用列表下标当 memory_id；
4. 只写新向量、不删旧向量（10 个版本全部可召回）；
5. 让 LLM 现写 Cypher/SQL 查询记忆；
6. 无 provenance、无 confidence、无 status 字段（分不清用户说的和模型编的）；
7. 无上限 append + 无配额（半年后 token 爆炸）；
8. 把 reflection 结果直接当事实（幻觉进入画像层后再也洗不掉）；
9. 用单次 LLM 打分决定"重要性"且无校准、无审计；
10. 只跑 benchmark 不做注入式回归（机制坏了但平均分看不出来）。

---

## 11. 来源清单

**论文（arXiv 编号均已核验标题）**
- MemGPT — https://arxiv.org/abs/2310.08560
- Mem0 — https://arxiv.org/abs/2504.19413
- Zep — https://arxiv.org/abs/2501.13956
- Sleep-time Compute — https://arxiv.org/abs/2504.13171
- A-MEM — https://arxiv.org/abs/2502.12110
- MemInsight — https://arxiv.org/abs/2503.21760
- MemoryBank — https://arxiv.org/abs/2305.10250
- Generative Agents — https://arxiv.org/abs/2304.03442
- LoCoMo — https://arxiv.org/abs/2402.17753
- LongMemEval — https://arxiv.org/abs/2410.10813
- MemBench — https://arxiv.org/abs/2506.21605
- Knowledge Conflicts for LLMs: A Survey — https://arxiv.org/abs/2403.08319
- FlexA-Mem — https://arxiv.org/abs/2610.33274 ✅ ｜ 代码 https://github.com/WujiangXu/Flex-Amem

**实现与文档**
- Letta — https://github.com/letta-ai/letta ｜ https://docs.letta.com ｜ MemFS https://docs.letta.com/concepts/memfs
- sleep-time-compute 代码 — https://github.com/letta-ai/sleep-time-compute
- Mem0 — https://github.com/mem0ai/mem0 ｜ https://docs.mem0.ai/core-concepts/how-it-works
- Graphiti — https://github.com/getzep/graphiti
- A-Mem — https://github.com/WujiangXu/A-mem ｜ https://github.com/WujiangXu/A-mem-sys
- MemoryBank — https://github.com/zhongwanjun/MemoryBank-SiliconFriend
- MemoryBank 源码审计（含遗忘公式缺陷）— https://github.com/neoneye/agent-memory-atlas
- Cognee（remember/recall/improve/forget）— https://github.com/topoteretes/cognee
- agent-memory-mcp（temporal validity / supersession / drift detection / provenance）— https://github.com/ipiton/agent-memory-mcp
- true-mem（短期→长期晋升 + 衰减 + 多因子排序）— https://github.com/rizal72/true-mem
- agentic-remem prior-art（多系统对照，2026-09 快照）— https://cdn.jsdelivr.net/npm/agentic-remem@0.2.3/docs/prior-art.md
- RAG 知识库更新工程实践（版本化/去重/幂等/灰度/回滚）— https://github.com/snailclimb/javaguide/blob/main/docs/ai/rag/rag-knowledge-update.md
- 记忆工程实践综述（去重四件套/冲突四分类/写入门控/指标）— https://github.com/cdavid817/agent-interview

**未能核验**
- Oracle 博客《How to Detect RAG Index Drift: Deleted Docs, Stale Chunks, and Duplicate Embeddings》返回 HTTP 403，其结论未采用。
- export.arxiv.org API 与 Semantic Scholar API 多次 429，改用 abs 页与二手分析核验，二手数字已逐处标注 ⚠️。
