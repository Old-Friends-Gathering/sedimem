# ADR-002：hits 在 P0b 只观测，不迁移

> doc-kind: history
> doc-version: 1.4

## 状态

已接受（2026-11-17，P0b / v1.4.0）。

## 背景

`hits` 目前作为记录快照的一部分写进真相层（`search` 内存累加，`flushHits` 在 close/夜间落盘）。
它让「检索热度」可跨进程累计，但有两个已知问题：

1. **读路径写真相层**：一次检索会让 `items/<scope>.jsonl` 追加新快照，真相层膨胀与「读不改写」原则冲突。
2. **排序依赖调用历史**：如果 pack 按 hits 排序，同样输入在不同调用次数下输出不同，破坏 `I-6` 的确定性。

## 决定

P0b（v1.4.0）**不动 hits 的存储位置**，只做两件事：

- 保留并加测试：`close` 后 hits 已落盘、重开可读（见 `tests/unit/api.test.js` 的 hits 用例）。
- 在 pack/注入侧**禁止用 hits 排序**；pack 排序固定为 `(trustRank, kindRank, score, id)`，见 `docs/02` §5.3 与 P1 计划。

迁移到 `events.jsonl`（`kind:"hit"`）放到 P1：那时 pack/装配层才存在，才能一次改完排序、配额与 brief 的读取方，避免 P0b 同时改读路径和存储格式。

## 后果

- P0b 仍会有「读一次写一行」的膨胀；这是已知代价，不是回归。
- P1 迁移时必须提供：旧 hits 快照的只读兼容、events 聚合的幂等键、以及「同 asOf 两次 pack 逐字节相等」的测试。
- 在此之前，任何新代码不得把 hits 作为排序或过滤条件；code review 看到即拒。
