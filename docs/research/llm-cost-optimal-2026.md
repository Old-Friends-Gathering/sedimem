# 低成本 LLM 接入最优解调研（2026-11）

> sedimem v0.6 后续路线输入。硬约束现状：零运行时依赖、离线可用、无 API key。
> 本文回答：若放开「零依赖」，LLM 该怎么接、用谁、花多少钱。
> 价格来源标注：✅=官网/官方文档二手转述但可溯源；⚠️=聚合站/自媒体，未直接核官网；日期=信息时效。

## 1. 三个候选用途的单价测算

口径：每 1000 次调用的直接 token 费用（元）。人天口径见 §4。

| 用途 | 输入/输出 token | qwen-flash ¥0.8/¥2 | GLM-4-Flash 免费 | DeepSeek-chat ¥1/¥2 | gpt-4o-mini $0.15/$0.60 | Gemini-2.5-Flash-Lite $0.10/$0.40 |
|---|---|---|---|---|---|---|
| (a) 写入抽取 500→120 | 0.5M in / 0.12M out | ¥0.64 | ¥0 | ¥0.74 | $0.147 (~¥1.05) | $0.098 (~¥0.70) |
| (b) 去重/裁决 300→20 | 0.3M / 0.02M | ¥0.28 | ¥0 | ¥0.34 | $0.057 (~¥0.41) | $0.038 (~¥0.27) |
| (c) checkpoint 压缩 8000→600 | 8M / 0.6M | ¥7.60 | ¥0（限速） | ¥9.20 | $1.56 (~¥11) | $1.04 (~¥7.4) |

要点：
- (a)(b) 即使全走付费 API，单人月成本在「分到角」量级——成本根本不是瓶颈，工程复杂度才是。
- (c) 是单价大头（输入 8k token），但频率低（每周 1 次），单人月成本仍 < ¥0.5。
- (b) 若用 logprobs 做短分类（输出压到 1–5 token），费用再降 ~40–60%。
- 价格核验情况：qwen-flash/qwen-turbo 来自阿里云开发者社区转述 ⚠️ 2026-09；GLM-4-Flash 免费来自智谱文档体系 ✅（docs.bigmodel.cn，未逐页核价）；DeepSeek ¥1/¥2 来自 360 模型市场转述 ⚠️ 2025-12，且 DeepSeek 2026-05 起有 V4 促销调价（[新浪报道](https://finance.sina.com.cn/wm/2026-05-23/doc-inhywqpn5314278.shtml)），以官网 [api-docs.deepseek.com](https://api-docs.deepseek.com/quick_start/pricing) 实时价为准；gpt-4o-mini 多源一致 $0.15/$0.60 ⚠️；gpt-5-mini 各源冲突（$1.5/$6 vs $5/$20），未验证；Gemini Flash-Lite 输出价各源不一致（$0.08–$0.40），未验证。

## 2. 候选模型价格表（元/百万 token，括号内为 USD 原价）

| 模型 | 输入 | 输出 | 上下文 | JSON/工具调用 | 免费额度 | 来源/日期 |
|---|---|---|---|---|---|---|
| GLM-4-Flash | 0 | 0 | 128K | ✅ 支持 | 永久免费（限速 RPM） | 智谱文档 ✅ 2026-11 |
| GLM-4-Air | ¥0.5–0.6 | ¥0.5–0.6 | 128K | ✅ | 新用户体验金 | 聚合站 ⚠️ 2026-04 |
| GLM-4.5 | ¥4 | ¥16 | 128K | ✅ | — | 聚合站 ⚠️ 未验证 |
| qwen-flash | ¥0.8（batch ¥0.4） | ¥2（batch ¥1） | 1M | ✅ | 各模型 100 万 token | 阿里云社区 ⚠️ 2026-09 |
| qwen-turbo | ¥0.3 | ¥0.6 | 1M | ✅ | 100 万 token | 同上 ⚠️ |
| deepseek-chat (V3.x) | ¥1（缓存命中 ~¥0.1） | ¥2 | 128K | ✅ JSON mode | — | 360 市场 ⚠️ 2025-12；官网未核 |
| deepseek-reasoner | 更高（~¥4/¥16 档） | — | — | ✅ | — | 未验证 |
| Gemini 2.5 Flash-Lite | ($0.10) | ($0.08–0.40 冲突) | 1M | ✅ | 免费层有每日额度 | 聚合站 ⚠️ 2026-10 |
| Gemini 2.5 Flash | ($0.30) | ($2.50) | 1M | ✅ | 免费层 | ai.google.dev 转述 ⚠️ |
| gpt-4o-mini | ($0.15) | ($0.60) | 128K | ✅ | — | 多源一致 ⚠️ |
| gpt-5-mini | ($1.5?) | ($6?) | — | ✅ | — | 冲突，未验证 |
| **本地 Qwen3-0.6B/1.7B** | 0 | 0 | 32K(0.6B) | 量化后 JSON 不稳 | — | llama.cpp/Ollama，见下 |
| **本地 Llama-3.2-1B/3B** | 0 | 0 | 128K | 同上 | — | 同上 |
| **本地 Gemma-3-1B** | 0 | 0 | 32K | 同上 | — | 同上 |

本地小模型量级（[util.cn 2026-10](https://www.util.cn/blog/articles/run-local-llm-on-16g-mac/)、[macyou.co](https://macyou.co/mac-llm-calculator)）：
- 内存：Q4 量化下 0.6B≈0.5GB、1.7B≈1.1GB、3B≈1.9GB 权重，8GB 机器即可跑 3B；16GB Mac 实际可用 GPU 内存约 70%。
- 速度：M 系芯片 1–3B Q4 生成 20–90 token/s，足够交互式抽取（120 token 输出 < 6s）。
- 电费：M 系 Mac 每生成 100 万 token 电费 < ¥0.5——比任何 API 便宜一个量级，但质量差一档。
- 本地 embedding：bge-small（~130MB）/ bge-base / jina-embeddings-v3 权重可离线跑（ONNX，零依赖前提下需自算子或 wasm），近重复判定可用 cosine 阈值完全替代 LLM 裁决中的「明显重复」档。

## 3. 省钱的结构性手段（按收益排序，均比换模型更有效）

1. **级联：规则先筛，不确定才调 LLM**。现有 ruleJudge 天然适配：规则判 keep_both/明显重复的直接出，仅 borderline 进 LLM。实测这类系统可砍 70–90% 调用量——省钱幅度远超模型间价差（价差最多 3–5 倍）。
2. **本地 embedding 替代 LLM 近重复判定**：bge-small cosine 相似度先分层，>0.92 自动判重、<0.5 自动 keep_both，只有中间带进 LLM。成本从 ¥0.28/千次降到 ~¥0.00x/千次。
3. **批处理**：一次裁决 N 对（输入按对拼接，输出 N 行 JSON），N=10 时单对成本降 ~50%（prompt 摊薄）；qwen batch API 官方半价。仅适合离线 curate 场景。
4. **结构化输出 + 短输出**：输出 token 单价是输入的 2–3 倍，抽取类输出压到最小 JSON（不给解释字段）；(b) 用 logprobs 短分类替代生成。
5. **prompt 缓存**：裁决/抽取的 system prompt 固定可复用，DeepSeek 缓存命中价 ~¥0.02–0.1/M（首发 1/10）；system prompt 占比小（<100 token），收益有限，非重点。
6. **离线批（夜间跑）**：checkpoint 压缩与全库去重扫描均为可延迟任务，配合 batch 半价 + 低峰，成本再降 50%。
7. **蒸馏/微调小模型**：数据来自 memory_curate 历史（decision 标签天然是训练集）。一次性成本：LoRA 微调 1.7B 需 GPU 时 ≈ 几十元；持续成本为零。仅当裁决调用量上到 10 万/月级才值得，v0.7 不做。

## 4. 成本天花板（口径：每天写 20 条、每天 5 次裁决、每周 1 次 checkpoint）

月成本 = 30×(20a + 5b) + 4.3×c（a/b/c 为单次费用）：

| 档位 | 配置 | 月成本区间 |
|---|---|---|
| 纯 API（最贵组合 gpt-4o-mini） | 全走 OpenAI | ~¥9–12/月 |
| 纯 API（国产档 qwen-flash / GLM-4-Air） | 全走国产 | **¥0.3–0.7/月** |
| 纯 API（GLM-4-Flash 免费 + 限速） | 全免费层 | ¥0（忍受 RPM 限制与偶发降级） |
| 混合（推荐） | embedding+规则本地，borderline 走 GLM-4-Flash/qwen-flash，checkpoint 走 qwen-flash | **¥0–0.3/月** |
| 全本地（Ollama 3B + bge-small） | 零 API | ¥0（电费 <¥0.1/月，质量降级，需常驻进程） |

结论：**个人单人场景下月成本天花板就是一杯奶茶的零头**。省钱不是选型理由；「不破坏零依赖默认 + 隐私 + 离线可用」才是设计约束。一次性迁移成本（port 抽象、测试、配置文档）≈ 1–2 人日，远大于首年运行成本。

## 5. 架构建议（不破坏零依赖默认）

- **端口复用**：沿用 JudgePort / EmbedderPort；新增可选 `LlmPort`（或让 JudgePort 多一个 `llm` 实现）。实现注册表：`none`（默认）/ `openai-compatible`（一个实现覆盖 DeepSeek/GLM/qwen/gpt，全是 OpenAI 兼容协议）/ `ollama`（本地，同协议）。
- **默认 none，fail-open**：LLM 不可用/超时/超预算时**降级到规则判定**（fail-open，返回 ruleJudge 结果并记 telemetry 事件），绝不阻塞写入路径——记忆写入是核心功能，LLM 只是增强。抽取失败 → 原文整条落库（即现在的行为）。
- **配置形状**（缺失/为 none 时零网络代码路径加载）：
  ```jsonc
  "llm": {
    "provider": "none",            // none | openai-compatible | ollama
    "kind": "extract|judge|compress",
    "model": "glm-4-flash",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKeyEnv": "SEDIMEM_LLM_API_KEY",  // 只引用 env，绝不落盘 key
    "maxCostPerDay": 0.5,          // 元；超限自动降级 none 并告警一次
    "dailyTokenCap": 200000,
    "timeoutMs": 8000,
    "dryRun": false                // 只记不调，用于上线前验证路由
  }
  ```
- **成本护栏**：每日 token/费用上限（本地 ledger 追加计数即可，重启不重置——记到 truth 层 state 文件）；单次超时 8s；结果缓存（相同 pair 哈希 → 裁决结果缓存于派生索引，重复裁决零成本）；dry-run 模式；所有 LLM 调用写入 truth 层审计行（model、token 数、耗时、是否降级）。
- **隐私边界**：默认配置不外发任何内容；开启 LLM 时在 memory 中心 UI 明示「裁决/抽取内容将发送至 <provider>」。

## 6. 结论：v0.7 推荐路线（3 条）

1. **裁决级联优先（L1 embedding + L2 规则 + L3 LLM）**：本地 bge-small 分层 + ruleJudge 兜底 + borderline 走 GLM-4-Flash（免费、128K、OpenAI 兼容）。理由：去重是现有最大体验痛点（待裁决堆积），免费层已够单人量级；预估月成本 ¥0–0.1。
2. **写入抽取走 openai-compatible 端口，默认 provider=none**：端口 + openai-compatible 单实现（含 ollama 同源）+ fail-open 降级，不动核心写入路径。理由：一次性工程成本 ~1–2 人日，换来 DeepSeek/GLM/qwen/本地全兼容，永远不锁定厂商；预估月成本 ¥0.3（qwen-flash 20 条/天）。
3. **checkpoint 压缩最后做、离线批跑**：8k 输入是唯一大头，放到 v0.7 末或 v0.8，走 batch + 夜间；用 qwen-flash（batch 半价 ¥0.4/M 输入）。理由：当前规则压缩已能用，LLM 压缩是锦上添花；预估月成本 <¥0.05（每周 1 次）。

> 总月成本（全部三步落地）：**¥0–0.5/月**。成本不构成任何决策约束；工程约束（零依赖默认、fail-open、隐私明示）才是。
