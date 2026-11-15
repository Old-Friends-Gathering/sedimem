# v1.2 计划对抗审核 01：数据一致性与不变量

> doc-kind: history
> doc-version: 1.2
> 说明：本文件是对特定时点计划/代码的审核快照，内容冻结（引用当时的 versions/v1.1），不随版本升级改写。

- 审核对象：`docs/plans/v1.2-task-context-ledger.md`（106 行）；代码基准 `versions/v1.1`（`versions/CURRENT`=v1.1）。
- 角度：数据一致性与不变量（段区间、anchor、幂等、close 晋升、并发、回滚）。
- 方法：只读代码 + 本机 Node v22.23.2 实测（真实 DSH transcript、write-gate 判定、policy 加载）。未标「未验证」的结论均有代码行号或实测输出支撑。
- 结论：计划方向成立，但按当前写法 **B1 无法通过自己的 I53–I55**——4 条阻断均落在「计划声称已有 / 不在 B1 写盘域」的两类盲区。

## 发现清单表

| # | 严重度 | 证据（file:line / 计划章节） | 影响（失败场景） | 具体改法（含测试） |
|---|---|---|---|---|
| F1 | 阻断 | 计划 §1 L30 `halfLifeMs: null`；`src/config/policy.js:47`（`Number.isFinite(meta.halfLifeMs) && >0`）`:50` 抛 `E_POLICY`。实测 `loadPolicy({kinds:{context:{halfLifeMs:null,…}}})` → `policy: kinds.context must be {halfLifeMs>0, weight>0, color:#rrggbb}` | 任何命令/服务在 import 期加载 policy 即崩：capture/brief/close 全不可用，I53–I57 一条都跑不起来 | 用有限大值（如 `3153600000000`）并注明「近似不衰减」；坚持 null 则必须把 `src/config/policy.js`+`views/decay.js`+`hygiene/quota.js` 纳入 B1 并全消费面处理。测试 `tests/config/policy-context-kind.test.js` |
| F2 | 阻断 | 计划 §1 L34-42：value 含 8 个数组+anchor+7 标量；`src/core/record.js:18`（MAX_TEXT=4000）`:20`（MAX_VALUE=2000）`:42-48`（生效值=min(policy,天花板)，只可调小）`:93-98`（超限 `E_INVALID_RECORD`）；`config/policy.json:126-127` 已钉 4000/2000；§6 L95 B1 不含 record.js | 真实 12 轮段 8 个数组常超 2000 字 → createRecord 抛错；§2-2「close 前未 capture 则拒绝」于是任务永远关不掉；若写者自行截断则 expand 还原丢字段，可逆性名存实亡 | value 只放索引标量+anchor+digest（≤300 字），files/decisions/… 放 text（≤4000）或独立 sidecar JSON（anchor 指向）；capture 写前做字数预算、超限拆多段。测试 `tests/unit/session-capture-value-cap.test.js` |
| F3 | 阻断 | 计划 §2 L57「transcript.js 已能解 zstd 多帧」；实际 `src/session/transcript.js:93` 只有一次 `zstdDecompressSync`。实测本机真实 v4 文件 565,668B 内有 189 个 zstd 帧魔数（帧0=289B session header，帧1=2166B，帧2=229,475B，帧3=135B…）；`readDshTranscript` 实测 `records=1`（仅 `type:"session"`，返回无 turns 字段；`toTurns`(:126) 对 1 条 header 得 `[]`）；且 B1/B2/B3 三批写盘均不含 transcript.js | capture 永远读到 0 条事件 → 空段或 `E_CAPTURE_FAILED`；I54「expand 还原字节与 transcript 一致」不可能成立；即使补循环还需处理「读时宿主仍在追加帧」的边界 | B1 纳入 transcript.js：按帧魔数逐帧解压，返回每帧的压缩字节区间与解压后 seq 区间；对读取快照记录 size+sha256；对尾部不完整帧 fail-closed。测试 `tests/unit/transcript-multiframe.test.js`（真实帧样本） |
| F4 | 阻断 | `src/session/transcript.js:86` slug=`cwd.replace(/[^A-Za-z0-9._-]+/g,'-')`，而真实 DSH 目录形如 `--Users-yeager-work-yeager-ldywoker--`；实测 `readDshTranscript({cwd:process.cwd()})` → `E_TRANSCRIPT_UNAVAILABLE`。`:88` 文件名硬编码 `session.v4.jsonl.zstd`。计划 §0-1 L13 anchor=`{transcriptPath,fromSeq,toSeq,bytes}` 与 §1 L42 `{path,bytes,compressed}` 不一致，无 gen/校验和/失效错误码 | 默认 cwd 下 capture 全部找不到 transcript（失败场景即 I53 用真实路径必挂）；路径含空格/中文同样触发 slug 与 DSH 不一致；DSH 升 v5 全量失效；expand 无「原文已删/已变」的确定语义 | 按 DSH 真实规则实现 slug（去尾斜杠、`--` 包裹、非安全字符→`-`），并对候选目录做存在性校验；anchor 升 v2 `{path,gen,fileSize,fileSha256,decompressedLength,fromSeq,toSeq,fromByte,toByte}`；§0-1 与 §1 统一；失效抛 `E_ANCHOR_STALE`。测试 `tests/unit/anchor-slug.test.js`、`anchor-stale.test.js`（空格/中文 cwd 各一例） |
| F5 | 高 | `src/hygiene/write-gate.js:79-166`：仅 contentHash 相同→`noop_duplicate`；同 slot 异值→decideConflict（`conflict.js` parseComparable 对 JSON value type=null）→`disputed`，`src/api/write-path.js:156-158` 把 disputed 落真相层；实测同 slot 换措辞 → `disputed | values not comparable (next.type=null, prev.type=null)`；计划 §1 裁决115 L50 却写「同内容→noop_same_value」（动作名也错） | 重跑/换 summary 措辞/数组顺序漂移（files 顺序不同即 contentHash 变）→ 生成 disputed 段；coveredSeqs 若只统计 active 则同区间再压一遍；brief/expand 出现重复段、审计污染 | capture 产出确定性字节（排序、时间字段取事件、mode 固定），写前显式判定「同 predicate 已有 active|disputed 段且 toSeq 覆盖」→ 直接 noop，不依赖 0.85 近重复；测试 `i54-recapture-same-summary.test.js`（断言真相层零新增、动作为 noop_same_value） |
| F6 | 高 | 计划 §0-3 L15「capture 前查 coveredSeqs，重叠跳过」+ 裁决115；两步不在同一锁内：`src/storage/lock.js:20-67` withLock 为全局 memoHome 目录锁且**不可重入**（嵌套必 timeout），而 `src/api/write-path.js:113` writeRecord 内部自己取锁 | 两个 agent/两个入口同时 capture 同一任务 → 同 `seg#N` 双写，第二条 disputed（见 F5）；若 LLM 摘要放在锁内（默认 20s×重试）会与 staleMs=30000 竞争，被抢锁后仍可能双写 | 给 writeRecord 增 precondition 回调（在 :113 锁内、decideWrite 之前执行），capture 传入「区间与已存段不重叠」；摘要计算必须锁外完成、锁内只做短校验+写入。测试 `tests/concurrency/capture-two-agents.test.js`（两进程并发，断言只 1 条 active） |
| F7 | 高 | `src/cli/session.js:329`、`src/mcp/session-tools.js:196` 无差别 `svc.forget({reason:'session-closed'})`，仅跳过 meta；计划 §1 裁决116 L51 要求 context 永不因 close 消失；§6 L95 B1 写盘不含这两个 close 文件 | close 一次即把整条任务账本（含其他宿主会话写入的段）墓碑化；若任务库 scope 被多宿主会话共享，第一个 close 使其余会话 `E_SESSION_CLOSED` 且账本消失——账本核心价值归零；而 B1 的 I53–I55 又依赖 close，批次自相矛盾 | B1 纳入两个 close 文件：循环跳过 `kind==='context'` 与 meta；只有 `--purge-context`/任务 remove 才删；补 `i53-close-keeps-context.test.js`（close 后 active context 数不变） |
| F8 | 中 | 计划 §0-11 L23 承诺「写段与更新 `sessions/<id>.json` 要么全成要么不动」；实际 items append（`src/storage/jsonl-store.js:65-70`）与 registry 整文件覆盖写（`src/session/lifecycle.js:101-108`）是两个独立写，无 journal/事务 | 崩在中间：段已写游标未更新→下次重复压（F5 disputed）；游标先写段未写→永久漏段（expand 找不到源）；无自愈路径 | 不存独立游标：coveredSeqs 由段记录自身推导（真相层即游标）；若必须存，先写 capture_intent 再 finalize，启动时 reconcile 残段。测试 `capture-crash-between-writes.test.js`（两写之间 kill） |
| F9 | 中 | 裁决116 L51 称「只有 purge/remove 才消失」；`src/api/write-path.js:247-272` enforceQuota 会淘汰任意 active（含 context）；`src/hygiene/quota.js:59-83` 评分=`kindWeight × hits × recencyDecay × confidence`，段 `hits=0` → 价值 0，在 `selectEvictions`（:104-110）升序里最先被墓碑；`lifecycle.js:297+` sweepSessions 只报告，`session.ttlMs` 无人执行 | 超 `maxActive=5000` 时 context 段被配额墓碑，违反硬承诺；大量已关闭任务库长期占盘（每库数百 KB）无清理 | selectEvictions 排除 `kind==='context'` 与 meta；为 closed 库加显式 archive/配额策略并写进 docs/02；测试 `quota-never-evicts-context.test.js` |
| F10 | 高 | 计划 §7 L106「旧版本读到未知 kind…回滚后 `/api/tasks` 会跳过这些记录」；实测 `/api/tasks` 不读 records：`src/web/api/write.js:150-153` 仅 `listSessions`，`lifecycle.js:385-418` 只回 registry 字段（records=countActiveRecords，无段/token）。真正爆点在 v1.1 写入路径：`src/core/record.js:187` kind 白名单 + `src/api/lifecycle.js:118-120` validateRecord → forget/close 对 context 抛 `E_INVALID_RECORD`，close 在 meta/registry 已置 closed 后中断（cli/session.js:322-331）→ 半关闭态、重跑 alreadyClosed、剩余记录永不清理；§6 无任何批改 versions/v1.1 | 回滚后 close 抛错、任务库残留 active 段、后续写入报 E_SESSION_CLOSED 但账本未清理；计划对风险源的判断错误，返工方向（改 /api/tasks 展示）也错 | 先发布 v1.1.1 兼容包（kinds 加 context、validateRecord 读路径放行未知 kind、close 跳过 context），把「先升 v1.1.1 再上 v1.2；回滚只回 versions/CURRENT」写成发布硬顺序；补 `i58-rollback-compat.test.js`（v1.1.1 上对含 context 的库执行 close/forget 不抛） |
| F11 | 中 | §5 I56 L87 要求「/api/tasks 返回段与 token」；`apiTasks` 现状只回 listSessions 既有字段；改动需 `src/web/**` 或 `lifecycle.listSessions` 扩展，§6 三批写盘均无归属；§0-10 archive 状态位/默认过滤同样无批 | I56 无法转绿，或被顺手改到别人写盘域造成冲突；archive 承诺无实现归属 | 把 listSessions 扩展（segments/tokens/lastCaptureAt）与 archive 过滤明确归 B1（lifecycle.js）或新增 B2 写盘 `src/web/api/write.js`，§6 表格同步 |
| F12 | 中 | §2 不变式 L63「尾部 rawTailTurns=12 不压」+ §2-2 L60「close 前未 capture 且有新内容→拒绝」 | ≤12 轮短任务的新增全在尾部 → 可捕获区间为空 → capture 无事可做但 close 被拒，任务永远关不掉 | close 语义改为「可捕获区间为空即放行」；或 close 路径允许压尾部；测试 `i55-close-short-session.test.js` |
| F13 | 低 | §6 B1 L95 写 `tests/unit/capture*.test.js`，但仓库已有 `tests/unit/capture.test.js` 与 `tests/injection/i28-capture.test.js`（inbox capture 域） | glob 撞名，agent 可能改错/覆盖既有用例 | 改名 `tests/unit/session-capture*.test.js`、`tests/injection/i53-session-capture.test.js` |
| F14 | 高 | §1 L33 同时有 `sessionId` 与 `hostSessionId`，未定义 seq 命名空间；实测真实 transcript 事件 seq 为宿主会话内单调（帧1起 seq 0/7/15…）；同一任务库跨两个宿主会话时都从 0 起，而 coveredSeqs 按单调整数比较 | 跨会话接力（计划核心场景）第二个宿主 capture 时要么被误判「全重叠」而漏段，要么重复压同一 seq 区间；expand 的 fromSeq 与段语义错位 | 引入 `segKey=(hostSessionId, seq)` 或任务级单调段号，coveredSeqs 按 hostSessionId 分组；anchor 的 fromSeq/toSeq 明确为宿主 seq。测试 `cross-host-session-seqs.test.js` |

## 攻击点覆盖对照

| 攻击点 | 结论 |
|---|---|
| ① 区间重叠/漏段（重跑、跨会话、追加后重跑） | 成立：F14（命名空间）、F6（非原子）、F8（崩溃）、F5（幂等不成立）、F3（漏帧即漏段） |
| ② anchor 失效（压缩后偏移、会话清理、空格/中文路径） | 成立且当前已坏：F3（只解首帧）、F4（slug/文件名/anchor 契约）；未验证项见下 |
| ③ 幂等 | 不成立：F5；且 §1 裁决115 的动作名写错（实际是 noop_duplicate） |
| ④ close 晋升 vs context 段并存 | slot 冲突**不成立**（context 不在 `session.promoteKinds`，predicate `seg#N` 独立）；真实风险是 F7（close 全量墓碑）与 F9（配额淘汰/膨胀） |
| ⑤ 并发（两 agent capture、观察台同读） | capture 侧成立：F6；观察台并发读**已排除**：`jsonl-store.js:92-129` 只消费到最后一个换行，半行留待下次，不会读到半条记录 |
| ⑥ v1.2 回滚 v1.1 未知 kind | 计划描述错误，真实故障更重：F10（commit 白名单抛错→close 半关闭；`/api/tasks` 根本不读 records） |

## 我认为计划必须改的 3 条

1. **重写 §1 数据模型，让它服从现有写侧硬约束。** `halfLifeMs:null` 会让整个进程加载 policy 即抛 `E_POLICY`（F1）；value 里的 8 段数组撞 2000 字硬上限且 B1 无权改 record.js（F2）。改：有限 halfLifeMs + value 只留索引/anchor/digest，正文进 text 或 sidecar；同时把 policy 校验点、decay/quota 对未知 halfLifeMs 的行为写成 B1 验收项。
2. **把 transcript 读取与 anchor 契约提到 B1 第一项交付，并换掉「已能解多帧」这句事实错误。** 真实文件是 189 帧而代码只解 1 帧（F3）；slug 与真实 DSH 目录不一致导致默认 cwd 直接 `E_TRANSCRIPT_UNAVAILABLE`（F4）。不改这两处，I53/I54 必然假绿或必挂；anchor 需升 v2（gen/sha256/字节区间）并定义 `E_ANCHOR_STALE`，§0-1 与 §1 统一。
3. **把 close 与回滚做成独立验收项，并修正 §7 的错误论断。** B1 必须纳入 `cli/session.js`、`mcp/session-tools.js` 才能实现裁决116（F7）；回滚的真实爆点是 v1.1 写入白名单而非 `/api/tasks`，需先发 v1.1.1 兼容包并写成发布硬顺序（F10）；§6 同时补 `/api/tasks` 段字段与 archive 的写盘归属（F11）。

## 未验证 / 已排除（避免误报）

- 未验证：DSH 是否会在 capture 期间轮转或重写 `session.vN`（只观测到帧数从 177 增到 189，追加式假设未证伪）；close 后任务库是否允许 reopen（v1.1 无 reopen API，计划未声明新增）；v1.1.1 兼容包是否还有别的消费面依赖 kind 白名单（import/export/dedupe/stats 未穷举）。
- 已排除：观察台并发读半条记录（见 ⑤）；`/api/scopes` 泄漏 session（`web/scopes.js:44-46` 已跳过，I56 该子项天然满足）；close 晋升 slot 冲突（见 ④）；path 直接落成文件名导致非法字符（items 文件名走 `paths.js`，不直接用 cwd）。
