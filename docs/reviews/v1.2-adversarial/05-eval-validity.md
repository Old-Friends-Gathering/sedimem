# v1.2 对抗审核 05：评测有效性（最容易被自己骗的一环）

> doc-kind: history
> doc-version: 1.2
> 说明：本文件是对特定时点计划/代码的审核快照，内容冻结（引用当时的 versions/v1.1），不随版本升级改写。

审核对象：`docs/plans/v1.2-task-context-ledger.md` §5（I53–I57 + 四组对照）。方法：只读代码 + 本机真实 transcript 探针（逐帧解压、import `versions/v1.2/src/session/transcript.js` 实跑、读 eval/i50/policy）。未改任何仓库文件；本文是唯一产出。严重度：P0=该问题可让评测结论整体失真；P1=结论可信度显著受损；P2=工程与统计缺陷。

**总判**：§5 的 I53 在当前形态下是**自证测试**（capture 写什么、断言读什么）；更糟的是真实链路存在三个硬阻断（slug 不匹配、多帧只解首帧、v4 事件形状不认），所以 I53 只要用合成 fixture 就必然全绿，而生产 `--auto` 召回为 0。

## 发现清单表（严重度 / 证据 / 影响 / 修法）

| # | 严重度 | 证据（file:line 或实测） | 影响 | 修法 |
|---|---|---|---|---|
| 1 | **P0** | 计划 §5 L84 让测试自己构造会话写入再断言；同模式先例 `tests/injection/i50-session-handoff.test.js:33` 自写 decision「决定把 W9 收口拆成两个 PR」、`:42-43` 自写 `intent='收口 v1.0'`/`nextSteps=['发版']`，`:69-70` 直接 `md.includes('收口 v1.0')`；`handoff.js:54-59` 把 decision 的 title/text 原样拼入交接文，`checkpoint.js:94-121` 只把宿主 summary 文本搬进 currentState | 测的是「写入→搬运→读出」管道自洽，不是「新会话能否接上」；摘要内容完全无用也能 100% 通过；抽错/漏抽/抽了噪音都无法暴露 | ground truth 在 capture **之前**由独立 author 从原始 transcript 生成并冻结哈希，capture 不可读题集；断言器只拿 brief、禁止 import capture/checkpoint；断言字符串不得与 fixture 原文相同（同义改写/上位表述）；加干扰项与 ABS（应拒答）题；断言器输出「命中/漏/错/幻觉」四态而非单一布尔 |
| 2 | **P0** | `transcript.js:86` 用 `cwd.replace(/[^A-Za-z0-9._-]+/g,'-')` 得 `-Users-yeager-work-yeager-ldywoker`；实测 `ls ~/.dsh/sessions` 全部 5 个 slug 是 `--…--` 形状（本仓库 `--Users-yeager-work-yeager-ldywoker--`）；实跑 `readDshTranscript({sessionsRoot,cwd:'$HOME/work-yeager/ldywoker',sessionId:'f44fe42b…'})` 抛 `E_TRANSCRIPT_UNAVAILABLE: DSH 转录不存在` | 真实会话 `--auto` **100% 读不到**（181 个本仓库会话全中招）；I53 若只用 `--file` 合成 fixture 则全绿而生产零召回；叠加 §2 L60「close 前强制 capture」，真实会话 close 会被永久拒绝（capture 恒失败→提示命令→再失败） | 按 DSH 真实规则拼接 `--${rawPath.replace(/[/\\]/g,'-')}--`，并以「列 `sessionsRoot` 子目录 + 读首帧 `session.cwd` 反查」容错，多候选取 mtime 最新；错误信息列出候选目录；I53 至少一条用例走 `--auto` 真文件 |
| 3 | **P0** | `transcript.js:93` 单次 `zlib.zstdDecompressSync(zipped)`；实测 1.24MB 文件含 **624 个** zstd 帧（magic `0x28B52FFD`），单次调用只解出 289B / 1 行（`type:"session"` 头），逐帧拼接得 3.63MB / 1437 事件；计划 §0 L13 与 §2 L57 却声称「`transcript.js` 已能解 zstd 多帧」 | 即使 slug 修好，`turns=0` → capture 恒空；而 I53 的合成单帧 fixture 会通过 → 评测有效性彻底失效；⑤ 真实回放不可行 | 以 magic 切帧逐帧解（保留 frame 边界与 byte offset）；把 L57 改成「待实现」并在 B1 加「真实文件读取契约测试」（与独立解压实现逐帧比对，样本含最大 22.15MB 文件） |
| 4 | **P1** | `transcript.js:19-47` 只认 `user_message`/`assistant_message` 或 `payload.role+content`；实测 v4 记录为 `{"type":"user/message","data":{"content":[{"type":"text",…}]}}`、`assistant/message` 在 `data.message.content` 且含 `reasoning` 块 | 修完 #3 仍 0 turn；若只改 type 名，reasoning 会被当正文污染抽取 | 增加 v4 分支并只取 `type==='text'` 的块；用 20 行真实金样做快照测试；定义「有效 turn」= user/assistant 的 text block |
| 5 | **P1** | 计划 §5 L89 只列组名，无 token 预算/模型/温度/提示模板/seed/题序；`eval/run.js:119-146` 只看子进程退出码、全文无 arm/repeat/CI 概念；简报本身有截断（§3 L68 Top5/Top10、L72 注入 ≤1200 字符） | 组间差值可由「哪臂注入更多 token」解释，不能归因到账本；跨轮/跨模型不可比 | 臂配置化（同模型、温度 0、同模板、固定题序 seed）；每臂注入预算统一 ≤1200 字符（按字符「渲染-测量-递减」，参考 claude-mem ContextBudget）；每臂 ≥5 seed；预算不匹配的臂直接判无效 |
| 6 | **P1** | 计划 §5 L89 四组=无账本/只晋升/+checkpoint/+context，**没有 host-resume 臂，也没有 full-transcript 上界**；`docs/research/context-handoff-methodology-2026.md:146` 的对照组是 a 只 brief / b 全量 transcript / c 什么都不给，`:183-184` 要求「handoff ≥ full-transcript−ε 且 > brief-only+δ」——计划未沿用 | 只能证明「多记了一份，信息更多所以更好」，无法证明「比宿主 resume 好」或「同样信息更省 token」；这正是攻击点③ | 加 arm H=DSH 原生 compact+resume（同 transcript/模型/预算）；加 arm F=full-transcript 截断到同预算（上界）；判据=等预算下 fidelity 不劣于 H 且 token 成本更低；题集按「host 能否答」分层，只在 host-missing 子集上比较 |
| 7 | **P1** | 计划 §5 L84「3 决策/2 卡点/3 文件（100% 匹配）」= n=8，二项 95%CI 约 ±30pp；research L183 还要求 KU 与 abstention，计划双双丢失 | n=8 无法区分 100% 与 62%；「100% 字符串匹配」奖励字面复述、惩罚正确摘要，且无「不该出现的信息是否出现」的检查 | 分 4 类题（LongMemEval KU/TR/MR + ABS），60 题/6 会话；文件路径与命令 ID 精确匹配，决策/卡点走 rubric judge；通过线：文件/命令 100%，决策 recall≥0.8、precision≥0.9、KU 100%、ABS 幻觉≤5%；报 Wilson 区间与逐会话分布 |
| 8 | **P1** | 计划 §0 L24 只记 `captureTokens`、§4 L77 只有 UI 统计条；`policy.json` 无 eval/audit 段；`eval/run.js:274-280` 只有布尔 gate，无历史趋势 | 段越积越空、重复决策增多、anchor 失效都无机制发现，直到接力失败才暴露（「账本慢慢腐化」） | 月度审计脚本（独立重算，不采信 capture 自报）：段覆盖率、空段率、跨段决策重复率、anchor 失效率（expand 404）、brief 命中率（下会话前 3 步是否调 brief）、陈旧文件率、token 成本比、holdout 准确率；每项设阈值，连续 2 月越线告警并触发回滚预案 |
| 9 | **P1** | 计划 §0 L13 `anchor:{transcriptPath,fromSeq,toSeq,bytes}`、§1 L42 `anchor:{path,bytes,compressed:true}` 无 offset/length；`transcript.js:126-133` `toTurns` 丢弃 seq 与偏移（真实记录其实有 `seq`） | I54「expand 还原字节与 transcript 一致」没有可执行定义：实现者只能比 turn 文本（假通过）或比压缩文件字节（无法从 seq 定位）；字节空间也未定义 | anchor 改为 `{frameStart, frameEnd, byteOffset, byteLength, sha256}`，并明确字节空间=逐帧拼接后的原始 JSONL；I54 断言 expand 输出 sha256 与截取区间相等（先写参考截取器再写 expand） |
| 10 | **P1** | 计划 §5 L89「差值进 CI」但全篇无 δ/ε 数值；research L184 明确 δ/ε 由首轮基线定、之后只收紧 | 无阈值的 CI 门禁永远绿（或靠人肉解释），回归不可见 | 首轮基线冻结 `eval/baseline.json`（各臂均值/方差、题集 hash、模型与 DSH 版本 hash）；CI 断言 current ≥ baseline−1.96σ 且 context-vs-负对照 ≥ δ；模型/预算变更须 bump 基线版本并显式登记 |
| 11 | **P2** | `eval/run.js:64-117` 固定 case 列表、`:119-146` spawn `node --test` 看退出码、`:274-280` 布尔 gate；无臂、无重复试验、无响应缓存 | LLM 类用例 flaky、成本不可控、结果不可复现，无法承载「差值进 CI」 | 新增 `eval/arms.mjs`（臂配置/预算/seed/缓存 key=prompt+model hash）；LLM 用例只在 nightly 或 `eval:llm` 标签跑，结果 JSON 落 `eval/results/` 供趋势对比 |
| 12 | **P2** | `policy.json:161` `dailyLimitCny=5`、`:162-165` 价 0.8/2.8 元每 M tokens、`:166-179` purposes 只有 derive/curate/checkpoint/brief（无 capture/eval）；计划 §2 L59 新增 capture purpose 但 §7 L105 仍沿用 `llm.dailyLimitCny` | 按估算，174 会话×10 题×3 repeat（每题约 1.2K in/0.2K out）≈16 元 > 5 元/日，回放中途被限流，缺失样本会被误读成「capture 质量差」 | eval 使用独立预算命名空间（purpose=eval、独立日限/离线 key）；先抽 54 会话（≈5–6 元）；报告 missing 率 >5% 则整轮无效 |
| 13 | **P2** | 计划 §1 L38 的 value 含 `hostSessionId`；但 `lifecycle.js:215-223`/`:235-243` 登记字段无 `hostSessionId`，全仓 grep 只有计划与 research 两处 | 真实回放无法 join「memo 会话 ↔ DSH transcript」，只能靠 cwd+mtime 猜；I53 也无法复现真实入口 | 登记文件加 `hostSessionId`（`--auto` 时由参数/环境取得并写入段），补 manifest 导出（sessionId, hostSessionId, cwd, mtime）；无 hostSessionId 的旧会话只走 `--transcript` |
| 14 | **P2** | `web/scopes.js:44-46` 已 `continue` 跳过 `session:` scope —— I56 的断言在 v1.1 今天就成立；§3 L68 简报只给 Top10 文件/Top5 决策坑 | I56 不构成 v1.2 增量证据；I53 fixture 若只放 3 决策/3 文件，必然被 Top5/Top10 全量收录 → 被截断策略「保送」 | I56 标注为回归守卫；I53 fixture 放 ≥8 决策/≥15 文件，断言集须包含故意落在 Top5 外的项；若被测 brief 有选择策略，就断言「被选中项必须正确」+「未选中项不得被编造」，而非「全部项必须出现」 |

## 最小可执行评测矩阵与判定阈值

| 层 | 数据 / 臂 | 指标 | 通过线 | 频率 |
|---|---|---|---|---|
| L0 读取器契约 | 20 个真实 transcript（含最大 22.15MB）+ 独立逐帧解压参考实现 | turns/事件计数、seq 与 frame 边界存在性 | 计数 100% 一致；0 异常；`--auto` 端到端 10/10 成功 | PR |
| L1 I53 断言注入 | 6 个受控会话 ×10 题（含 1 KU、1 ABS、1 干扰） | 文件/命令精确匹配；决策 recall/precision；ABS 幻觉率 | 文件/命令 100%；recall≥0.8；precision≥0.9；幻觉≤5% | PR |
| L2 四臂对照 | 无账本 / 只晋升 / +checkpoint / +context，同预算 ≤1200 字符、同模型、温度 0、5 seed | 题集准确率（macro） | context ≥ 只晋升 +15pp，McNemar p<0.05 | nightly |
| L3 上界与负对照 | full-transcript（同预算截断）/ 他任务简报（同预算） | 同上 | context ≥ fulltr −5pp；context ≥ 负对照 +15pp（负对照≈基线，否则实验作废） | nightly |
| L4 host-resume | DSH 原生 compact+resume（同 transcript/模型/预算） | 等预算 fidelity + 每题 token 成本 | fidelity ≥ H；成本 ≤ H；host-missing 子集上必须显著更好 | 每 release |
| L5 真实历史 holdout | 54 会话（≥3 turn，时间切分），题集冻结 hash | 逐会话 macro 准确率、ABS、missing | ≥0.75；missing ≤5%；会话级 bootstrap 95%CI 下界 ≥0.65 | 每月 |
| L6 腐化审计 | 全账本 | 发现 #8 的 8 项指标 | 各项阈值内；连续 2 月越线告警 | 每月 |

## 真实历史回放（174 会话）可行性与设计

实测：`~/.dsh/sessions` 共 192 个 session 文件（**≥3 个 assistant turn 的恰好 174 个**，与任务书数字一致），压缩 69.1MB，逐帧解压 199.4MB / 73,969 事件 / 10,258 assistant turn / 11,055 tool call；单文件最大 22.15MB。结论：**离线可行，但必须先修 #2/#3/#4，且只能用 `--transcript` 入口**（`--auto` 未通，见 #2）。

1. 快照：corpus 复制到 `eval/corpus/<date>/`，记每文件 sha256 + turns/事件数，冻结后不再变（防止新会话混入）。
2. 切分：按 mtime 时间切 120 训练/调参 + 54 测试；测试集在题集冻结前不看。
3. 出题：独立 author agent 只读 transcript（**不看 brief**），每会话 10 题（3 决策/2 卡点/2 文件/1 next step/1 旧决定被改 KU/1 ABS），带 event seq 证据；人工抽检 20%。
4. 冻结：`questions.json` 先登记哈希，**再**跑 capture（防止对着题改抽取）。
5. 作答：只喂 brief（≤1200 字符），温度 0，3 repeat；judge 用不同模型，20 条人工校准，κ≥0.8 才采信。
6. 报告：逐会话 macro 准确率、ABS、missing、brief/capture token 成本；会话级 cluster bootstrap 95%CI；不达 L5 阈值即 fail。
7. 成本：54 会话 ×10 题 ×3 ≈ 1620 次作答 + judge ≈ 5–6 元（按 policy 报价与 1.2K in/0.2K out 估），需独立 eval 预算；全量 174 会话每轮约 16 元（见 #12），不建议放 CI。

## 我认为计划必须改的 3 条

1. **I53 去自证**（§5 L84）：ground truth 前置冻结 + capture 与断言器代码隔离 + 干扰/ABS 题族 + 四态评分；阈值改「精确项 100% + recall/precision + Wilson CI」，并把 I53 的 fixture 从「测试内自写」改为「题集文件」。这是本次唯一可能让整个 v1.2 结论作废的问题。
2. **先打通真链路再谈评测**（§2 L57、§5）：修 slug（#2）、多帧解帧（#3）、v4 事件形状（#4），并把「真实 transcript 读取一致性」设为 B1 准入门禁；I53 必须至少一条 `--auto` 真文件用例，禁止只用合成 fixture 判过，否则 §5 的绿灯与生产召回 0 可以同时成立。
3. **对照实验补公平性契约与双基线**（§5 L89、§6 B3）：等 token 预算 + 同模型/温度/模板/seed + 负对照臂，补 host-resume（H）与 full-transcript（F）基线，δ/ε 首轮冻结后只收紧，全部落到 `eval/arms.mjs` + nightly + `eval/baseline.json`；否则「差值进 CI」无法判 fail，也无法回答「是不是比宿主 resume 更好」。

## 未验证 / 边界（明确标注）

- DSH transcript 的保留/GC 策略未知，#8 里「anchor 失效率」是否会真实发生**未验证**。
- #12 的成本按 `policy.json:162-165` 报价估算，实际账单与限流行为**未验证**。
- 复盘/审计指标中「brief 命中率」需宿主侧埋点，当前仓库无该埋点，落地成本**未验证**。
