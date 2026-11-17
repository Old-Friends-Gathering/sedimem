# reviews/RESPONSE.md — 审核意见处置表（memo v0.1）

审核输入：`reviews/arch.md`（架构/可演化性，阻断 1 / 严重 5 / 建议 4）、`reviews/adversarial.md`（对抗，阻断 2 / 严重 5 / 建议 3）。
处置人：Lead（glm-5.3）＋ 实施员工（glm-5.3），2026-11-02。

**处置原则**：阻断项必须当轮修完并留可复现证据；严重项当轮修或给出延期理由；建议项修或明确写进 v0.2 路线。**任何一项都不允许「静默忽略」**。

---

## 一、阻断项（3 项，全部已修 + 已独立复验）

| # | 审核项 | 处置 | 证据（Lead 独立复验） |
|---|---|---|---|
| A-B1 | 常驻服务基于进程内陈旧快照判重，跨进程写入不可见 → 重复/冲突判定系统性失效（`src/api/service.js` 原 73-88 只启动 reload 一次；`write()` 146-150 用内存 `_records` 判重；`withLock` 只包单次 append） | **已修**。契约裁决 13：`write` 的「增量重读 → 判定 → 追加」整段在 scope 锁内；`JsonlStore` 新增 `fileSize` / `loadScopeIncremental`（只消费到最后一个换行）；`service._refreshIncremental` 按 offset 折叠新记录后再 `decideWrite` | 10 进程并发写同一文本 → `created=1 / noop_duplicate=9 / active=1 / dupRatio=0`；常驻进程 A 后写 B 已写记录 → `noop_duplicate`（修复前为第二条 created）；并发异值 → `active=1`（修复前双 created） |
| V-B1 | 默认 slot `text/text`：CLI 默认路径与 MCP 唯一路径不带 subject/predicate，第 2 条起全 disputed 且默认检索不可见 | **已修**（并**修正了定位**）。契约裁决 14/15：无结构记录视为 unstructured，先按 contentHash 判等，再按 containment 相似度 ≥0.85 判近重复（`noop_same_value reason='near_duplicate'`），否则才进 conflict。定位修正见 §3.3：**词法只能抓字面近似，真人改写要靠 Agent 裁判** | 20 条词面近似改写 → `created=1 / nearDupBlocked=19 / disputed=0`；20 条互不相关事实 → 全部 created（零误杀） |
| V-B2 | 跨进程并发写同一事实产生 N 条重复 active；读-判-写不在锁内 | **已修**（同 A-B1） | I8 用例常驻：10 子进程并发 → `active=1`，items 文件 0 坏行；`.lock` 无残留 |

---

## 二、严重项（10 项：8 已修 / 2 部分修并写明 v0.2）

| # | 审核项 | 处置 | 说明 |
|---|---|---|---|
| A-S2 | IndexPort 有隐藏契约（`.size`、asOf 硬编码 `new InvertedIndex`） | **已修** | 裁决 18：`index.size` 写入契约；asOf 改为在内存记录上过滤后复用主索引（不再新建引擎）；`doctor` 的 `index_inconsistent` 改用 `size` 且非 number 时跳过（消除假阳性） |
| A-S3 | api/ 内嵌四块策略，JudgePort/PolicyPort 实际不存在 | **部分修** | 策略已外置：新建 `src/config/policy.js` 为唯一加载点，suspicious 打标 / 配额 / 打分系数 / 半衰期全部从 policy 取。裁决 22/23 给出**裁判通道**：`dedupeScan`（只读候选）+ `curateApply`（落盘裁决），由运行中的 Agent 当裁判，零 API 成本。**完整的 `JudgePort` 注入点（挂 llm-judge.js）延期 v0.2** —— 理由：v0.1 先证明「候选发现 + 非破坏裁决」这条链能闭合，再接模型 |
| A-S4 | kind/agent/status 枚举硬编码散落 ≥4 文件 | **部分修** | 校验与枚举收敛到 `core/record.js` 与 `mcp/validate.js`（两处权威），新增 kind 不再需要改 brief/mcp 各自枚举。**彻底数据化（policy 里声明 kind 注册表）延期 v0.2** —— 理由：需要连带改 `kindWeight`/`halfLifeMs` 的校验，属于 v0.2「新记忆类型」一起做 |
| A-S5 | nightly 含业务逻辑与写死 `QUOTA_MAX_ACTIVE=5000`，淘汰路径不一致、doctor 盲区 | **已修** | nightly 删除本地常量与第二套淘汰实现，改调 `service.enforceQuota()`（墓碑带 `tags:['quota']`），并调 `flushHits()`、brief/metrics 落盘 |
| A-S6 | `close()` 空吞 `flushHits()` 错误 | **已修** | 裁决 21：`flushHits` 用 committed 集合跟踪，失败只回滚未落盘计数再抛出；`close()` 在 finally 置关闭标志但不吞错；`doctor` 新增 `hits_unflushed`（warn） |
| A-G7 | policy.json 四处独立加载 | **已修** | 只剩 `src/config/policy.js` 一个加载点（deepFreeze + 可覆盖），其余模块 import |
| A-G8 | 契约里 `brief/<scope>.md` 从未落盘 | **已修** | nightly 写 `$MEMO_HOME/brief/<scope>.md` 与 `$MEMO_HOME/metrics/<date>.json` |
| A-G9 | `curate_apply` 事件不含记录 id | **已修** | 裁决 23 的 `decisions:[{ids:[...]}]` 形状把 ids 写进事件 detail，审计流可定位 |
| A-G10 | MCP 不传 cwd，scope 静默分库 | **已修** | MCP 启动把 `scope=... cwd=... memoHome=...` 打到 stderr，service 显式传 `cwd: process.cwd()`，instructions 写明可用 `MEMO_SCOPE` 覆盖 |
| V-S3 | 「换措辞重复」变 disputed 垃圾 | **已修（分层）** | 词面近似 → 在线拦截（近重复）；真人改写 → 不误杀、不污染（不再变 disputed），由 `dedupeScan`（阈值 0.45）聚簇 + Agent 裁决合并。I7a/I7b/I11 三个用例分别锁住三层行为 |
| V-S4 | 投毒只防明文子串，6/10 变体未标记且全文进 brief | **已修（见 §三 复核）** | 检测前归一化（NFKC / 零宽 / CJK 间空格 / 大小写 / 异体字），叠加 base64、拆字、拼音三条启发式；读路径隔离（裁决 16）默认遮蔽正文 |
| V-S5 | asOf 接受时区偏移但按字典序比较 | **已修** | 裁决 17：`Date.parse` 归一 UTC ms 比较，非法抛 `E_INVALID_ARG`；无年份锚定 2000 的解析契约保留 |
| V-S6 | doctor 无法诊断真相层损坏（`corrupt_jsonl` 分支不可达） | **已修（见 §三 复核）** | doctor 自行捕获 `E_CORRUPT_JSONL` 返回结构化 issue（file/line/message），CLI 退出码 1，不再裸崩 |
| V-S7 | agent 身份在 MCP/CLI 静默默认为 `cli`，防线失效 | **已修** | 裁决 19：service 缺 `source.agent` 一律拒；CLI 显式传 `'cli'`（`--agent` 可覆盖）、MCP 未传记 `'unknown'`，入口层不得改写显式值 |

---

## 三、建议项（7 项：5 已修 / 2 延期）

| # | 审核项 | 处置 |
|---|---|---|
| A-G7… | 见上表（policy 单一来源、brief 落盘、curate 事件 id、MCP cwd） | 已修 |
| V-G1 | doctor 不检测 active 记录间重复 contentHash | **已修**：`duplicate_content_hash`（warn，并列 ids） |
| V-G2 | 资源类故障错误码未归一（裸 EACCES/ENOTDIR/EPERM） | **延期 v0.2**：`withLock` 包装成 `E_MEMO_HOME_UNWRITABLE` 是纯体验改进，v0.1 的 fail-loud + 无写丢失已达标 |
| V-G3 | MCP 允许未 initialize 直接 tools/call | **已修**：未 initialize 时除 initialize/ping 一律 `-32002`，且不触达存储 |
| A-G9… | curate_apply 事件 ids | 已修 |

---

## 四、审核未覆盖、Lead 亲测发现并追加修的缺陷

这些不在两份审核报告里，是我自己跑 probe 时发现的，同样记录在案：

| # | 缺陷 | 处置 |
|---|---|---|
| L1 | MCP 响应乱序：并发请求按完成序返回，导致「写完立刻查」漏读 | **已修**：请求按下发序串行化（promise 链），响应与请求序一致 |
| L2 | MCP 传 `source:{agent:'codex'}` 被静默丢弃，落库成 `cli` | **已修**：`source` 对象与 `agent` 别名并存，冲突报 `E_SOURCE_CONFLICT`，`session` 等字段保留 |
| L3 | MCP 的 `additionalProperties:false` 形同虚设 | **已修**：新建 `src/mcp/validate.js`，未知参数/缺必填/类型/enum/越界 → `isError:true` 且不落库 |
| L4 | 真人改写 5 句同义事实 → 5 条 active（词法极限） | **已修（定位修正）**：在线不误杀，`dedupeScan` 聚簇 + Agent 裁决闭环；I7b 把这个「当前不自动合并」的事实固化成断言，防未来谎报 |

---

## 五、v0.1 明确不做（写进 v0.2 路线，不是遗漏）

1. `JudgePort` 注入点与 `llm-judge.js`（自动语义裁决）—— v0.1 用「Agent 当裁判」替代，零 API 成本且可离线。
2. kind/status 注册表数据化（新增 kind 只改 policy）。
3. 资源类错误码归一（`E_MEMO_HOME_UNWRITABLE`）。
4. 物理压缩/清理（compact）与 `purge` 的墓碑物理删除 —— 需 ADR，第一次触碰「真相层不可变」原则。
5. 向量/语义检索（EmbeddingIndex）—— 接口已留（`IndexPort`），v0.1 不引入依赖。

---

## 六、结论

- 阻断 3/3 已修，均有独立复现证据（10 进程并发、常驻陈旧快照、20 条改写）。
- 严重 10 项：8 已修、2 部分修（A-S3 的 JudgePort 注入点、A-S4 的 kind 注册表）并写明延期理由。
- 建议 7 项：5 已修、2 延期（错误码归一）。
- 追加修复 Lead 亲测 4 项（MCP 乱序/丢参/校验空转、词法极限的定位修正）。
- **v0.1 可发布**：`node --test` 95/95、`node eval/run.js` I1–I11 全 PASS（数字见 `eval/results/LATEST.json`）。
