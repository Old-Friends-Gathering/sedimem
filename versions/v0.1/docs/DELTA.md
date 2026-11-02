# v0.1 · 版本说明（DELTA）

> **0.1.2 增量（2026-11-02）**：本版新增「不被自己腐化」的机制——四道门禁（质量/安全/覆盖率/issue 关联）+ 四个 CI workflow，
> 以及并发漏读缺陷根治（`_reload` 先取水位再读，见 CHANGELOG [0.1.2]）。产品更名 strata，技术标识保持不变。

## 本版做了什么

P0 可用闭环 + **确定性**卫生 + **Agent 当裁判的去重闭环**。目标是先把「不变量」立住（真相层不可变、id 稳定、过期即失效、删除可审计），再把「重复/冲突/冗余」这条用户最痛的问题用零成本方式闭上环。

| 能力 | 状态 | 说明 |
|---|---|---|
| 真相层 `items/<scope>.jsonl` | ✅ | append-only，同 id 最后一行胜出；`reindex` 只读；增量读 `loadScopeIncremental` |
| 倒排索引（BM25） | ✅ | 纯 JS 内存索引，启动时从真相层重建；`size` 入契约（可换 sqlite） |
| hash 去重 | ✅ | `sha256(normalizeText(text)+slot)`，零 LLM，跨进程锁内判定 |
| 同 slot 同值短路 | ✅ | 换措辞的**字面近似**重复不增长（containment ≥0.85） |
| 语义去重（Agent 裁判） | ✅ | 真人改写去 `dedupeScan` 聚簇 → 模型判定 → `curateApply` 非破坏合并（I11 英文 / I12 中文） |
| 中文改写召回（0.1.1） | ✅ | 双路候选：containment ≥0.45 或 汉字二元组 Dice ≥0.15（纯英文对 Dice=0，不引入 13.68% 的英文误聚） |
| 冲突失效（supersede） | ✅ | 值可比较（时间/数字）时自动取代；旧记录写 `validTo` |
| 不确定即 disputed | ✅ | 不可比较的异值并存 + 入裁决队列，绝不静默覆盖 |
| bi-temporal + `asOf` | ✅ | 按时间戳比较（UTC ms），可回查「当时有效」的版本 |
| 墓碑删除 | ✅ | `forget` 只写 tombstone，不物理删 |
| 确定性 brief | ✅ | ≤80 行；suspicious 行占位；末尾提示待裁决去重候选数 |
| 裁决批次 curate | ✅ | 导出 → Agent 签字 → 回写（`decisions:[{ids,decision,note}]`） |
| 投毒防线 | ✅ | 归一化（NFKC/零宽/CJK 空格/异体字）+ base64/拆字/拼音启发式；读路径默认遮蔽 |
| MCP stdio（10 工具） | ✅ | 三端唯一缝；严格参数校验、响应串行、未 initialize 拒绝 |
| eval（11 注入 + 指标 + 基准） | ✅ | 门禁见 `docs/ACCEPTANCE.md`；I7b 如实记录「词法不覆盖真人改写」 |

## 本版刻意不做（附理由）

| 不做 | 理由 |
|---|---|
| 向量/embedding | 5k 条以内词法 + 实体键 + Agent 裁判足够；先证明治理机制，再加检索能力 |
| 图数据库 | 冲突消解靠 (subject,predicate) 约束，不需要图 |
| 自动摘要分层 | 加工本身会腐化（FlexA-Mem），v0.1 只做确定性渲染 |
| 跨机同步 | 单机需求未验证，先不引入 git 冲突合并 |
| JSONL compact | 容量上限 5000 条 + 墓碑，短期无压力；v0.2 做 |
| 夜间无人 LLM 裁决 | 需要 `JudgePort` 注入点与 API 预算；v0.1 用「正在运行的 Agent」当裁判，零成本 |

## 与上一状态的关系

这是从零开始的 v0.1，没有「上一版」。参考实现对照：
- 取代 `dsh-memory@0.1.0`（只有 INSERT/DELETE，无去重/冲突/过期）—— 用 `memo migrate dsh-memory` 搬运存量。
- 不采用 mem0 v3（ADD-only，显式放弃冲突消解）。
- 借鉴 Graphiti 的 bi-temporal 失效、mcp-memory-service 的四类卫生动作，但去掉它们的服务端依赖。

## 与最初的差异（第二轮审核后修正的认知）

1. **「换措辞重复」不能只靠词法**：实测 5 句真人改写词面相似度只有 0.4–0.5，写入门控会全部放行（这是正确的：不误杀）。语义去重改为「候选发现（0.45）+ Agent 判定 + 非破坏合并」，并在 I7b 里**把这个限制固化成断言**，防止未来谎报。
2. **跨进程一致性是阻断级**：常驻 MCP server 的内存快照会漏掉别的进程写入，必须锁内「重读→判定→追加」。
3. **「词法完全不行」只对英文成立**：中文真人改写如果保留名词，containment 能到 0.55–0.67（写入门控 0.85 仍不误杀、扫描 0.45 就能召回）；只有「内容词全换」才需要汉字二元组 Dice。IDF 加权、全字符 Dice、降到 0.10 三种加强方案都有实测反例，已写入 §3.5。
4. **`source.agent` 不收窄成枚举**：否则新客户端（grok/opencode）接不进来；改成自由标签 + 保留名黑名单。

## v0.2 入口（按优先级）

1. `JudgePort` 注入点 + `judge-llm.js`（夜间无人裁决；接口已在 `docs/03` 列为 Port）。
2. `src/index/sqlite-index.js`（IndexPort 第二实现，验证可替换性）+ `MEMO_INDEX` 切换。
3. `kind`/`status` 注册表数据化（新增 kind 只改 policy）。
4. `memo compact`：墓碑与历史版本压缩（必须保号、必须可回放）。
5. 错误码归一（`E_MEMO_HOME_UNWRITABLE`）+ metrics 时间序列与趋势告警（`conflict_rate` 连续上升 → 提示整理）。
