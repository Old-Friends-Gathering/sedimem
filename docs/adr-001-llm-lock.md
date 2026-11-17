# ADR-001：llm 目录锁不复用 storage/lock.js

> doc-kind: history
> doc-version: 1.4

状态：接受（2026-11-17，P0b B1）

## 背景

P0b 要求把数据写锁统一到 `<memoHome>/.lock`，并给锁加心跳与 pid 存活判据。`src/llm/lock.js`
仍保留按文件名命名的锁（`llm/budget.lock`、`llm/cache.lock`），看起来像重复实现。

## 决定

llm 层继续使用自己的 `withPathLock(dir, name, fn)`，**不** import `storage/lock.js`。

## 理由

1. **门禁约束**：Q15 要求 llm 层不依赖 storage 实现（`src/llm/**` 不得 import `../storage/`），
   否则派生层可以绕过存储契约直接拿锁/写文件。
2. **锁的粒度不同**：数据锁是「整个 MEMO_HOME 一把锁」，llm 预算/缓存锁是「每个文件一把锁」，
   两个预算文件不应互相阻塞。
3. **故障隔离**：llm 的 outbox 可能长时间等外部 API；如果与真相层共用一把锁，会把写路径一起拖死。

## 后果

- 两套锁的 **语义** 必须保持一致：`mkdir` 原子排他、陈旧锁接管、`E_LOCK_TIMEOUT`。
  任何一侧改 stale/超时语义，都要同步另一侧并补测试。
- 数据锁的增强（心跳、owner pid、rename 接管）不自动作用于 llm 锁；llm 锁的持有时间由
  outbox 的批次上限控制，不长时间持锁。
- 如果未来 Q15 放宽，仍优先保持两个锁分离，而不是为了「少一个文件」合并。
