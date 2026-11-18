# 02 · 证据范围与删除语义（v2.0 规格草案）

> doc-kind: contract
> doc-version: 2.0
> status: planned

状态：**planned**——冻结前允许修订。来源：[future-architecture.md](../../plans/future-architecture.md) §3.3/§4.1；施工映射 [v2.0-p1.md](../../plans/v2.0-p1.md) §2 冻结决策 2。

## 1. 证据快照 = 可删来源缓存

- 候选的 `evidence` 引用的**来源内容快照**（规范化后的切段文本）是缓存，不是真相层；可独立删除。
- 真相层（items.jsonl）永远只存引文（quote ≤200 字）与 hash，不存完整来源正文——P0b quarantine 语义的延续。
- 快照缺失 ≠ 数据损坏：候选仍可凭 span+hash 在原文件重新定位；重新定位失败 → 证据标 `stale`（见 §4）。

## 2. 规范化算法

来源文本规范化后才计算 offset 与 hash：

1. **解码**：按 UTF-8 解码为字符串；offset 单位 = **Unicode 码点**（不是字节、不是 UTF-16 code unit——JS 的 `String.length` 按 UTF-16，工具实现必须用码点遍历或显式换算并测试多字节样例）。
2. **换行统一**：CRLF → LF；孤立 CR → LF。规范化后一个换行 = 一个码点（U+000A）。
3. **不做的变换**：不去空白、不做 NFKC、不改标点——正文 hash 必须可复现，任何「顺手清理」都会破坏 span 定位。
4. **事件边界**：每个 eventId（消息）独立规范化；span 相对「该事件规范化后的文本」定位，evidence 同时带 eventId + span + 该事件文本的 sha256。
5. **多字节/emoji 样例**：保护测试必须包含中文、emoji（surrogate pair）、组合字符（combining sequence）各 ≥1 例，断言 span 切出的子串与原文逐码点相等。

## 3. sourceEpoch 撤销语义

- `sourceId + epoch` 唯一标识一次授权导入。撤销（删除来源）= epoch 失效：
  - **新读面过滤**：所有读取面（search/pack/复核 list）过滤失效 epoch 的候选与记录——但真相层记录不物理删除（v1.4 deleteBySource 语义延续：显式删除才有物理删除）。
  - **新候选禁止**：失效 epoch 上不得接纳任何新候选；在途抽取结果禁用。
  - **禁止自动重新 capture**：撤销后系统不得自动重读外部原文件重建快照；重新导入必须显式授权**新 epoch**（用户动作，非系统恢复动作）。
  - **证据快照清理**：失效 epoch 的快照进入保留期倒计时（逐资产登记表见 §8，数值在数据地图冻结），到期删除；删除验收用 §5 框架。

## 4. 源文件变化（offset stale）

- 定位规则：span 只对**与 capture 时相同内容的源文件**有效（inputHash 匹配）。
- 源文件变化后：**offset 禁止悄悄重定位**（禁止 fuzzy re-anchor）。定位失败时证据标 `stale`，展示层明确「原文已变化，此证据无法在当前文件复现」，绝不静默换一个看似相近的 span。
- hash 匹配但内容被替换的对抗情形由 inputHash 覆盖：hash 不匹配 = stale，无例外。

**stale 证据的接纳与装配门禁（硬条款，对齐上位 §3.3 防线②「证据不完整或已删除，阻止接纳及装配」）**：stale 不是展示层标注了事——

1. **accept 提交时**：必须在同一数据锁内对候选全部 evidence 重新解析 span 并重算 hash 匹配（CAS 三元组中的 `evidenceHash` 校验**与本条款协同**——它是客户端预期值等值校验，不替代重解析判定，见 01 §3）。任一证据 stale、快照缺失且无法重新定位 → **阻止接纳**：候选转 `failed`（`evidence-unsupported`），或退回人工重新圈定证据后以新候选版本重走复核。工具必须提供且只提供这两条路径，不存在「带 stale 证据 accept」的第三条路。
2. **装配读取面**（检索/pack，P1c 生效、P1a 冻结语义）同样过滤携带 stale 证据的候选与记录。
3. 复核界面（CLI `candidates show`）对 stale 证据显式标注并禁用 accept 入口，防人工在不知情下确认。

## 5. 删除语义（对 v1.4 verify-delete 的扩展）

删除一个来源（或 scope）时：

| 动作 | 语义 |
|---|---|
| trust 不延长保留 | 记录/候选被 trust promote **不改变**其删除保留期——信任不是豁免权 |
| 禁止新候选 | 失效 epoch（§3）禁止接纳新候选 |
| 禁用在途结果 | 进行中的抽取运行在提交前被拦截；已产出未 accept 的候选批量 cancelled（理由=source-revoked） |
| 清除可删派生正文 | 证据快照、模型请求/响应缓存、pack 缓存（P1c 起效，本文件冻结语义）按保留期删除 |
| pack 不回注 | v2.0 pack 即使 systemAsOf 早于删除时刻，也**不得**重新注入已撤销来源的内容（P1c 生效、P1a 冻结） |
| 审计 | 删除事件进 events.jsonl 哈希链，**只含状态与 ID，无正文** |
| 历史取证隔离 | 需要审计级历史取证时走显式隔离接口（独立权限），不混入常规读取面 |

**验收**：v1.4 `verify-delete` 扩展覆盖 §5 全部新资产与读取面（候选/快照/缓存/复核记录），逐资产出核对清单。

## 6. 数据级回滚（本文件负责，对照计划 §8 仓库级回滚）

管线各阶段的可回滚性：

| 阶段 | 回滚方式 |
|---|---|
| capture/切段 | 游标回退 + missingRanges 重放；快照可重算（同 inputHash 幂等） |
| 抽取（LLM） | 重放产出相同 candidateId → noop；无脏数据残留 |
| accept 提交 | 提交点前的失败无副作用；提交点后的修复走修订链（superseded），不物理回滚真相层 |
| trust promote | v1.4 已有 supersede 链回滚；promote 记录带理由可审计 |

原则：**真相层永不物理回滚**，错误修正走 v1.4 既有纠错语义（supersede/disputed）；只有缓存类资产允许删除式回滚。

## 7. 脱敏主体

脱敏占位符 `[REDACTED:*]` 不代表同一实体：两个 `[REDACTED:EMAIL]` 不得合并为同一主体、不得跨候选建立 about 关联。占位符只证明「此处有敏感信息」，不承载身份。

## 8. 逐资产保留期登记表（冻结决策 2 的验收框架）

上位 §4.1 与计划 D1-02 要求逐资产登记保留期、条数/字节上限与扫描路径。本表**框架与验收列现在冻结**；数值列由 P1b 施工时填入 docs/12-data-map.md 并回填本表——数值落位前相应资产的管线不得启用（fail-closed）。[05-threshold-manifest.md](05-threshold-manifest.md) 只冻结评测阈值、不承载保留期数值（消除引用悬空）。

| # | 资产 | 保留期 | 条数/字节上限 | 扫描路径 | 删除验收 |
|---|---|---|---|---|---|
| 1 | 证据快照 | P1b 定 | P1b 定 | P1b 定 | §5 表 + verify-delete 逐资产清单 |
| 2 | 候选引文（quote ≤200 字） | P1b 定 | P1b 定 | P1b 定 | 同上 |
| 3 | 拒绝样本（rejected 候选） | P1b 定 | P1b 定 | P1b 定 | 同上（评测负例导出后方可删） |
| 4 | 模型请求/响应缓存 | P1b 定 | P1b 定 | P1b 定 | 同上 |
| 5 | 复核记录（复核 decisions） | P1b 定 | P1b 定 | P1b 定 | 同上（审计链保留状态与 ID，无正文） |
| 6 | 游标/收据（cursor + acceptOpId receipts） | P1b 定 | P1b 定 | P1b 定 | 同上（收据缺失触发 recovery-required，见 01 §3） |
| 7 | pack（canonical + 运行元数据） | P1b 定 | P1b 定 | P1b 定 | 同上（P1c 生效） |
| 8 | 审计（events.jsonl 哈希链） | **不删除**（append-only） | — | P1b 定 | 哈希链 verify 完整性，不适用删除 |
| 9 | 备份 | P1b 定 | P1b 定 | P1b 定 | 同上 |
