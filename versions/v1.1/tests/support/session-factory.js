// tests/support/session-factory.js — 测试用 service 工厂（startSession 的依赖注入）
// 为什么不放在 src/session/lifecycle.js 里：那会让 session ← api/service 成环（W1 补的架构断言会红）。
import { createMemoryService } from '../../src/api/service.js';

/** startSession({ serviceFactory }) 的默认实现：按给定 scope 现开一个服务 */
export async function serviceFactory({ memoHome, scope, clock }) {
  return createMemoryService({ memoHome, scope, clock });
}
