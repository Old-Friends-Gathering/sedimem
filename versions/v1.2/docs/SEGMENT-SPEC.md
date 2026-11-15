# 任务账本 · 段契约（v1.2 实施口径）

> 实现必须服从本文件；与 `docs/plans/v1.2-task-context-ledger.md` v2 冲突时以本文件为准（本文件是编码口径）。

## 1. 磁盘布局

```
$MEMO_HOME/sessions/<taskId>/segments.jsonl   # 只追加，一行一段
$MEMO_HOME/sessions/<taskId>/index.json       # 派生，可重建，含 {version,builtAt,segments:[...],coveredSeqs:[[from,to],...]}
$MEMO_HOME/sessions/<taskId>/meta.json        # 已有（session start 写入）
```

- 目录同名约定：`taskId` 形如 `20261114-2221-6a5b`；scope 为 `session:<taskId>`。
- 写入必须持 `<memoHome>/.lock`（复用 `src/storage/lock.js` 的 `withLock`）。

## 2. 段记录（一行）

```json
{
  "id": "seg_01J...",            // ULID，稳定
  "taskId": "20261114-2221-6a5b",
  "fromSeq": 120,                 // 闭区间下界
  "toSeq": 260,                   // 开区间上界（不含）
  "createdAt": "2026-11-15T01:20:00.000Z",
  "source": {"kind":"dsh","path":"/…/session.v4.jsonl.zstd","sessionId":"…","frames":17173},
  "anchor": {"path":"…/session.v4.jsonl.zstd","fromSeq":120,"toSeq":260},  // 必填，用于 expand
  "summary": "≤400 字：这一段在做什么、结论是什么",
  "facts": ["…"],                 // ≤12 条，每条 ≤200 字
  "decisions": ["…"],             // ≤8 条
  "gotchas": ["…"],               // ≤8 条
  "pendingJobs": ["…"],           // ≤8 条
  "files": ["src/x.js"],          // ≤20 条，仓库相对路径
  "nextSteps": ["…"],             // ≤5 条，动词开头
  "tokens": {"input": 12000, "output": 400},   // 估算，可为 null
  "trust": "T1",                  // 默认 T1；来自不可信源为 T2
  "taint": [],                    // 如 ["untrusted-source"]
  "quarantined": false,           // true 时 brief 不采用
  "mode": "rules"                 // "rules" | "llm"
}
```

**不变式**：`fromSeq < toSeq`；段区间两两不相交；`anchor` 必填且指向真实文件；`summary` 非空（规则模式也要有兜底摘要）；`quarantined:true` 的段 `briefJson` 必须排除。

## 3. 函数签名（`src/session/ledger.js`）

```js
export function segmentsFile(memoHome, taskId): string
export function readSegments({memoHome, taskId}): {segments, badLines}
export function appendSegment({memoHome, taskId, segment}): {segment, index}   // 锁内；区间重叠抛 E_ALREADY_CAPTURED
export function rebuildIndex({memoHome, taskId}): index                         // 从 segments.jsonl 重建，逐字节确定
export function readIndex({memoHome, taskId}): index | null
export function coveredSeqs({memoHome, taskId}): Array<[number, number]>
export function archiveTask({memoHome, taskId}): {movedTo}                       // 移到 archive/<taskId>-<ts>/
```

## 4. capture（`src/session/capture.js`）

```js
export function planSegments({turns, covered, maxTurnsPerSegment=120}): Array<{fromSeq,toSeq,turns}>
export function extractSegment({turns, fromSeq, toSeq, mode='rules', llmPort, policy}): segment  // 不含 id/taskId
export function captureTask({memoHome, taskId, cwd, mode='rules', llmPort, dryRun=false}): {created, skipped, segments}
```

- 规则抽取零 token：`files` 从文本里 `src/…`/`tests/…`/`docs/…` 路径匹配；`decisions` 抓「决定/改为/采用/不再」；`gotchas` 抓「坑/注意/踩了/原来/必须」；`pendingJobs` 抓「TODO/待/还没」；`nextSteps` 抓「下一步/接着/然后」。
- **summary 统一为「三段式一行」**：`诉求：<首条用户 turn 的一行话，≤120 字>；<N 轮对话 · M 次提问>；结论：<最后一条 assistant turn 的一行话，≤140 字>`，总长 ≤400 字、**不允许换行**。先做噪声过滤（运行时快照/时间采样/ACP 元数据/纯代码块 turn 不参与），再抽。
- **结论类字段只从 assistant 的发言里抽**：用户消息里的「决定」多是转述需求，进 `decisions` 只会污染。抽句时丢弃：长度 <12 或 >120、含 markdown 残留（`**`/`|`/`](`）、命令行开头（git/npm/memo/…）、目录树（`├└│`）、标题行（`#{1,6} `/`【`）、代码行。
- `mode:'llm'` 才调 `llmPort`（purpose `'capture'`），失败**回落到 rules**，且段上 `mode` 记 `rules` + `fallbackReason`。
- 写段前对 summary/facts/decisions/gotchas/pendingJobs 逐条过 `redactText` 与 `detectSuspicious`；命中可疑 → `quarantined:true` + `taint:['suspicious']`。

## 5. brief（`src/session/ledger-brief.js`）

```js
export function briefJson({memoHome, taskId, asOf, maxChars=4000, clock}): {
  task: {id, title, state},
  summary: string,
  decisions: [{text, segmentId, fromSeq}],
  gotchas: [...],
  references: [{file, segmentId}],
  nextSteps: [...],
  excluded: [{kind, reason, count}],
  budget: {maxChars, usedChars, truncated: boolean},
  segments: {total, used, quarantined},
  generatedAt: ISO
}
```
- **纯函数 + clock 注入**：同一 `asOf`/同一段集合 → 逐字节相同（排序键：`fromSeq` 升序，同序按 `segment.id`）。
- `asOf` 过滤：只取 `createdAt <= asOf` 的段。
- 不读 `items/*.jsonl`，不写任何文件。

## 6. expand（`src/session/expand.js`）

```js
export function expandSegment({memoHome, taskId, segmentId, toFile, sessionsRoot}): {text, chars, file?}
```
- 只允许本地 CLI 调用；MCP 不暴露。
- 按 `anchor.fromSeq/toSeq` 从转录里取 turn，拼成 `[seq] role: text` 行文本。

## 7. 错误码

`E_TRANSCRIPT_UNAVAILABLE`（转录缺失/无 zstd）、`E_SEGMENT_OVERLAP`（区间相交，捕获用 `E_ALREADY_CAPTURED`）、`E_NOT_FOUND`（任务/段不存在）、`E_INVALID_ARG`、`E_LEDGER_CORRUPT`（segments.jsonl 坏行）。
