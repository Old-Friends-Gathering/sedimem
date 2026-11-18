# 规格包对抗审核报告（docs/design/v2.0/ + eval-manifest）· 2026-11-18

> doc-kind: history
> doc-version: 1.4

对象：分支 `p1a/design-spec` 上的 v2.0 规格包（01–06 + adr-101/102 + pilot/p1a/config/eval-manifest.json）。
方法：GLM-5.3 双独立实例对抗审核（审核者一 = schema/幂等/删除视角；审核者二 = 标注/评测口径视角），对照上位 [future-architecture.md](../../plans/future-architecture.md) 与 [v2.0-p1.md](../../plans/v2.0-p1.md)。环境仍无独立第三方审核通道（LLM port provider=none），push/PR 前独立双审核为保留门禁。

## 结论

- 审核者一：**不通过**（1 blocker + 3 major + 3 minor）
- 审核者二：**不通过**（1 blocker + 4 major + 4 minor）
- 合计 16 条（2 blocker + 7 major + 7 minor），**全部修订**（见下表）；修订后跑 R2 delta 复核。

## 审核者一发现与修订对照

| 编号 | 严重度 | 发现 | 修订 |
|---|---|---|---|
| F1 | blocker | 02 §4 stale 证据只有展示层标注，缺「stale/快照缺失阻止接纳与装配」硬条款，违反上位 §3.3 防线②；实现者可按字面做出「展示 stale 但仍可 accept」 | 02 §4 新增硬条款：accept 时同锁内重解析全部 evidence span 并重算 hash（CAS evidenceHash 为机制载体）；任一 stale/缺失 → 阻止接纳（转 failed evidence-unsupported 或人工重新圈定）；装配读取面过滤 stale；复核界面禁用 accept 入口 |
| F2 | major | 02 §3 保留期指向 05/数据地图但 05 无保留期条目（引用悬空）；缺逐资产登记表（拒绝样本/游标收据/备份三项缺失） | 02 新增 §8 九类资产逐行登记表（框架与验收列冻结、数值 P1b 填、fail-closed）；05 §2 尾加范围声明（保留期数值归数据地图，manifest 只冻结评测阈值）；02 §3 引用改指 §8 |
| F3 | major | 01 缺模型差异候选修订语义（candidateVersion 何时自增、同 runKey 跨模型输出如何落为修订而非新事实、重放与修订判定边界） | 01 新增 §3.1 修订语义：同 runKey 重放 = noop；跨运行/跨模型 = 新 candidateId + relations.kind=supersedes；candidateVersion 只由工作流操作触发；判定边界 = configHash+model 变化；P1b 两条路径各写协议测试 |
| F4 | major | 04 §6 queryTime 条款比上位 §7.2 窄——gold/标准答案/人工后处理/评测员说明混入抽取输入的口子未在规格层关死 | 04 §6 改为显式禁入清单（gold、queryTime 后事件与纠正、人工后处理、评测员说明逐项排除）+ 抽取输入清单随 runId 固化落盘可审计 |
| F5 | minor | manifest corpus/runsPerConfig/bootstrap 多条缺 `rollback` 字段；source 引用口径不统一 | manifest v2：全部数值条目补 rollback；source 统一指 04 §3（人读镜像 05 §2）；manifestVersion 1→2 并记 revisionNote |
| F6 | minor | 01 §2 failed 注「重试生成新 candidateId」与 §3「同 runKey 同输入 → 同 candidateId noop」张力 | 01 §2 加澄清：输入/模型/配置未变 → 同 ID noop；变化才产生新 ID（§3.1） |
| F7 | minor | relations.targetId=null 语义未定义（supports/contradicts 指向空是什么） | 01 §1 加唯一合法含义：目标出现但无法解析为允许集合 ID（弃权），必附 unresolvedReason（cross-range/alias-unresolvable/ambiguous），计漏抽统计；其余情形禁止 null |

## 审核者二发现与修订对照

| 编号 | 严重度 | 发现 | 修订 |
|---|---|---|---|
| F1 | blocker | 06 §1 gold 字段表缺断言框架字段（speechAct/negated/about/condition），七类严重错误 #3/#4/#5 无法从 gold 机判，`severeErrorEscape: block-on-any` 出口红线不可计算 | 06 §1 gold 表补 `assertion` 行（四子字段与候选 01 §1 一一对应、机判路径注明）；status 枚举加 `not-done`（支撑 #5）；§1 明确机判对应关系 |
| F2 | major | shouldReject 枚举不覆盖对抗类期望（注入/工具失败/截断/指代无字段承载），拦截率分子不可算 | 06 §1 新增 `expectedOutcome` 字段（block / emit-with-flag + expectedErrorClass），对抗 10 类期望全部由此承载 |
| F3 | major | 对抗配额「每类 ≥10」未限定 test 集，与上位「每类 test 至少 10 例」矛盾；校验会放行对抗全落 dev 的语料 | 05 §2 表与 manifest v2 显式 `exitScope: "test"`（pilot 作用于全集并注明 pilotScope） |
| F4 | major | TP 匹配裁决流程、同 gold 多候选 tie-break、子/超集命题计分口径三项未定义，直接改变 P/R | 04 §2 新增匹配裁决块：人工裁决+版本化存档；tie-break = 证据更完整者优先，仍无法区分 → gold FN + 候选 FP（保守计分）；子命题 → FN+FP，超集 → FP，裁决记录标注类型 |
| F5 | major | mixed 语言场景归组未定义，影响中英分别达标判定 | 04 §2 新增 mixed 归组：成绩同时计入 zh/en 两组（两组独立达标），配额另算不占中英名额；manifest minMixedLanguage 加 scoringNote |
| F6 | minor | 双标注流程未禁止裁决人兼任标注人 | 06 §2 独立性清单加裁决人回避条款（维护者若标注则另指派裁决人） |
| F7 | minor | pilot 「不得宣称达标」无 fail-closed 硬校验 | 04 §5 加 pilot fail-closed：stage=pilot 时 scorer 拒绝输出 pass/fail 结论（硬校验） |
| F8 | minor | manifest `minTestZh/minTestEn` pilot 值键名带 Test 但 pilot 未切分，语义含混 | manifest v2 加 `pilotScope: "full"` + pilotScopeNote（pilot 未切分 dev/test，配额作用于全集）；05 §2 表同步注明 |
| F9 | minor | 04 §4「正确拒绝/标错」措辞歧义 | 改为「正确拒绝或正确标记为错误」 |

## 审核者一核验通过面（抽样记录）

manifest 与 05 表数字逐项一致；对抗 10 类、七类严重错误、闭集 6 类三处一致；失败枚举七类+finish_reason、CAS 三元组、持久收据、missingRanges、recovery-required、锁边界均落地；02 删除红线四条完备；03 与 01 状态机无矛盾；06 双标注独立性定义完整；D1 内容要点 30 行逐行对照仅 3 项缺口（即 F1/F2/F3）。

## R2 delta 复核（2026-11-18，glm-5.3 独立实例 r2-spec-delta）

- R1 十六条核验：**16/16 全部落地**（文件:行级证据，含两 blocker）。上位一致性抽查 8 项全部一致或更严（无更宽松偏离）。
- 新发现 1 major + 3 minor，判**不通过**：
  - **N1 major**：01 §3 写入幂等（candidateId 只含内容四元组）与 §3.1「模型/配置变化天然走新 ID」矛盾——跨模型同 claim 时两条条款给相反结论，provenance 归属未定义。**已修**：判定边界改写为「模型/配置变化**且 claim 规范化形式不同** → 修订路径；claim 相同 → noop，provenance 以首写为准」；明确 candidateId 派生不含 model/configHash 是重放幂等的关键不变量；P1b 协议测试必含「跨模型同 claim → noop + provenance 不变」用例。
  - **N2 minor**：manifest 与 05 §2 镜像三处漂移（minGoldClaims source 错指 04 §3、minScenariosTotal.pilot=40 未入 05 表、revisionNote 自述与实际不符）。**已修**：05 表补 pilot ≥40；manifest source 改指上位 §7.1（语料行）/D3；revisionNote 改写。
  - **N3 minor**：06 expectedOutcome 笔误「对应对」→「对应的」。**已修**。
  - **N4 minor**：02 §4 括注「CAS evidenceHash 即机制载体」过强（CAS 是预期值等值校验，不替代重解析判定）。**已修**：改「与本条款协同——它是客户端预期值等值校验，不替代重解析判定」。
- 正面扫描其余无恙：04/06 对抗口径自洽、02 §5/§8 互补不冲突、manifest 合法 JSON 且 16 项数值与 05 §2 一致。

**终态**：R2 全部意见（1M+3m）修订完毕。

## R3 delta 终核（2026-11-18，glm-5.3 独立实例 r3-spec-final）

- 结论：**通过**。R2 全部 4 条修订逐项落地核验（文件:行级证据）：N1 判定边界与 §3 写入幂等无矛盾、派生公式一致；N2 三处镜像一致（一处可选润色备注不构成问题）；N3/N4 措辞到位。
- 一致性抽查通过：01 §3.1 与上位 §3.5 一致且**更严**（同 claim → 连新候选都不产生）；修订链与状态机 superseded 迁移一致；failed 澄清口径一致。
- 新问题：0（blocker 0 / major 0 / minor 0）。

**终审结论**：R1（2B+7M+7m）→ R1 修订 → R2（16/16 落地 + 1M+3m 新发现）→ R2 修订 → R3 通过。规格包达到可冻结候选状态，进入 push/PR 流程（独立双审核仍为 push/PR 保留门禁）。
