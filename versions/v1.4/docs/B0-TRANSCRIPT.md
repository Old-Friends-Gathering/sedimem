# B0 · DSH 会话转录读取（真实数据实测）

> doc-kind: history · verified-at: 2026-11-15 · verified-against: 本机 DSH v4 会话

B0 修的是「DSH 真实会话一段都读不出来」：目录 slug 少两侧 `--`、多帧 zstd 只解首帧、
事件 schema 认不出 `user/message` / `assistant/message`。改动只在
`versions/v1.2/src/session/transcript.js`（零依赖，仍只 import `node:` 内置）。

## 实现要点

1. `cwdToSessionSlug(cwd)`：`[^A-Za-z0-9._-]+` → `-`，去掉首尾 `-`，返回 `--${core}--`；
   `$HOME/work-yeager/ldywoker` → `--Users-yeager-work-yeager-ldywoker--`。
2. `readDshTranscript()`：先按 slug 精确找；miss 时线性扫 `sessionsRoot`，目录名去掉所有
   非字母数字后以 cwd 同名后缀兜底；再 miss 抛 `E_TRANSCRIPT_UNAVAILABLE`。
3. 解压：按 magic `28 b5 2f fd` 切帧、逐帧 `zstdDecompressSync`，坏帧跳过计数，
   解压块 push 进数组后 `join`，不做字符串反复拼接（O(n)）。
4. `recordToTurn()`：新 schema 优先（`data.content[].text`；真实 assistant 用
   `data.message.content`），跳过 `turn/*`、`session`、`permission/*`、`sandbox/*`、
   `approval/*`、`model/*`、`agent/inbox/*`、`tool/*`；旧 `user_message` / `payload.role`
   形状最后兜底；`rec.time`（毫秒）→ ISO。`toTurns()` 过滤 null 后按 `seq` 升序。
5. 返回 `{turns, frames, badFrames, bytes, events}`（bytes=解压后 UTF-8 字节，events=事件条数）。

## 真实会话实测（本机，最大一个会话）

文件：`~/.dsh/sessions/--Users-yeager-work-yeager-ldywoker--/session-85533211-…/session.v4.jsonl.zstd`

| 压缩字节 | frames | badFrames | events | turns | 解压后字节 | 耗时 |
|---|---|---|---|---|---|---|
| 23,532,684 | 17,149 | 0 | 34,772 | 468 | 71,655,458 | 777 ms |
（文件是正在增长的活会话；另一 1.34MB 会话 358 帧 / 778 事件 / 27 turns / 103ms，结果一致。）

## 测试

```
node --test 'versions/v1.2/tests/unit/transcript-real.test.js'
```

6 条全绿：slug 断言、自造两帧 fixture（`tests/fixtures/transcript/`，frames=2、turns=4、
role 顺序 user/assistant/user/assistant、中文逐字比对）、宽松兜底、miss 错误码、旧 schema 兼容、
本机真实会话解析（CI 无 `~/.dsh/sessions` 时 `t.skip` 而非失败）。
