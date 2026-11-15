# v0.6.0 双审核处置（RESPONSE）

审核报告：`versions/v0.6/reviews/arch-v0.6.md`、`versions/v0.6/reviews/adversarial-v0.6.md`
探针：`versions/v0.6/reviews/probes/`（两路共 10 个脚本，全部实跑取证）

- 架构路线：阻断 **2** / 严重 2 / 建议 3
- 对抗路线：阻断 **3** / 严重 4
- 修复后：**469 tests 全绿**、eval **I1–I40 全 PASS**、质量 **11/11**、安全 **9/9**、覆盖率 functions 92.31%

## 阻断项（5 个，全部已修）

| # | 问题 | 修法 | 证据 |
|---|---|---|---|
| 1 | `memory_session_close` 的 `mainScopeFor` 不校验 session 型 parentScope；session-in-session 时 `main===svc`，刚晋升的 decision 被当场 tombstone | ① `startSession` 见绑定 session 库的 service 直接 `E_INVALID_ARG`（提示用主库 service）；② MCP/CLI 双端都拒 session 型 parentScope | `node reviews/probes/arch-probe2-session-in-session.js` → `E_INVALID_ARG` |
| 2 | `supersedeRecord` 绕过写侧契约：不传 policy、丢失旧 title、不跑 warnings | `createRecord(..., {clock, policy})`；新记录继承 `old.title`；跑 `recordWarnings` 并按结果打 `long-form` | `arch-probe1`（policy 限 500 时 supersede 3000 字被拒）、`arch-probe4`（title 保留） |
| 3 | 粒度硬上限只护 `text` 面：`value` 无上限（实测 5000 落盘）、checkpoint 落盘 120169 字 | 新增 `write.valueHardMaxChars`（默认 2000、只能调小）对 value 硬报错；`validateRecord` 读 policy；`normalizeCheckpoint` 每段 ≤2000、合计 ≤8000 | `node reviews/probes/adv-01-granularity-bypass.mjs`、`adv-07-checkpoint-and-mcp.mjs` |
| 4 | 伪造 session `meta` 记录可把晋升重定向到任意 scope（实测晋升进 `repo:evil-target`） | parentScope/status 真相源移到记忆流之外的 `$MEMO_HOME/sessions/<id>.json`；close/status 以文件为准；普通写 `subject=session,predicate=meta` 抛 `E_SESSION_META_PROTECTED`（lifecycle 走 `{internal:true}` 旁路） | `node reviews/probes/adv-03-session-attacks.mjs` → `E_SESSION_META_PROTECTED` |
| 5 | close 之后仍可写入 → 永不晋升的僵尸记录、`status` 陈旧 | 写入前读 `sessions/<id>.json` 状态，closed 抛 `E_SESSION_CLOSED`；`session status` 同样以文件为准 | 单测 `session-hardening.test.js`「closed 后写被拒」 |

## 严重项（已修 5 / 延期 1）

| 项 | 处置 |
|---|---|
| S-01 supersede 不跑 warnings、不打 long-form | 已修（阻断 2 同一处） |
| S-02 并发 close 的 `promoted` 计数失真 | 已修：以写入返回的 action 计，去重/重复都计入 `alreadyClosed` 分支 |
| S-03 零宽字符可入 title | 已修：`normalizeTitle` 先剔 `\u200B-\u200F\u202A-\u202E\u2060\uFEFF` |
| S-04 brief 未转义 `</memory-context>` | 已修：`renderBrief` 复用 `neutraliseFence` 逐行转义 |
| ③ checkpoint 不关旧版本（6 次 checkpoint = 6 条 active） | 已修：新增 checkpoint 后把上一个 active checkpoint supersede（`status='superseded'` + `validTo`） |
| ④ `validateRecord` 硬编码 4000 | 已修：改读 policy（上限可调小也可调大，天花板防误配） |

## 建议项（采纳 3 / 明确不做 3）

- 采纳：`session sweep` 输出加 `staleHours`；`status` 输出补 `parentScopeSource`（file/meta）；`docs/06` §17 补「撤销 close」的完整命令。
- 不做：给 meta 记录加签名（本地单机、威胁模型是「同机同用户」，文件旁路已足够）；session 库支持 `fact`（会变成第二个主库，与设计冲突）；自动 close（用户明确要手动）。

## 已知边界（写进 Known limits）

1. `titleEnforce` 默认 `false` —— 只警告不拒；v0.7 视使用情况再翻默认值。
2. 会话库完全手动：不自动建库、不自动压缩、不自动 close；`hintTokens` 只是提示。
3. 不做自动总结：checkpoint 由调用方（人/Agent）写入。
