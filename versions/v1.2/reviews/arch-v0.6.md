# arch-v0.6 — 架构与契约一致性审核（v0.6.0 @ 93adccb）

审核方式：通读写路径 / session / MCP / UI 相关源码 + 4 个可执行探针（`reviews/probes/arch-probe{1..4}-*.js`，全部实际运行取证）+ 全量测试（458 pass / 0 fail）。

# 结论（阻断项 yes/no）

**yes** —— 2 条阻断项。

## 阻断项

### B1. MCP close 晋升目标未校验 session scope：session-in-session 链会把已「晋升」的 decision/gotcha 当场 tombstone，静默丢数据

- **现象**：`memory_session_start` 在当前 scope 已是 `session:*` 时（触发路径真实存在：`memo session start` 的输出明示用户 `请把它设为当前写库（如 MEMO_SCOPE=session:<id>）`，用户照做并重启 MCP 进程后 `initConnScope` 从 env 解析出 session scope；`memory_scope use` 因 SCOPE_PATTERN 不含 session 走不到这条，但 env 这条够用）走 lifecycle 的 reuse 分支，`meta.parentScope = service.scope = session:<id>`（自身）。MCP close 的 `mainScopeFor`（src/mcp/server.js:545-551）**不校验 parentScope 是否 session**，直接返回它 → `main === svc`（同一个库！）→ 晋升写回自身 → 随后 ④ 的 tombstone 循环把所有非 meta active（**含刚晋升的 decision/gotcha**）全部 forget，返回值仍报「晋升 N 条」。
- **CLI 对比**：`src/cli/session.js:195` 有校验（`isSessionScope(parentScope)` → 报错拒绝晋升），MCP 侧漏了同样的检查——同一 close 契约两条实现一条防了一条没防。
- **复现**：`node reviews/probes/arch-probe2-session-in-session.js`
- **证据输出**：
  ```
  [2] inner session scope = session:20261113-1913-8cbb parentScope = session:20261113-1913-8cbb
      parentScope 是 session scope? true
  [4] MCP close 将晋升到 mainScope = session:20261113-1913-8cbb （=== 自身 scope? true）
  [5] tombstone 后被丢弃的记录（含刚「晋升」的 decision）: ["decision:选方案B"]
  [6] inner 库剩余 active: 1 → decision 是否存活: false
  ```
- **建议修法**（双保险）：
  1. `closeSessionTool` 里与 CLI 对齐：`if (!mainScope || isSessionScope(mainScope)) throw E_INVALID_ARG`；
  2. 根因侧 `startSession`（src/session/lifecycle.js:105-111）：reuse 分支不应把 session 自身当 parentScope——要么拒绝（`E_INVALID_ARG`，提示用绑主库的 service start），要么从既有 meta 反查原 parentScope。
- **影响面**：MCP 五个 memory_session_* 工具的 close 数据完整性；一旦触发，decision/gotcha 无声丢失且报告成功。

### B2. supersede 完全绕过写侧粒度契约，且丢失旧记录的 title

- **现象**：`supersedeRecord`（src/api/write-path.js:178-190）调 `createRecord` 时只传 `{ clock: svc.clock }`，**不传 policy、不传 title、不跑 recordWarnings**。后果三连：
  1. `write.textHardMaxChars` 对 supersede 不生效（回落硬编码 4000）：policy 调小（如 500）后 write 拒 3000 字，supersede 照样落盘；
  2. `titleEnforce=true` 对 supersede 不生效；
  3. supersede 生成的新记录**不带旧记录的 title**——有 title 的记录被 supersede 一次，brief/图谱的行首就从可扫读 title 退回 `subject · predicate`，正好破坏本版 W1「title 优先」的交付目标。
- **复现**：`node reviews/probes/arch-probe1-supersede-bypass.js`（策略限 500，supersede 3000 字成功）+ `node reviews/probes/arch-probe4-supersede-title-loss.js`（title 丢失）
- **证据输出**：
  ```
  [3] supersede 换成 3000 字 value/text（policy 限 500）:
      !!! supersede 成功落盘, text.len = 3000 tags = []
  ---
  [1] 原记录 title = "包管理器选择"
  [2] supersede 后新记录 title = undefined (titleEnforce=true 也未报错)
  ```
- **建议修法**：supersedeRecord 与 writeRecord 对齐——`createRecord({... , title: old.title, ...}, { clock: svc.clock, policy: svc.policy ?? POLICY })`，并补 `recordWarnings` + `long-form` tag（warnings 可不进返回值，但 tag 该打）。默认 policy（4000）下第 1/2 点不可见，但契约写的是「从 policy 读」，supersede 就是绕过。
- **影响面**：所有人工/自动 supersede 调用方；v0.7 把 titleEnforce 翻默认 true 时此洞会直接可见。

## 严重项

### S1. checkpoint 绕过写门禁直接 `_commit`：同 slot 多条 active 堆积，session 库 brief 被重复 checkpoint 行淹没

- `writeCheckpoint`（src/session/checkpoint.js:130-148）为绕开 `noop_same_value` 直接 `_commit`，但**没有把上一条 checkpoint 置 superseded**——每次 checkpoint 都新增一条 active。brief 对每条 active 各渲染一行 `- [state] session · checkpoint`，N 次 checkpoint = N 行完全相同的行，挤占 `brief.lines` 预算（长会话里 decision 行反而被截掉）。sessionStatus 的 `checkpoints` 计数同样只增。close 时虽然全部 tombstone（先报告后丢弃无碍），但 session 存续期间的 brief——即临时库的主要消费面——被污染。这也违反了「同 slot 一条 active」在其余写路径上由 decideWrite 维护的不变式（hygiene/dedupe、tier0 折叠等都假设该不变式成立）。
- 复现：`node reviews/probes/arch-probe3-checkpoint-flood.js`；证据：
  ```
  [1] 6 次 checkpoint 后 active 记录数 = 7 其中 checkpoint active = 6（同 slot 多条 active = true）
  brief：6 行一模一样的 `- [state] session · checkpoint  (as of 2026-11-13)`
  ```
- 修法建议：writeCheckpoint 在锁内先对既有 active checkpoint 记录补一条 superseded 版本（与 write-path 的 supersede 落法一致），或至少在 brief 渲染层对同 slot 去重只留最新。前者保住不变式，更对。

### S2. `validateRecord` 的 text 上限仍硬编码 `MAX_TEXT=4000`，policy 只能调小不能调大

- src/core/record.js:152：`if (r.text.length > MAX_TEXT)` 不读 policy。部署若把 `write.textHardMaxChars` 调到 5000 并写 4500 字：`createRecord` 的 wp 检查通过，随后同函数内的 `validateRecord` 用硬编码 4000 拒绝——policy 提升上限被自己的校验层否定，两个「单一真相源」打架。修法：`validateRecord` 接受可选 policy/kinds 注入（与 createRecord 同款兜底），或至少注释固化「policy 上限只能 ≤4000」并在 policy 加载时校验。

## 建议项

1. **MCP memory_write schema 硬编码漂移**：src/mcp/server.js:115 `text: '≤4000 字'` 写死在描述里，policy 调整后描述失真（与「策略真的从 policy 读」的方向不一致）。
2. **value 无长度上限**：`createRecord`/`validateRecord` 只限 text；checkpoint 的 8 段 JSON（currentState 可为大段摘要）或 close ② 的 handoff value 可以无限大落盘。建议给 value 一个宽松硬顶（如 4×textHardMaxChars）防真相层被单条撑爆。
3. **close 晋升静默加 long-form tag**：`main.write` 会给 value>valueRecommendChars 的晋升记录打 `long-form`——语义可接受，但 handoff/交接类记录几乎必然超 300 字，tag 噪声较大，可考虑对 session 晋升路径豁免或在文档说明。

## 已确认没问题的点

- **其它写入入口不绕门禁**：capture accept（src/capture/queue.js:195）、migrate-dsh-memory（src/cli/migrate-dsh-memory.js:135）全部逐条走 `service.write`；MCP memory_write 经 facade → `svc.write`。V1–V5 门禁、脱敏、投毒打标、粒度契约在这些入口均生效。curate/maintenance 的 `_commit` 只作用于既有记录的衍生版本，kind 不变，属设计内。
- **session 禁 fact 门禁位置正确**：`assertWritableKind(svc.scope, input.kind ?? 'fact')` 在 `writeRecord` 入口（src/api/write-path.js:62），kind 缺省与 createRecord/recordWarnings 一致按 'fact'；MCP/CLI/capture 写 session 库的 fact 都会被拦（测试「主库 scope 写 fact 不受门禁影响」等 266 项在跑）。
- **残留硬编码清理干净**：grep 全 src 仅剩 `MAX_TEXT=4000` / `DEFAULT_VALUE_RECOMMEND_CHARS=300`（兜底常量本体）与 S2 所述的校验点，无别处硬编码 300/4000。
- **UI scope 粘性**：ui/app.js 所有 `location.hash` 赋值（6 处）均经 `hrefFor` 携带 scope，无手拼 hash 残留；graph 按 `scope` 变化重建实例（app.js:410-415）；切分库 hash + localStorage 双写；`resolveScope` 四级回落 + fallbackReason。W3 方向无发现。
- **锁模型无竞争**：`withLock` 是 memoHome 级单锁（storage/lock.js:21 `path.join(memoHome, '.lock')`），session 库与主库共用同一把跨进程锁；close 内 main.write / svc.write / svc.forget 顺序 await，无双 service 死锁窗口。
- **close 幂等与骨架保留**：already-closed 提前返回；tombstone 循环保留 closed meta；晋升循环跳过 meta/checkpoint 骨架；坏 checkpoint 不阻断 close（只缺交接底稿）。
- **扩展点未波及**：commit 93adccb 的 src 改动不含 src/index/*、src/hygiene/judge.js；IndexPort/JudgePort/EmbedderPort 接口与实现零改动。
- **全量测试**：458/458 pass（`node --test 'tests/**/*.test.js'`）。
