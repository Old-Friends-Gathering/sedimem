# 未来架构计划：对抗检查与修订记录

> doc-kind: history
> doc-version: 1.4

日期：2026-11-18。对象：[当前未来计划](../../plans/future-architecture.md)、调研、现行契约及直接相关源码。
输入：[修改前原文快照](baseline.txt)（SHA-256：`723b56f11c0426c8025d19699a4dc8d0dd18ab42a446e9984cdc484fc429b1cb`）。仓库源码基线：`e7c93d0115b0fb57e65ac07bc7cc69b1ee7af220`，审查时有上一轮未提交的计划/调研变更。

## 结论与范围

**文档级检查通过，可进入 P1a；本轮未发现剩余 blocker/major。**先发现问题、修订，再对修订项和覆盖范围进行反例复核，不把格式门禁当成架构正确的证据。

执行方式：**单 agent 多视角检查 → 修订 → delta 复核 → 最终通读**。没有执行独立 sub-agent/GLM 审核：用户既有子代理约束为 GLM-5.3，本环境未提供该独立审核能力，本机 LLM port 当前 provider=none；未擅自启用出站，也未用其它模型冒充。此结论不替代 push/PR 前的独立双审核。

本次不评审已实现的 v2.0（尚不存在），不声称精度或性能达标，不使用分数代替证据。修订全部为计划约束；API/schema/故障测试的具体实现必须在 P1a 冻结并由后续阶段验证。P1a 的准备工作可以开始，P1b 完成/P1c 放行仍有明确门槛。

## 第一轮：13 项确认问题及修订

严重性在**计划层面**定义：blocker = 按原稿实施会违反核心不变量；major = 关键协议/实验条件缺失，会导致实现分叉或结论无效。下表“关闭”指文字约束已闭合，不表示未来运行行为已验证。

| ID / 级别 | 原稿证据与反例 | 处置 / 修订位置 | 复核状态 |
|---|---|---|---|
| A01 blocker | baseline §3.3/§4：接受不提升 trust，却未给可信 facts 的可达路径。当前普通 write 无论传 T0 都得到 T2；实现可能空 facts 或悄悄洗白 | 明确 accept 后仍 T2；只有第二个独立、带理由的 promote 才可能进入可信 facts，批量接受逐条展示，T3/隔离扣留；§3.3、§5 | confirmed / 文档关闭；探针验证当前 T2 行为 |
| A02 major | baseline §3.2：模型抽取的 validFrom/validTo 与现行记录版本字段同名。“今天得知去年开始”可能穿越回去年 asOf | asserted* 业务时间与系统可见时间分开；§3.2 | confirmed / 文档关闭；探针验证现行 asOf |
| A03 blocker | baseline §3.1/§3.3：候选、事实、审计、游标跨文件，“幂等”无提交点。事实写成而 accepted 未写即崩溃，重试可能再写 | acceptOpId、CAS、锁外调用模型、单提交点、恢复与故障窗口测试；§3.5 | confirmed / 文档关闭；未来实现必须跑 crash/concurrency |
| A04 major | baseline §4：只用 truth revision 失效。仅 ledger/checkpoint 更新、trust 改变或检索模型更换时可复用旧 pack | 列出完整缓存输入清单，构建前后比修订，禁止 hits 影响；§4 | confirmed / 文档关闭 |
| A05 major | baseline §3.4/§7：保存请求响应/引文却未扩删除范围。旧 snapshot/replay 可把撤销来源带回；脱敏占位符也可能合并不同人 | 新资产数据地图、sourceEpoch/撤销、读取面过滤、verify-delete 扩展、明确逻辑删除与物理保留边界、占位符不得作实体键；§4.1 | confirmed / 文档关闭 |
| A06 major | baseline §7：固定模型/预算，但未隔离标准答案、query 后事件，亦未防反复调 test | queryTime 输入边界、评分器隔离、test 暴露后转 regression，新 holdout 才能再谈泛化；§7.2 | confirmed / 文档关闭 |
| A07 major | baseline §7：200 claims 的 Wilson 及 3 次运行可误当独立样本；过滤失败可隐藏分母；gold 漏标与严重错误判断不清 | 三层评分、TP/FP/FN 一对一、失败计缺失、聚类区间、语言分项、零输出不得通过；§7.1 | confirmed / 文档关闭 |
| A08 major | baseline §5/§7：预算没约定最终序列化范围，metadata/围栏可能超额；回执 runId/time 会破坏逐字节复现 | 精确 tokenizer、完整 payload、宿主预算边界、estimated 仅预览、canonicalPack 与运行元数据分离；§5 | confirmed / 文档关闭 |
| A09 major | baseline §6.3：先更新现行 docs/02 再进入新版本，会使 CURRENT=v1.4 却混入未来契约；P1a 冻结项不完整 | 独立 v2.0 planned 草案及开工冻结清单，CURRENT 切换时再同步现行规格；§0.4/§6.3 | confirmed / 文档关闭 |
| A10 major | baseline §9：只关功能便退回 v1.4，旧客户端会忽略新增撤销/evidence 约束 | 停 v2.0 写进程、隔离新数据，从独立迁移前快照只读回退，兼容矩阵/恢复失败阻止切换；§9 | confirmed / 文档关闭 |
| A11 major | baseline §8：复用 LlmPort 却没给 extract/verify 用途、截断识别、跨进程成本闸门；当前目的与额度不等于适合新任务 | P1a 冻结新用途/限额，完整 chunk 开销、finish_reason、成本预占与结算、源配额、精确 tokenizer ADR；§8.1 | confirmed / 文档关闭 |
| A12 major | baseline §7：独立 gold、完整 UI、单人维护有实际资源要求，却未给无法满足时的阶段边界；实验组可能获不等人工帮助 | 无独立标注只做 pilot；CLI 最小首发；人工成本计入；所有实验组共享同一人工/信任结果；§0.4/§7/§8.1 | confirmed / 文档关闭 |
| A13 major | 现行 docs/02 §3.24.1 仍把 trust 的权威指向已重写 future plan §4.1；会错误解释新的证据删除段为 trust 定义 | 改指保留的历史定义，并明确现行行为以本契约为准，不改字段语义 | confirmed / 引用修正 |

## 第二轮 delta：6 项新增/残留歧义

| ID / 级别 | 反例 | 最终修订 | 状态 |
|---|---|---|---|
| D01 major | “P1b 放行须协议测试与精度达标”可误读为未实现 P1b 就先达标的循环门禁 | 分开 P1b 开始条件与 P1b 结束进入 P1c 条件，gold 原型不代表放行；§0.4 | 文档关闭 |
| D02 major | noop/merge 已完成，但单独 op 收据未写就宕机，单凭稳定 acceptOpId 仍无法证明目标 | 无法判定时 recovery-required，核持久化决定/目标版本，不盲重试；指定该窗口故障测试；§3.5 | 文档关闭 |
| D03 major | 把证据快照当不可删事实，或到期后从外部源自动再读，会绕过保留期；提升 trust 不应延长授权 | 快照可删除、到期同撤销、禁止自动重读，保留延长需显式策略变更；§4.1 | 文档关闭 |
| D04 major | “问题发生前”可能误排除问题发生后、提问前合法纠正 | 明确 queryTime 截止，提问前纠正可用、提问后不可见；§7.2 | 文档关闭 |
| D05 major | T2 经结构化后仍能在字符串中携带恶意指令，仅围栏/JSON 不能保证工具安全 | 标明数据不授予权限、隔离段不得 expand 绕过，Agent demo 只读，stub/canary 验证零外写/出站；§5 | 文档关闭 |
| D06 major | “latest checkpoint 控制当前状态”可能使模型自动总结的一句“已完成”越过候选/信任规则 | checkpoint 只作待核对来源；currentTask 肯定断言适用同一证据/接纳/trust 规则，不以分区名绕过；§5 | 文档关闭 |

合计确认 19 项，含 2 blocker、17 major；全部在计划层面修订。无真实模型调用，无凭据读取/输出，无外部沟通。

## 反证与未纳入的“伪问题”

- “有精确原文就等于事实为真”：驳回。原文仅证明出处，原计划已经指出这一点；本轮补的是协议和实验条件，没有把出处当正确性保证。
- “必须现在换图数据库/引入 GraphRAG”：证据不足，不作为 finding。现有存储/port 足以支持计划验证，额外依赖仍由错误分析触发。
- “LLM 每次都必须逐字相同”：驳回。确定性只约束冻结输入后的 canonicalPack/后处理，模型采样另报多次运行。
- “精度 98% 与零严重错误相互矛盾”：不成立。重复/无记忆价值误抽等非严重错误可计 FP；严重事实错误门槛更严格。补充分层评分以消除误读。
- “没有模型精度实验就不能审核计划”：不成立。可以审核计划是否有闭合条件；但不能因此宣称模型达标，报告已限定仅进入 P1a。

## 最终覆盖复核（桌面演练，不冒充已实现测试）

| 反例 | 修订后必须产生的结果 | 依据 |
|---|---|---|
| 接受 T2 候选，未点提升 | 可保存未验证引用，不进入可信 facts；不能静默升 T0 | §3.3 |
| 今天记录去年事实，下周计划尚未执行 | 系统 asOf 不穿越；业务时间独立，计划不是完成 | §3.2 |
| 两进程同时接受；事实已写而审计失败 | CAS/幂等映射；不再写第二条；显示恢复/审计未完成 | §3.5 |
| 仅 checkpoint 更新，旧 pack 已缓存 | checkpointRevision 改变，旧缓存无效 | §4 |
| 模型自动 checkpoint 声称完成，但无确认 | 不因“最新”写成 currentTask 肯定断言；保持未验证引用/待核对 | §5 |
| 删除来源时 LLM 正在返回；旧 asOf 请求 pack | 在途结果不能接纳；普通 pack 不重新注入撤销来源 | §4.1 |
| 原文过期；相同脱敏占位符来自不同主体 | 拒绝依赖旧证据；不合并主体、不擅自重取原文件 | §4.1 |
| 被测模型全拒绝、输出被截断 | precision 未定义/失败留分母，召回下降，不通过 | §7.1 |
| test 标准答案可被 Agent 文件工具读取 | 实验无效，输入/权限隔离；不得报 holdout 成绩 | §7.2 |
| 只有 pack 组获得人工 gold 和 trust 提升 | 实验无效；所有对照组可用数据一致 | §7.2 |
| 预算只数正文，回执有变化时间 | 精确预算含全部 memory payload；运行时间不进 canonicalPack | §5 |
| 精确 tokenizer 不可用、semantic-disabled | 只可预览/降级试跑，不报精确混合检索效果 | §5/§8.1 |
| v2.0 写入后直接启动 v1.4 | 禁止共目录回退；停新进程、旧快照隔离只读 | §9 |

最终通读覆盖：来源授权、分段、候选、角色/时间、人工决定、trust、提交/重放、纠错、删除、缓存、检索、装配、评测、成本、版本切换、回滚和恢复入口。未发现剩余计划级 blocker/major；实现仍可能失败，必须由后续故障测试与效果门槛阻断。

## 已执行验证与保留边界

- 直接读源码/契约确认：`core/trust.js` 普通写 T2、`docs/02` 的版本时间语义、`api/delete-path.js` 删除范围、`session/ledger-brief.js` 聚合逻辑、`llm/port.js` 用途及粗估限制、ADR-002 的 hits 约束。
- 在临时独立 MEMO_HOME 运行合成契约探针：普通写入自报 T0 仍为 T2；validFrom 等于注入的提交时钟；较早 asOf 返回空，共 3 条断言通过。未写真实项目 facts。
- 文档改动检查：quality、security、docs-drift、`git diff --check`（结果见下方最终记录）。未修改运行源码，不以历史全量测试成绩冒充本次验证；未运行 v2.0（不存在）或真实模型性能实验。
- 独立 GLM 双审核未执行，作为 push/PR 前保留门禁；本次不提交、不 push、不创建 PR、不部署、不启用常驻/外部模型。

### 最终检查记录

- 最终计划 SHA-256：`2476ea5bfdf82114abc12d1c90850f0a76ebddc4ce361193357ccfc610640160`。输入快照 SHA 校验与原文一致。
- `node tools/quality-check.mjs`：15/15 通过（包括站内链接）；原有导出契约覆盖提示仍由既有门槛判定，未改门禁。
- `node tools/security-check.mjs`：9/9 通过。
- `node tools/docs-drift-check.mjs`：无 finding，CURRENT=v1.4。
- `git diff --check`：通过；CURRENT、运行源码未变。
- 快照最初放在 Markdown 子目录时相对链接不成立，Q6 正确阻断；改为原文字节不变的 `.txt` 证据附件后重跑通过，没有豁免门禁或修饰原始输入。
- 原任务库追加审核结论与 checkpoint，保持 open；恢复入口仍是 P1a，不自动进入实现或发布。
