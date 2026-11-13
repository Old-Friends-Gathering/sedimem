// core/clock.js — 时间端口实现（契约：docs/02-data-model-and-contract.md §3）
// 所有时间是 ISO-8601 UTC（毫秒精度），避免时区漂移。

/**
 * 创建时钟。now 可为：
 *  - number：固定毫秒时间戳（测试用）
 *  - function：() => number（测试用）
 * 省略则用系统时间。
 */
export function createClock({ now } = {}) {
  const readMs =
    typeof now === 'function' ? now :
    typeof now === 'number' ? () => now :
    () => Date.now();
  return {
    nowMs() { return readMs(); },
    now() { return new Date(readMs()).toISOString(); },
  };
}

/** 生产用系统时钟 */
export const systemClock = createClock();
