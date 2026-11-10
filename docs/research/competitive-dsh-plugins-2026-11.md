# DSH 记忆插件竞品对比（2026-11-10）

> 口径：竞品描述取自 awesome-dsh-plugin 快照（`/tmp/awesome-readme.md`，Memory 分类约 250 条）与 3 份 README 原文
> （`kenz1117/dsh-engram` 420 行、`zilliztech/memsearch` 683 行、`MemTensor/MemOS apps/memos-local-plugin` 499 行，
> 2026-11-10 拉取）。均为项目自述，未逐条实测源码；与 sedimem 的对比列是**我们实测的事实**（288 tests / I1–I23 /
> 门禁数字都来自本仓 CI）。引用规则同 `docs/research/README.md`：先改研究，再改设计。

## 1. 生态分层（谁在跟谁竞争）

Memory 分类 250+ 插件，按「记忆从哪来 / 怎么查 / 谁维护」分成四层，强度递增：

| 层 | 代表 | 特征 |
|---|---|---|
| 文件约定型 | Kagurazaka135/dsh-memory（YAML 版本史）、memsearch（Markdown+Milvus 影索引） | 人可读可编辑，检索靠索引 |
| SQLite 单库型 | dsh-ltm、dsh-long-memory、dsh-memory-system、LornBerry/dsh-memory-center | BM25±CJK bigram，面板 CRUD |
| 自动捕获型 | dsh-prime-memory（L0–L3 蒸馏）、MemOS plugin（L1/L2/L3+Skill）、skepsun/dsh-engram（零 LLM 捕获）、dsh-dream（教训回灌 AGENTS.md） | 会话日志→自动入库 |
| 平台生态型 | OpenViking（火山官方，server+`viking://`）、memsearch（Zilliz，5 端共享）、dsh-engram（kenz1117，本地全套） | 公司/重度维护，端到端产品 |

sedimem 属于「文件约定型 × 治理增强」：JSONL 真相层 + Agent 裁决回路，**检索是弱项、治理是强项**。

## 2. 逐项对比（只列可核实的维度）

| 维度 | sedimem 0.3.6（实测） | dsh-engram（README） | memsearch（README） | prime-memory（README+实测） | MemOS plugin（README） |
|---|---|---|---|---|---|
| 真相层 | append-only JSONL + bi-temporal，as-of 回查，字节可重建视图 | SQLite 四态写入（accept/merge/defer/drop） | Markdown + Milvus 影索引 | SQLite，蒸馏结果**覆盖式** | SQLite L1/L2/L3/Skill/Episode/Feedback |
| 检索 | 倒排 BM25（或 FTS5 后端），p95≈2ms@5000，**无向量** | FTS5+本地向量 RRF+关系边一跳 | dense+sparse+RRF+可选远程 rerank | 图谱 search/expand + 蒸馏召回 | MemOS 核心检索 |
| CJK | 二元组 Dice（实测误聚 1.41%@0.15）+ containment 双路 | 未声明 | 中文/英文评测文档 | jieba+sqlite-vec | 未声明 |
| 去重/冲突 | dedupeScan 候选簇 → Agent 裁决（V1–V5）→ supersede 链 | 向量≥0.88 建矛盾边，默认无 LLM | SHA-256 hash 短路 + smart dedup | 未声明（用户此前反馈无出处） | 未声明 |
| 捕获 | **手动/Agent 写**（AGENTS.md 强制规则） | 保存/摄取双通道 | **全自动逐轮捕获** | 全自动 L0 捕获 | 会话捕获+反馈双通道 |
| 跨客户端 | DSH+Codex+Claude **实测三端 PASS**（verify-three-clients.sh 在仓） | DSH-only（23 个 engram_* 工具） | **5 端**（CC/Codex/DSH/OpenClaw/OpenCode） | DSH-only | DSH-only（依赖 MemOS core） |
| 依赖 | **零依赖**（node 内置；插件壳 576K） | 可选 300MB onnx 模型缓存 | Python 3.10+ + Milvus Lite | 12.9MB/346 文件 + jieba/sqlite-vec 原生件 | MemOS daemon + HTTP 服务 |
| 成本控制 | Tier-0 ≤800 字符注入；L3 固定预算 ≤20 次 LLM；Agent 裁决零边际成本 | 分级递减注入预算（160→24 字符） | 后台维护任务（成本未量化） | 每步前置召回（成本线性涨） | LLM 辅助调用走 DSH 默认 |
| 治理/门禁 | **288 tests + I1–I23 注入评测 + 4 自研门禁 + CodeQL + 分支保护 + issue→PR** | CI badge（checks.yml） | GitHub Actions test.yml | 未声明 | 审计日志（llm.jsonl/perf.jsonl） |
| UI | 3 页（今日/3D 图谱/卫生）+ 插件面板 + 跟随系统主题 | **9 视图** Memory Palace + 中英俄三语 | 各平台插件 + 只读浏览器 | 图谱工具（无面板） | Runtime viewer（Vite） |
| 特殊机制 | scope 运行时切换（修 DSH 常驻 cwd 错位）、compact 三重条件物理清理、投毒启发式+读路径遮蔽 | 证据门 engram_assess、SM-2 复习、信念体系、op_log 全审计 | Skills-from-Memory（工作流蒸馏成 skill）、后台 PROJECT.md/USER.md 维护 | ruminate 反刍控制 | L2 policy/L3 world model 晋升 |

## 3. 我们的优势（按可防御性排序）

1. **工程治理是独一档**。288 tests、59 个测试文件、I1–I23 注入式评测（去重/冲突/过期/并发/投毒/中文改写全场景）+
   4 条自研质量门禁 + CodeQL + secret scanning + 受保护 main + issue→MR 强制流。对比的 5 家里只有 2 家有 CI
   badge，**没有任何一家公开评测指标**。这是我们相对公司团队（Zilliz/火山/MemTensor）唯一「组织不了」的护城河。
2. **零依赖、零基建**：node 内置 API 跑完全部功能，插件壳 576KB。engram 可选 300MB 模型缓存、memsearch 要
   Python+Milvus、MemOS 要 daemon、prime-memory 带原生绑定。换机/离线/内网场景我们是唯一「clone 即用」。
3. **真相层不可变 + 全链溯源**：bi-temporal 四时间戳、as-of 查询、派生视图字节可重建、L3 强制 sourceRefs、
   裁决走 V1–V5 校验 + 真相层只增（compact 有备份+7 天宽限）。SQLite 系插件 UPDATE 覆盖后历史就没了。
4. **跨客户端是「实测」而非「宣称」**：三端 PASS 脚本在仓内，scope 对齐工具解决 DSH 常驻进程 cwd 固定这个
   本生态特有问题——其它家根本不在 Codex/Claude 上跑。
5. **成本纪律**：注入 ≤800 字符、L3 预算硬上限、裁决复用当前会话的模型（零边际 API 成本）。调研阶段 claude-mem
   的教训（比编码本身贵 64%、单月 649M tokens）就是这一档的反面教材。

## 4. 别人的优势 / 我们的不足（诚实清单）

1. **语义检索缺失（最大短板）**。engram（本地向量+RRF）、memsearch（dense+sparse+rerank）能召回「换了说法的
   事实」；我们词法检索召回不了，只能靠 Agent 裁决回路事后收敛。文档里写的「宁漏不误杀」是真漏。
2. **没有自动捕获**。memsearch/MemOS/prime-memory 从会话日志自动入库，「零努力」；我们依赖 AGENTS.md 规则
   （Codex 那次实测：旧规则下一条不写）。新用户上手摩擦明显更大——这是产品决策（可审计+控成本）换来的，
   但要承认它是体验劣势。
3. **UI 广度差距**：engram 9 视图（信念/陈展/走廊/回填/往事…）、MemOS 有 Vite viewer；我们 3 页。缺「编辑」
   界面（只读是设计，但用户改数据只能走 CLI/Agent）。
4. **无复习/强化机制**：engram 的 SM-2 间隔重复、信念（belief+证据链）是成体系的「主动巩固」；我们的衰减是
   被动半衰期，L3 画像要 Agent 手动跑。
5. **无蒸馏成技能/策略的路线**：MemOS L2 policy、memsearch Skills-from-Memory 把重复工作流固化成 skill；
   我们 L2 只是场景块索引，不产技能。
6. **公司级生态**：memsearch（Zilliz，5 端+Discord+文档站）、OpenViking（火山，server 生态+管理器插件）、
   MemOS（MemTensor）有团队维护速度和多端覆盖；我们单人+用户协作，v0.4 前 npm 未发布、无社区。
7. **单机单库**：JSONL 无多机同步；memsearch 的 Milvus 可集中部署团队共享。

## 5. 对 v0.4 的含义（不立即动手，按指标驱动）

- 候选 A（补检索短板，收益最大）：本地 embedding 道路——沿用 engram 的「可选依赖+降级显式标记」模式
  （transformers.js 小模型，失败回落词法并打 `lexicalOnly:true`），复用既有 RRF 结论（k≈60，无需归一化）。
  触发条件：真实库 noHitRate 持续 >30% 且改写对漏召可复现。
- 候选 B（补捕获体验）：读 reference-session-collector 的只读投影思路，做「会话日志→候选记忆→用户审阅」
  的**半自动**捕获（保留 V1–V5 门禁），不走 prime-memory 的全自动覆盖式蒸馏。
- 候选 C（补 UI 广度）：engram 的「陈展/信念」视图映射我们已有的 supersede 链与 L3 画像，纯前端增量。
- 不做：平台化（server/多机同步/团队共享）——与 C1 本地优先冲突，且是大公司主场。

## 已核事实 vs 自述口径

- 实测（本仓 CI/本机）：sedimem 全列、prime-memory 12.9MB/346 文件（npm 包实测）、三端 PASS。
- README 自述（未核源码）：engram 23 工具/证据门/SM-2、memsearch 5 端/RRF/Skills、MemOS L1–L3/Skill。
- awesome 一句话（未核）：OpenViking/skepsun-engram/lgtm 等。

## 6. 复核与补充（2026-11-10 第二轮，用户要求「看看对不对，还有没有其它」）

复核方式：把上文每条数字和断言回本仓取数（`node --test`、`eval/results/LATEST.json`、`config/policy.json`、
`grep src/`、`plugin/lib/index.js`）。**结论：方向对，但有 1 处数字过时、2 处表述不够准，另有 7 条优势和
8 条不足被漏掉。**

### 6.1 事实核对

| 上文断言 | 复核结果 |
|---|---|
| 288 tests / 59 个测试文件 | ✅ 实测 288 pass / 0 fail，42 suites，59 个 test 文件 |
| I1–I23 注入评测 | ⚠️ **过时：现为 I1–I24**（LATEST.json 的 `cases` 长度 24） |
| 4 条自研门禁 | ✅ `tools/{quality-check,security-check,coverage-gate,windows-smoke}.mjs` |
| p95≈2ms@5000 检索 | ✅ 实测 n5000 search p95 2.48ms（write p95 5.54ms） |
| Tier-0 ≤800 / brief 总预算 / L3 ≤20 次 | ✅ policy：`brief.tier0Chars=800`、`totalChars=8000`、`l3.maxCallsPerRun=20`、`batchSize=10`、`ttlMs=30d` |
| 无向量检索 | ✅ `grep -ril embedding\|vector src/` 零命中 |
| disputed 默认不可见 | ✅ `statusOk(..., {includeDisputed=false, status:'active'})` |
| 「三端实测 PASS」 | ✅ 脚本在仓且改名后最后一次 PASS；表述应更准确为「**仓内可复跑**，不是常驻验证」 |

### 6.2 表述需要收紧的两处

1. **「零依赖」要限定范围**：核心与插件壳零运行时依赖（gate Q1 强制），但**插件面板依赖 DSH 宿主**（slots/renderer），
   `node:sqlite` 后端要求 Node ≥22 且是实验特性。写「零第三方依赖、零外部服务」比「零依赖」准确。
2. **「跨客户端实测」不等于「持续保证」**：三端 PASS 是脚本手工跑出来的，没有 CI 里跑（CI 只有 macOS/Linux/Windows
   smoke），所以三端一致性是「有证据的能力」而不是「有回归保护的能力」。

### 6.3 漏掉的优势（真实且可核）

1. **文本真相层可直接操作**：`grep`/`jq`/`git diff` 就能查改，坏行有 `memo doctor` 结构化诊断（file:line）；
   SQLite 系（engram/MemOS/prime-memory）坏页整库难救，我们做过一次坏 JSONL 的结构化兜底。
2. **记忆系统自身的可观测性**：每次检索落 `search` 事件（存 qHash 不存原文）→ nightly 出 noHitRate /
   staleHitRate / avgTopScore / active 占比 30 天趋势。对比的 5 家里没有一家公开这种「记忆被用得怎么样」的指标。
3. **多分库 + 运行时切库 + 按客户端覆盖**：`memory_scope` + `.scope.<client>.json` 解决「DSH 常驻进程 cwd 固定」
   这个本生态独有问题；engram 有 user/project 双库但没有运行时切库，其它家单库。
4. **自动裁决可解释、可回滚**：ruleJudge 把规则写进 note（`rule:strong+hits(a=9,b=3)`），`--dry-run` 可预演，
   重跑幂等（applied=0）。对手多是「自动覆盖/自动合并」，不解释为什么。
5. **决策日志即工程资产**：`docs/02` 53 条裁决 + 每版本 eval 快照 + CHANGELOG 的 Rejected 段——
   被拒绝的方案也有记录，这对长期迭代比任何单点功能都值钱。
6. **无任何网络调用**（无遥测/无云同步/可选远程 rerank 也没有）= 隐私与内网优势；OpenViking 要 server、
   memsearch 可选 Zilliz 云、MemOS 要 daemon。
7. **版本目录纪律**：`versions/CURRENT` 单点 + 冻结目录 + 门禁只审 CURRENT；对手无版本目录概念（升级只能覆盖）。

### 6.4 漏掉的不足（按严重度）

1. **没有 pre-step 自动注入（我认为这是比"无自动捕获"更严重的短板）**：`plugin/dsh-sedimem/lib/index.js`
   只有 UI 代理与 health 路由，**没有任何 pre-step / systemPrompt 注入钩子**；记忆能不能进上下文，全靠模型
   自觉调 `memory_brief`（靠 AGENTS.md 规则约束）。而 memsearch / OpenViking / prime-memory 都是 pre-step
   自动召回注入。写进去但读不到 = 冷启动会话等于没记忆。
2. **disputed 是隐形黑洞**：同 slot 不同值默认既不进 search 也不进 brief，用户看不到「有争议的事实」——
   对比 engram 有信念视图（成立/待复核/已否定 + 证据链）、mcp-memory-service 有 beliefs 置信度。我们没有
   面向人的冲突展示，只有 `dedupe scan`/`stats.conflictRate` 这种运维视角。
3. **写入字段负担**：完整收益要写 subject/predicate/value/kind/slot；只给 text 会落 unstructured，图谱与去重
   收益大打折扣。对手多数只要 `text + kind`，我们的门槛更高。
4. **分发门槛**：npm 未发布，装法是 clone + `pnpm add file:` + cordis 配置 + 重启；对手 `dsh plugin add` 一条命令。
   收录 PR 还在等审。
5. **规模上限没测过**：bench 只到 n=5000，且每次启动全量重建索引（JSONL 全读 + 内存倒排）；10 万条会怎样
   是空白——engram（SQLite+向量）与 memsearch（Milvus）在这点上是设计上更有余量。
6. **明文落盘、无入库脱敏**：记忆里可能有密钥/内部信息，我们只做「检测可疑 + 读路径遮蔽」，engram 明确写了
   入库脱敏（`[REDACTED:*]` 标记可筛选审计）。
7. **图谱只读且不可搜索**：3 页都是只读，想定位某条具体记忆只能 CLI/Agent；engram 有检索实验台/长廊视图。
8. **无 schema 迁移通道**：大版本换目录靠整体复制 + JSONL 稳定兼容；metrics/views 目录命名暗改过一次
   （metrics 文件名 scope 化），没有正式 migration 工具（只有 compact 的备份）。

### 6.5 修正后的短板排序（供 v0.4 取舍）

`pre-step 注入 > 语义检索 > 自动捕获 > disputed 展示 > 分发门槛 > 规模验证 > 脱敏存储 > UI 搜索`

理由：前三条共享同一个后果——「记忆存在但没用上」；其中 pre-step 注入是用一行钩子就能撬动最大收益的一条，
应作为 v0.4 的第一优先，而不是此前写的「embedding 优先」。
