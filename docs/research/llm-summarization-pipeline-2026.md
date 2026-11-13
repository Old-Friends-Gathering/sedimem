# LLM 参与记忆总结：工程方案（sedimem 1.0）

> 定价基准：GLM-5.3-Flash，1M 上下文；输入 ¥0.8/M tok、输出 ¥2.8/M tok、缓存命中 ¥0.23/M tok（bigmodel.cn 定价页，2026-11 核实）。
> 换算：**每 1k 输入 token ≈ ¥0.0008；每 1k 输出 token ≈ ¥0.0028**。1 次典型总结调用（2k in / 200 out）≈ **¥0.0064**，一天 1000 次约 ¥6.4。
> 纪律：所有外部结论给出处；未核实的写「未验证」。

## 0. 调研：各家 LLM 总结/抽取工序

### Mem0（mem0ai/mem0）
- v3 改为 **single-pass ADD-only**：一次 LLM 调用只产出 ADD，新事实直接插入，不做对比裁决（本仓 `docs/research/agent-memory-projects-survey-2026-11.md` §1，引 `mem0/memory/main.py:20-23`、`:942-950`，2026-11 核实）。
- 旧 **update prompt（ADD/UPDATE/DELETE/NOOP 四选一，逐条事实对比）** 仍在 `mem0/configs/prompts.py:176-220`，默认路径已不用——官方实践等于承认「四选一裁决」的 LLM 成本与错误率不划算，改由检索期向量融合兜底。**这正是我们要吸取的教训：裁决交给规则层，LLM 只做抽取。**

### LangMem（langchain-ai/langmem）
- 核心 API `create_memory_manager`：输入「messages + existing memories」，输出 Pydantic 文档（如 `Triple(subject, predicate, object)`）的 create/update/remove 列表，`enable_inserts / enable_deletes` 开关（`langmem/docs/docs/guides/extract_semantic_memories.md`，GitHub 41a6c3b3，2025-07 版本核实）。
- **hot path vs background**：官方明确区分「对话内同步调工具（hot path，要求低延迟）」与「会话结束后后台整理（background，可慢可贵）」，记忆抽取推荐放 background（LangChain 官方博客《LangMem SDK launch》，2025-02-18，langchain.com/blog/langmem-sdk-launch）。

### Zep/Graphiti（getzep/graphiti）
- episode → 实体/关系抽取是**多步 prompt 流水线**：`graphiti_core/prompts/` 下 `extract_nodes.py`（实体+摘要）、`extract_edges.py`（关系）、`dedupe_nodes.py`/`dedupe_edges.py`（消歧合并）、`extract_nodes.py` 内 entity summary 更新 prompt（GitHub 526dcad7 与 `graphiti_core/prompts/lib.py:92-102` 入口，DeepWiki 索引核实）。
- community summary：社区聚类后对子图做摘要（本仓 survey §3：community 构建 + graph maintenance）。**要点：抽取和消歧是分开的多次 LLM 调用，消歧需要「看候选再裁决」——与我们 dedupe_scan/curate 两段式同构。**

### Letta（MemGPT）
- sleep-time compute：主 agent 空闲时由后台 agent 异步巩固 memory blocks，可用比主 agent 更强的模型（arXiv 2504.13171《Sleep-time Compute: Beyond Inference Scaling at Test-time》；教程见 rohitg00/ai-engineering-from-scratch phase 14-08）。
- recursive summary：超出上下文的消息驱逐到 recall storage 时做递归摘要（MemGPT 分页；本仓 survey §2）。**要点：巩固永远离线、不阻塞主路径。**

### MemOS / TriMem：TextGrad 式 prompt 迭代
- TriMem（arXiv 2605.19952）把抽取 prompt `p_e` 与画像 prompt 当作可训练参数，用 TextGrad（Yuksekgonul et al., 2024）以「参考答案 vs 生成答案」的失败信号回传优化（论文 §3.4 Lifelong Evolution with Optimized Prompt，export.arxiv.org/pdf/2605.19952）。**MemOS 本体未查到用 TextGrad 的证据（未验证）；MemOS 的 prompt 模板见 `src/memos/templates/mos_prompts.py`。对我们：把「eval 失败样本 → 修抽取 prompt」做成离线闭环，而不是在线自改。**

### 一句话摘要类实践
- basic-memory：Markdown 文件即真相，一观察一行，SQLite 只做索引（本仓 `docs/research/memory-ecosystem-2026.md` §2）。
- Anthropic/OpenAI 风格：memory 摘要偏好「一条偏好 = 一句可执行陈述」，长度敏感；本仓 `docs/research/memory-brevity-2026.md` 已有对照（Anthropic/OpenAI 具体 prompt 原文：未验证）。

## 1. 在哪里调 LLM 最值（性价比排序）

| 排序 | 调用点 | 输入 tok/次 | 输出 tok/次 | 触发频率 | 预期收益 | 单次成本 |
|---|---|---|---|---|---|---|
| ① | **写入时摘要/结构化**（derive 层：title/summary/kind/SPO） | 800–2k（原文+schema+few-shot） | 100–200 | 每次 memory_write 落库后异步 | 检索命中、brief 可读性质变；这是唯一「必调」点 | ¥0.004–0.007 |
| ② | **去重裁决**（dedupe_scan 簇的 a_wins/b_wins/merge） | 1k–3k（同簇原文） | 30（一个枚举+一句 note） | 仅扫描出候选时（实测低频） | 消灭同义重复，dupRatio 直接下降 | ¥0.009–0.011 |
| ③ | **session checkpoint 晋升摘要**（close 时把 state 压成 decision/gotcha） | 2k–8k（会话尾段） | 200–400 | 每会话 1 次 | 会话级记忆的入口质量 | ¥0.02–0.07 |
| ④ | **brief 渲染**（memory_brief 的主题句合成） | 500–1k（选中记录） | 150 | 每 brief 请求可缓存 | 一般——规则截断已够用，LLM 只在日频缓存层做 | ¥0.004 |
| ⑤ | **写入门控**（要不要收这条） | 300 | 5 | 每次写入 | **不值得**——规则层（长度/重复/敏感词）够用，Mem0 v3 也在门控上放弃 LLM | ¥0.0025 |

按日 1000 写入：①≈¥5–7 + ②③④≈¥2–3 → **常态 ¥10/日以内**；缓存命中（system prompt+schema 前缀稳定）可再省约 60% 输入费。

## 2. 输出契约（JSON schema）

LLM 只产出**派生字段**，与真相层（text/kind/subject/predicate/value 由调用方或 LLM 建议、人/规则确认）分离：

```json
{
  "type": "object",
  "required": ["title", "summary", "kind", "spo"],
  "properties": {
    "title":    {"type": "string", "maxLength": 40},
    "summary":  {"type": "string", "maxLength": 80},
    "kind":     {"type": "string", "enum": ["fact","pref","decision","gotcha","state"]},
    "spo": {
      "type": "object",
      "properties": {
        "subject":   {"type": "string", "maxLength": 60},
        "predicate": {"type": "string", "maxLength": 40},
        "value":     {"type": "string", "maxLength": 300}
      }
    },
    "tags": {"type": "array", "items": {"type": "string", "maxLength": 20}, "maxItems": 5}
  }
}
```

正例 1（输入原文："用户说：以后所有报告都用中文写，别用英文"）：
```json
{"title":"报告语言偏好中文","summary":"用户要求所有报告用中文撰写","kind":"pref",
 "spo":{"subject":"用户(报告语言)","predicate":"要求使用","value":"全部报告使用中文，不用英文"},"tags":["写作偏好"]}
```
正例 2（输入原文："2026-11-13 发现 sedimem v0.6 在 Windows 下路径分隔符导致索引损坏，改用 path.posix 后修复"）：
```json
{"title":"Windows 路径分隔符损坏索引","summary":"v0.6 Windows 下需 path.posix 防索引损坏","kind":"gotcha",
 "spo":{"subject":"sedimem v0.6(Windows 索引)","predicate":"必须使用","value":"path.posix 统一路径分隔符，否则索引损坏（2026-11-13 修复）"},"tags":["windows","bug"]}
```

## 3. 成本护栏

1. **预算**：本地配置 `LLM_DAILY_BUDGET_CNY`，默认 **¥15/日**；滑动窗口计数器（复用 L3 预算机制，见 v0.3 CHANGELOG I23），超限后全部调用直接走 fail-open。
2. **token 上限**：单次输入 ≤4k tok、输出 ≤300 tok（超限先规则截断原文，不截 schema）；每日输出总量 ≤200k tok。
3. **超时**：单调用 8s（SDK timeout），批任务 60s；重试 1 次（指数退避 2s），再失败 fail-open。
4. **fail-open**：任何失败（网络/超时/JSON 解析错/schema 校验失败）→ 派生字段置 `null` + `derive_status:"failed"`，记录用规则层兜底（title=原文前 40 字、summary=前 80 字）。**写入永不因 LLM 失败而拒绝。**
5. **缓存**：`sha256(model + prompt_version + 原文)` 为 key 落 SQLite；同原文重跑直接命中；另外把 system+schema 固定前缀交给上游 context cache（¥0.23/M）。
6. **批处理**：session close、dedupe 裁决一次请求带 ≤10 条，输出 JSONL，摊薄固定前缀成本约 40%。
7. **模型分级**：GLM-5.3-Flash 做全部常规；「难例」——dedupe 簇 strength=weak 且 dice 落在 [0.35,0.6] 灰区、或裁决复核——路由到大模型（按次 ≤5%/日）。

## 4. 质量评测（接 eval I1–I40 框架，新增 I41–I43）

沿用 `eval/run.js` 门禁式 PASS/FAIL（见 `versions/v0.3/docs/ACCEPTANCE.md` G2 的口径），三个可机械测指标：

- **I41 信息保留率（recall of facts）**：构造金标集 40 条原文（每条人工标注 2–4 个「必须保留的事实点」），LLM 派生结果由第二个固定 LLM 调用逐点判「保留/丢失/变形」；阈值：保留率 ≥90%，变形率 ≤5%。判分 prompt 版本固化进 fixtures，防漂移。
- **I42 一致性（faithfulness，零幻觉）**：金标集另标注「原文没有的实体/数值」，对派生结果做包含检测 + LLM 判分；阈值：幻觉数 = 0（title/summary/value 中出现原文不存在的数字、人名、日期即 FAIL）。
- **I43 可检索性增益**：A/B 跑 BM25 search——只用原文 vs 原文+派生 title/summary——用 40 条预写查询测 Recall@5；阈值：派生层使 Recall@5 提升 ≥8 个百分点，且 p95 <50ms 不回归（沿用现有 bench 口径）。
- 回归纪律：prompt 改版必须先跑 I41–I43 再合入（TextGrad 式离线迭代：失败样本自动归档到 `eval/fixtures/llm-derive/failures/`）。

## 5. 与 append-only 的关系：LLM 只写派生层

- **schema 强制**：记录真相层字段（text、created_at、agent 等）在 schema 上标 `immutable:true`；LLM 输出只进 `derived` 子文档（`{title,summary,spo,tags,model,prompt_version,derived_at,derive_status}`），且 `derived` 带 `record_id` 外键、单写不许覆盖真相字段。
- **门禁**：写入路径 `applyDerivation(recordId, output)` 只 upsert derived 子文档；类型层禁止传入 truth 字段（TypeScript/JS 把 truth 写入函数从 derive 模块导出表里物理排除）。curate 的 merge 也只 supersede + 新写，不 in-place 改（现有机制已是 append-only，LLM 不新增写权限）。
- **测试**：新增单测「任意 LLM 输出（含恶意超长/含 SQL/伪造 truth 字段）经 applyDerivation 后，原 record 逐字节不变」——用 `structuredClone` 快照比对；I 系列加 I44「derive 前后真相层 hash 不变」。

## 结论

借鉴排序：**LangMem 的 background 化 + Mem0 v3 的「抽取与裁决分离」 + Letta 的离线巩固 + Graphiti 的分步消歧**，落在 sedimem 上的形态是——写入门控纯规则；写入后异步用 GLM-5.3-Flash 做单次抽取（契约 §2，fail-open §3）；去重裁决与 checkpoint 晋升按需调；评测 I41–I44 进门禁；一切 LLM 产物只活在 derived 层，真相层逐字节不可变。
